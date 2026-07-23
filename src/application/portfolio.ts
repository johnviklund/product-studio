import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { stringify } from "yaml";
import { z } from "zod";

import { WorkItemController } from "./work-item-controller";
import {
  DuplicateWorkspaceError,
  INBOX_SOURCE_ID,
  INBOX_SOURCE_LABEL,
  InvalidWorkItemTransitionError,
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
  portfolioSourceIdSchema,
  registerWorkspaceInputSchema,
  registeredWorkspaceSchema,
  type PortfolioRebuildResult,
  type PortfolioWorkItem,
  type PortfolioWorkItemIndex,
  type RegisteredWorkspace,
} from "../domain/portfolio";
import {
  compileMission as compileMissionPackage,
  type MissionArtifactWriteResult,
  type MissionIdentity,
} from "../domain/mission";
import {
  createImportRunId,
  hashResultContent,
  type ImportEvidenceSummary,
  type StoredImportEvidence,
} from "../domain/result";
import {
  ControllerConflictError,
  InvalidWorkspaceError,
  WorkItemTargetCollisionError,
  WorkItemTransferFailedError,
  assignWorkItemInputSchema,
  createCaptureInputSchema,
  goalContractUpdateInputSchema,
  updateWorkItemDetailsInputSchema,
  updateWorkItemPhaseInputSchema,
  workItemIdSchema,
  type AssignWorkItemInput,
  type CreateCaptureInput,
  type ControllerRunManifest,
  type GoalContractUpdateInput,
  type UpdateWorkItemDetailsInput,
  type UpdateWorkItemPhaseInput,
  type WorkItem,
  type WorkItemGoal,
} from "../domain/work-item";
import { validatePhaseTransition } from "../domain/workflow-policy";
import { ProductWorkspace } from "../workspace/product-workspace";
import { PortfolioRegistry } from "../workspace/portfolio-registry";

type WorkspaceGateway = Pick<
  ProductWorkspace,
  | "workspaceRoot"
  | "readManifest"
  | "create"
  | "list"
  | "read"
  | "createCapture"
  | "updateGoal"
  | "updatePhase"
  | "hasWorkItem"
  | "stageIncomingWorkItem"
  | "publishStagedWorkItem"
  | "discardStagedWorkItem"
  | "removeWorkItem"
  | "acquireControllerLease"
  | "readControllerRunManifest"
  | "findAppliedExecuteManifest"
  | "writeMissionPackage"
  | "readMissionResult"
  | "readImportEvidence"
  | "listImportEvidence"
  | "writeImportEvidence"
  | "gitVerificationAdapter"
  | "verificationRunner"
  | "commitControllerMutation"
  | "releaseControllerLease"
>;
type WorkspaceFactory = (workspacePath: string) => WorkspaceGateway;

interface ResolvedSource {
  source_id: string;
  project: RegisteredWorkspace | null;
  workspace: WorkspaceGateway;
}

const TRANSFER_STAGES = ["staged", "published", "source_removed"] as const;
const TRANSFER_TEMP_FILE_PATTERN =
  /^\.tr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

interface TransferJournalRecord {
  schema_version: 1;
  transfer_id: string;
  work_item_id: string;
  from_source_id: string;
  from_path: string;
  to_source_id: string;
  to_path: string;
  stage: (typeof TRANSFER_STAGES)[number];
}

const transferJournalRecordSchema: z.ZodType<TransferJournalRecord> = z
  .strictObject({
    schema_version: z.literal(1),
    transfer_id: z
      .string()
      .regex(
        /^tr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "transfer_id must use the tr_<uuid> format",
      ),
    work_item_id: workItemIdSchema,
    from_source_id: portfolioSourceIdSchema,
    from_path: z.string().refine(isAbsolute, "from_path must be absolute"),
    to_source_id: portfolioSourceIdSchema,
    to_path: z.string().refine(isAbsolute, "to_path must be absolute"),
    stage: z.enum(TRANSFER_STAGES),
  })
  .refine(
    (record) => record.from_source_id !== record.to_source_id,
    "transfer sources must differ",
  );

export interface RegisterWorkspaceResult {
  workspace: RegisteredWorkspace;
  rebuild: PortfolioRebuildResult;
}

export type MissionCompilation = MissionArtifactWriteResult;

export interface PortfolioImportResult extends PortfolioWorkItem {
  evidence: ImportEvidenceSummary;
}

export interface PortfolioRetryResult extends PortfolioWorkItem {
  controller_run: ControllerRunManifest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationReason(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) =>
      path.length > 0 ? `${path.map(String).join(".")}: ${message}` : message,
    )
    .join("; ");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isExpectedWorkspaceFailure(error: unknown): boolean {
  if (error instanceof InvalidWorkspaceError) {
    return true;
  }

  if (!isNodeError(error)) {
    return false;
  }

  return ["EACCES", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code ?? "");
}

export class PortfolioService {
  constructor(
    private readonly registry: PortfolioRegistry,
    private readonly index: PortfolioWorkItemIndex,
    inboxRoot: string,
    private readonly makeWorkspace: WorkspaceFactory = (workspacePath) =>
      new ProductWorkspace(workspacePath),
  ) {
    this.inboxRoot = resolve(inboxRoot);
    this.transfersRoot = join(dirname(this.inboxRoot), "transfers");
  }

  readonly inboxRoot: string;
  readonly transfersRoot: string;

  listWorkspaces(): Promise<RegisteredWorkspace[]> {
    return this.registry.read();
  }

  async register(input: unknown): Promise<RegisterWorkspaceResult> {
    const validatedInput = registerWorkspaceInputSchema.parse(input);
    const workspacePath = resolve(validatedInput.workspace_path);
    const registered = await this.registry.read();

    if (
      registered.some(
        (workspace) => workspace.workspace_path === workspacePath,
      )
    ) {
      throw new DuplicateWorkspaceError(workspacePath);
    }

    const manifest = await this.makeWorkspace(workspacePath).readManifest();
    const workspace = registeredWorkspaceSchema.parse({
      workspace_id: `ws_${randomUUID()}`,
      workspace_path: workspacePath,
      product_name: manifest.product_name,
      registered_at: new Date().toISOString(),
    });

    await this.registry.append(workspace);

    try {
      return { workspace, rebuild: await this.rebuild() };
    } catch (error) {
      throw new Error(
        "Workspace was registered, but the portfolio index rebuild failed and may be stale. Run a rebuild to recover.",
        { cause: error },
      );
    }
  }

  async list(): Promise<PortfolioWorkItem[]> {
    return this.index.list();
  }

  async createCapture(input: CreateCaptureInput): Promise<PortfolioWorkItem> {
    const validatedInput = createCaptureInputSchema.parse(input);
    const source = await this.resolveSource(
      validatedInput.source_id ?? INBOX_SOURCE_ID,
    );
    const created = await source.workspace.createCapture(validatedInput);

    await this.rebuild();
    return this.toPortfolioItem(source, created);
  }

  async updateWorkItemDetails(
    sourceId: string,
    workItemId: string,
    input: UpdateWorkItemDetailsInput,
  ): Promise<PortfolioWorkItem> {
    const validatedInput = updateWorkItemDetailsInputSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const current = await source.workspace.read(workItemId);
    if (current === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    if (current.goal.goal_version !== undefined) {
      throw new ControllerConflictError(
        "contracted_details",
        workItemId,
        "Contracted work items require a version-bound goal update.",
      );
    }

    const nextGoal: WorkItemGoal = { ...current.goal };
    if (validatedInput.title !== undefined) {
      nextGoal.title = validatedInput.title;
    }
    if (validatedInput.type !== undefined) {
      if (validatedInput.type === null) {
        delete nextGoal.type;
      } else {
        nextGoal.type = validatedInput.type;
      }
    }
    if (validatedInput.priority !== undefined) {
      if (validatedInput.priority === null) {
        delete nextGoal.priority;
      } else {
        nextGoal.priority = validatedInput.priority;
      }
    }
    if (validatedInput.tags !== undefined) {
      if (validatedInput.tags.length === 0) {
        delete nextGoal.tags;
      } else {
        nextGoal.tags = validatedInput.tags;
      }
    }
    if (validatedInput.notes !== undefined) {
      if (validatedInput.notes === null) {
        delete nextGoal.notes;
      } else {
        nextGoal.notes = validatedInput.notes;
      }
    }

    const updated = await source.workspace.updateGoal(workItemId, nextGoal);
    if (updated === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }

    await this.rebuild();
    return this.toPortfolioItem(source, updated);
  }

  async updateGoalContract(
    sourceId: string,
    workItemId: string,
    input: GoalContractUpdateInput,
  ): Promise<PortfolioWorkItem> {
    const validatedInput = goalContractUpdateInputSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const current = await source.workspace.read(workItemId);
    if (current === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }

    const result = await this.workItemController(
      source.workspace,
    ).updateGoalContract(workItemId, validatedInput);
    await this.rebuild();
    return this.toPortfolioItem(source, result.work_item);
  }

  async assignWorkItem(
    sourceId: string,
    workItemId: string,
    input: AssignWorkItemInput,
  ): Promise<PortfolioWorkItem> {
    const validatedInput = assignWorkItemInputSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const target = await this.resolveSource(validatedInput.target_source_id);
    const current = await source.workspace.read(workItemId);

    if (current === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    if (source.source_id === target.source_id) {
      return this.toPortfolioItem(source, current);
    }
    if (await target.workspace.hasWorkItem(workItemId)) {
      throw new WorkItemTargetCollisionError(
        source.source_id,
        workItemId,
        target.source_id,
      );
    }

    const transferId = `tr_${randomUUID()}`;
    let record: TransferJournalRecord | null = null;

    try {
      const stagingPath = await target.workspace.stageIncomingWorkItem(current);
      record = transferJournalRecordSchema.parse({
        schema_version: 1,
        transfer_id: transferId,
        work_item_id: workItemId,
        from_source_id: source.source_id,
        from_path: source.workspace.workspaceRoot,
        to_source_id: target.source_id,
        to_path: stagingPath,
        stage: "staged",
      });
      await this.writeTransferJournal(record);

      await target.workspace.publishStagedWorkItem(workItemId, stagingPath);
      record = { ...record, stage: "published" };
      await this.writeTransferJournal(record);

      await source.workspace.removeWorkItem(workItemId);
      record = { ...record, stage: "source_removed" };
      await this.writeTransferJournal(record);
      await this.deleteTransferJournal(record.transfer_id);

      await this.rebuild();
      return this.toPortfolioItem(target, current);
    } catch (error) {
      let cleanupError: unknown;
      if (record?.stage === "staged") {
        try {
          const targetItem = await target.workspace.read(workItemId);
          if (targetItem === null) {
            await target.workspace.discardStagedWorkItem(
              workItemId,
              record.to_path,
            );
            await this.deleteTransferJournal(record.transfer_id);
          } else if (!isDeepStrictEqual(targetItem, current)) {
            await target.workspace.discardStagedWorkItem(
              workItemId,
              record.to_path,
            );
            await this.deleteTransferJournal(record.transfer_id);
          }
        } catch (candidateCleanupError) {
          cleanupError = candidateCleanupError;
        }
      }

      if (
        cleanupError === undefined &&
        error instanceof InvalidWorkspaceError &&
        error.reason === "target work-item already exists"
      ) {
        throw new WorkItemTargetCollisionError(
          source.source_id,
          workItemId,
          target.source_id,
        );
      }
      if (
        error instanceof WorkItemTargetCollisionError ||
        error instanceof WorkItemTransferFailedError
      ) {
        throw error;
      }

      const reason =
        cleanupError === undefined
          ? errorMessage(error)
          : `${errorMessage(error)}; cleanup also failed: ${errorMessage(cleanupError)}`;
      throw new WorkItemTransferFailedError(
        source.source_id,
        workItemId,
        target.source_id,
        reason,
      );
    }
  }

  async updateWorkItemPhase(
    sourceId: string,
    workItemId: string,
    input: UpdateWorkItemPhaseInput,
  ): Promise<PortfolioWorkItem> {
    const validatedInput = updateWorkItemPhaseInputSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const current = await source.workspace.read(workItemId);

    if (current === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }

    const transition = validatePhaseTransition(
      current.state.phase,
      validatedInput.target_phase,
    );
    if (!transition.ok) {
      throw new InvalidWorkItemTransitionError(
        current.state.phase,
        validatedInput.target_phase,
        transition.reason,
      );
    }

    const updated = await source.workspace.updatePhase(
      workItemId,
      validatedInput,
    );
    if (updated === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }

    await this.rebuild();

    return {
      source_id: source.source_id,
      project: source.project,
      work_item: updated,
    };
  }

  async compileMission(
    sourceId: string,
    workItemId: string,
  ): Promise<MissionCompilation> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.goal.goal_version === undefined ||
      workItem.goal.acceptance_criteria === undefined ||
      workItem.goal.allowed_scope === undefined ||
      workItem.goal.review_ready === undefined ||
      workItem.state.phase !== "execute" ||
      workItem.state.status !== "active" ||
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.state.attempt === undefined
    ) {
      throw this.missionNotReady(
        workItemId,
        "Mission compilation requires an assigned, governed item in active execute.",
      );
    }

    const identity: MissionIdentity = {
      work_item_id: workItemId,
      goal_version: workItem.state.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
    };
    const executeManifest =
      await source.workspace.findAppliedExecuteManifest(identity);
    if (executeManifest === null) {
      throw this.missionNotReady(
        workItemId,
        "No applied execute manifest matches the governed tuple.",
      );
    }

    return source.workspace.writeMissionPackage(identity, (paths) =>
      compileMissionPackage(workItem, executeManifest, paths),
    );
  }

  async listImportEvidence(
    sourceId: string,
    workItemId: string,
  ): Promise<StoredImportEvidence[]> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    return source.workspace.listImportEvidence(workItemId);
  }

  async importResult(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioImportResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedExecuteIdentity(source, workItem);
    const isActiveExecute =
      workItem.state.phase === "execute" && workItem.state.status === "active";
    if (!isActiveExecute) {
      const isImportOutcomeState =
        (workItem.state.phase === "review" &&
          workItem.state.status === "active") ||
        (workItem.state.phase === "execute" &&
          workItem.state.status === "blocked");
      if (!isImportOutcomeState) {
        throw this.missionNotReady(
          workItemId,
          "Result import requires an assigned, governed item in active execute.",
        );
      }
      const snapshot = await source.workspace.readMissionResult(identity);
      const resultContentSha256 = hashResultContent(snapshot.result_source);
      const importRunId = createImportRunId(
        snapshot.mission.content_sha256,
        resultContentSha256,
      );
      if (
        (await source.workspace.readImportEvidence(identity, importRunId)) ===
        null
      ) {
        throw this.missionNotReady(
          workItemId,
          "A blocked or review item only accepts an identical import replay.",
        );
      }
    }

    const controller = this.workItemController(source.workspace);
    const imported = await controller.importExternalResult(workItemId, {
      expected_phase: "execute",
      expected_status: "active",
      expected_schema_version: 1,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: imported.work_item,
      evidence: imported.evidence,
    };
  }

  async retryExecuteAttempt(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioRetryResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedExecuteIdentity(source, workItem);
    if (
      workItem.state.phase !== "execute" ||
      workItem.state.status !== "blocked"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Repair requires an assigned, governed item in blocked execute.",
      );
    }
    const controller = this.workItemController(source.workspace);
    const retried = await controller.retryExecuteAttempt(workItemId, {
      expected_phase: "execute",
      expected_status: "blocked",
      expected_schema_version: 1,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: retried.work_item,
      controller_run: retried.manifest,
    };
  }

  async recoverPendingTransfers(): Promise<void> {
    const records = await this.readTransferJournals();
    for (const record of records) {
      await this.recoverTransfer(record);
    }
  }

  async rebuild(): Promise<PortfolioRebuildResult> {
    await this.recoverPendingTransfers();
    const workspaces = await this.registry.read();
    const items: PortfolioWorkItem[] = [];
    const failures: PortfolioRebuildResult["failures"] = [];

    try {
      const inbox = await this.ensureInboxWorkspace();
      const inboxItems = await inbox.list();
      items.push(
        ...inboxItems.map((work_item) => ({
          source_id: INBOX_SOURCE_ID,
          project: null,
          work_item,
        })),
      );
    } catch (error) {
      if (!isExpectedWorkspaceFailure(error)) {
        throw error;
      }
      failures.push({
        source_id: INBOX_SOURCE_ID,
        project: null,
        reason: errorMessage(error),
      });
    }

    for (const workspace of workspaces) {
      try {
        const reader = this.makeWorkspace(workspace.workspace_path);
        await reader.readManifest();
        const workspaceItems = await reader.list();
        items.push(
          ...workspaceItems.map((work_item) => ({
            source_id: workspace.workspace_id,
            project: workspace,
            work_item,
          })),
        );
      } catch (error) {
        if (!isExpectedWorkspaceFailure(error)) {
          throw error;
        }
        failures.push({
          source_id: workspace.workspace_id,
          project: workspace,
          reason: errorMessage(error),
        });
      }
    }

    this.index.rebuild(items);

    return { items: this.index.list(), failures };
  }

  private toPortfolioItem(
    source: ResolvedSource,
    workItem: WorkItem,
  ): PortfolioWorkItem {
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: workItem,
    };
  }

  private governedExecuteIdentity(
    source: ResolvedSource,
    workItem: WorkItem,
  ): MissionIdentity {
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.goal.goal_version === undefined ||
      workItem.goal.acceptance_criteria === undefined ||
      workItem.goal.allowed_scope === undefined ||
      workItem.goal.review_ready === undefined ||
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.state.attempt === undefined
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "External result operations require an assigned, governed item.",
      );
    }
    return {
      work_item_id: workItem.goal.work_item_id,
      goal_version: workItem.state.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
    };
  }

  private workItemController(workspace: WorkspaceGateway): WorkItemController {
    return new WorkItemController(
      workspace,
      () => new Date(),
      workspace.gitVerificationAdapter(),
      workspace.verificationRunner(),
    );
  }

  private missionNotReady(
    workItemId: string,
    reason: string,
  ): ControllerConflictError {
    return new ControllerConflictError(
      "mission_not_ready",
      workItemId,
      reason,
    );
  }

  private async recoverTransfer(record: TransferJournalRecord): Promise<void> {
    const source = await this.resolveSource(record.from_source_id);
    const target = await this.resolveSource(record.to_source_id);
    if (source.workspace.workspaceRoot !== resolve(record.from_path)) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        "journal source path no longer matches the registered source",
      );
    }

    const sourceItem = await source.workspace.read(record.work_item_id);
    const targetItem = await target.workspace.read(record.work_item_id);

    if (record.stage === "staged" && targetItem === null) {
      if (sourceItem === null) {
        throw new WorkItemTransferFailedError(
          record.from_source_id,
          record.work_item_id,
          record.to_source_id,
          "staged transfer has neither a source item nor a published target",
        );
      }
      await target.workspace.discardStagedWorkItem(
        record.work_item_id,
        record.to_path,
      );
      await this.deleteTransferJournal(record.transfer_id);
      return;
    }

    if (targetItem === null) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        `${record.stage} transfer is missing its published target`,
      );
    }
    if (sourceItem !== null && !isDeepStrictEqual(sourceItem, targetItem)) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        "source and published target content differ",
      );
    }

    if (sourceItem !== null) {
      await source.workspace.removeWorkItem(record.work_item_id);
    }
    const completedRecord: TransferJournalRecord = {
      ...record,
      stage: "source_removed",
    };
    await this.writeTransferJournal(completedRecord);
    await this.deleteTransferJournal(record.transfer_id);
  }

  private async readTransferJournals(): Promise<TransferJournalRecord[]> {
    await this.ensureTransfersDirectory();
    const entries = await readdir(this.transfersRoot, { withFileTypes: true });
    const records: TransferJournalRecord[] = [];

    for (const entry of entries) {
      if (TRANSFER_TEMP_FILE_PATTERN.test(entry.name)) {
        if (!entry.isFile()) {
          throw new InvalidWorkspaceError(
            `.portfolio/transfers/${entry.name}`,
            "transfer journal temporary entry must be a regular file",
          );
        }
        continue;
      }
      const artifactPath = `.portfolio/transfers/${entry.name}`;
      if (!entry.isFile()) {
        throw new InvalidWorkspaceError(
          artifactPath,
          "transfer journal entry must be a regular file",
        );
      }

      const journalPath = join(this.transfersRoot, entry.name);
      const stats = await lstat(journalPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new InvalidWorkspaceError(
          artifactPath,
          "transfer journal must be a regular file, not a symlink",
        );
      }

      let value: unknown;
      try {
        value = JSON.parse(await readFile(journalPath, "utf8"));
      } catch (error) {
        throw new InvalidWorkspaceError(
          artifactPath,
          `invalid JSON: ${errorMessage(error)}`,
        );
      }
      const result = transferJournalRecordSchema.safeParse(value);
      if (!result.success) {
        throw new InvalidWorkspaceError(
          artifactPath,
          validationReason(result.error),
        );
      }
      if (entry.name !== `${result.data.transfer_id}.json`) {
        throw new InvalidWorkspaceError(
          artifactPath,
          "journal filename must match transfer_id",
        );
      }
      records.push(result.data);
    }

    return records.sort((left, right) =>
      left.transfer_id.localeCompare(right.transfer_id),
    );
  }

  private async writeTransferJournal(
    record: TransferJournalRecord,
  ): Promise<void> {
    const validatedRecord = transferJournalRecordSchema.parse(record);
    await this.ensureTransfersDirectory();
    const journalPath = join(
      this.transfersRoot,
      `${validatedRecord.transfer_id}.json`,
    );
    const temporaryPath = join(
      this.transfersRoot,
      `.${validatedRecord.transfer_id}.json.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validatedRecord, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryPath, journalPath);
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  private async deleteTransferJournal(transferId: string): Promise<void> {
    try {
      await unlink(join(this.transfersRoot, `${transferId}.json`));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async ensureTransfersDirectory(): Promise<void> {
    const portfolioRoot = dirname(this.inboxRoot);
    await this.ensureSafeDirectory(portfolioRoot, ".portfolio");
    await this.ensureSafeDirectory(
      this.transfersRoot,
      ".portfolio/transfers",
    );
  }

  private async resolveSource(sourceId: string): Promise<ResolvedSource> {
    if (sourceId === INBOX_SOURCE_ID) {
      return {
        source_id: INBOX_SOURCE_ID,
        project: null,
        workspace: await this.ensureInboxWorkspace(),
      };
    }

    const project = (await this.registry.read()).find(
      (workspace) => workspace.workspace_id === sourceId,
    );
    if (!project) {
      throw new UnknownPortfolioSourceError(sourceId);
    }

    return {
      source_id: project.workspace_id,
      project,
      workspace: this.makeWorkspace(project.workspace_path),
    };
  }

  private async ensureInboxWorkspace(): Promise<WorkspaceGateway> {
    const portfolioRoot = dirname(this.inboxRoot);
    const founderDirectory = join(this.inboxRoot, ".founder");
    const manifestPath = join(founderDirectory, "product.yaml");

    await this.ensureSafeDirectory(portfolioRoot, ".portfolio");
    await this.ensureSafeDirectory(this.inboxRoot, ".");
    await this.ensureSafeDirectory(founderDirectory, ".founder");

    let manifestExists = false;
    try {
      const stats = await lstat(manifestPath);
      manifestExists = true;
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new InvalidWorkspaceError(
          ".founder/product.yaml",
          "path must be a regular file, not a symlink",
        );
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    if (!manifestExists) {
      await this.createInboxManifest(manifestPath);
    }

    const workspace = this.makeWorkspace(this.inboxRoot);
    const manifest = await workspace.readManifest();
    if (manifest.product_name !== INBOX_SOURCE_LABEL) {
      throw new InvalidWorkspaceError(
        ".founder/product.yaml",
        `product_name must be ${INBOX_SOURCE_LABEL}`,
      );
    }

    return workspace;
  }

  private async ensureSafeDirectory(
    directoryPath: string,
    artifactPath: string,
  ): Promise<void> {
    try {
      await mkdir(directoryPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    const stats = await lstat(directoryPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new InvalidWorkspaceError(
        artifactPath,
        "path must be a directory, not a symlink",
      );
    }
  }

  private async createInboxManifest(manifestPath: string): Promise<void> {
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;

    try {
      await writeFile(
        temporaryPath,
        stringify({
          schema_version: 2,
          product_name: INBOX_SOURCE_LABEL,
          verification: {
            required_commands: [
              {
                name: "Lint",
                argv: ["npm", "run", "lint"],
                timeout_seconds: 300,
              },
              {
                name: "Typecheck",
                argv: ["npm", "run", "typecheck"],
                timeout_seconds: 300,
              },
              {
                name: "Test",
                argv: ["npm", "test"],
                timeout_seconds: 900,
              },
              {
                name: "Build",
                argv: ["npm", "run", "build"],
                timeout_seconds: 900,
              },
            ],
          },
        }),
        { encoding: "utf8", flag: "wx" },
      );
      try {
        await link(temporaryPath, manifestPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}
