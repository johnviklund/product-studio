import { createHash, randomUUID } from "node:crypto";
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

import { stringify } from "yaml";
import { z } from "zod";

import {
  deriveControllerIdempotencyKey,
  WorkItemController,
} from "./work-item-controller";
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
  controllerRunIdSchema,
  controllerRunManifestSchema,
  createCaptureInputSchema,
  saveWorkItemInputSchema,
  updateWorkItemPhaseInputSchema,
  workItemIdSchema,
  workItemSchema,
  type CreateCaptureInput,
  type ControllerRunManifest,
  type SaveWorkItemInput,
  type UpdateWorkItemPhaseInput,
  type WorkItem,
  type WorkItemGoal,
} from "../domain/work-item";
import {
  canUpdateGoalContract,
  validatePhaseTransition,
} from "../domain/workflow-policy";
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
  | "readAppliedExecuteReviewSubject"
  | "writeReviewMissionPackage"
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

interface TransferJournalRecordBase {
  schema_version: 1;
  transfer_id: string;
  work_item_id: string;
  from_source_id: string;
  from_path: string;
  to_source_id: string;
  to_path: string;
  stage: (typeof TRANSFER_STAGES)[number];
}

interface MoveTransferJournalRecord extends TransferJournalRecordBase {
  kind: "move";
}

interface SaveTransferJournalRecord extends TransferJournalRecordBase {
  kind: "save";
  target_sha256: string;
  staged_manifest_run_id?: string;
}

type TransferJournalRecord =
  | MoveTransferJournalRecord
  | SaveTransferJournalRecord;

const transferJournalBaseShape = {
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
};

const transferJournalRecordSchema: z.ZodType<TransferJournalRecord> = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...transferJournalBaseShape,
      kind: z.literal("move"),
    }),
    z.strictObject({
      ...transferJournalBaseShape,
      kind: z.literal("save"),
      target_sha256: z.string().regex(/^[0-9a-f]{64}$/i),
      staged_manifest_run_id: controllerRunIdSchema.optional(),
    }),
  ])
  .refine(
    (record) => record.from_source_id !== record.to_source_id,
    "transfer sources must differ",
  );

function fingerprintWorkItem(item: WorkItem): string {
  return createHash("sha256").update(JSON.stringify(item)).digest("hex");
}

function nextTimestamp(currentTimestamp: string): string {
  return new Date(
    Math.max(Date.now(), Date.parse(currentTimestamp) + 1),
  ).toISOString();
}

function manifestMatchesWorkItem(
  manifest: ControllerRunManifest,
  item: WorkItem,
): boolean {
  const contract = item.goal.goal_contract;
  const inputRevision = item.state.input_revision;
  const attempt = item.state.attempt;
  return (
    contract !== undefined &&
    inputRevision !== undefined &&
    attempt !== undefined &&
    manifest.outcome === "applied" &&
    manifest.completed_at !== undefined &&
    manifest.work_item_id === item.goal.work_item_id &&
    manifest.phase === item.state.phase &&
    manifest.goal_version === contract.goal_version &&
    manifest.input_revision === inputRevision &&
    manifest.attempt === attempt &&
    manifest.idempotency_key ===
      deriveControllerIdempotencyKey(
        item.goal.work_item_id,
        item.state.phase,
        contract.goal_version,
        inputRevision,
        attempt,
      )
  );
}

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

  async saveWorkItem(
    sourceId: string,
    workItemId: string,
    input: SaveWorkItemInput,
  ): Promise<PortfolioWorkItem> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = saveWorkItemInputSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const target =
      validatedInput.target_source_id === source.source_id
        ? source
        : await this.resolveSource(validatedInput.target_source_id);
    const current = await source.workspace.read(validatedId);
    if (current === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, validatedId);
    }

    if (target.source_id === source.source_id) {
      if (validatedInput.goal_contract !== undefined) {
        const result = await this.workItemController(
          source.workspace,
        ).saveWorkItem(validatedId, validatedInput);
        await this.rebuild();
        return this.toPortfolioItem(source, result.work_item);
      }
      if (current.goal.goal_contract !== undefined) {
        throw new ControllerConflictError(
          "contract_required",
          validatedId,
          "A unified save cannot remove an existing goal contract.",
        );
      }

      const nextItem = this.buildUncontractedSave(current, validatedInput);
      const updated = await source.workspace.updateGoal(
        validatedId,
        nextItem.goal,
      );
      if (updated === null) {
        throw new PortfolioWorkItemNotFoundError(sourceId, validatedId);
      }
      await this.rebuild();
      return this.toPortfolioItem(source, updated);
    }

    if (current.goal.goal_contract !== undefined) {
      throw new ControllerConflictError(
        "project_locked",
        validatedId,
        "A contracted work item cannot change projects.",
      );
    }
    if (
      validatedInput.expected_goal_version !== undefined ||
      validatedInput.expected_input_revision !== undefined
    ) {
      throw new ControllerConflictError(
        "stale_expectation",
        validatedId,
        "First contract activation requires absent expected versions.",
      );
    }
    if (
      validatedInput.goal_contract !== undefined &&
      !canUpdateGoalContract(current.state.phase)
    ) {
      throw new ControllerConflictError(
        "goal_contract_locked",
        validatedId,
        `Goal contracts are locked after entering ${current.state.phase}.`,
      );
    }

    const saved = this.buildCrossSourceSave(current, validatedInput);
    return this.transferWorkItem(source, target, saved.work_item, {
      kind: "save",
      manifest: saved.manifest,
    });
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
      workItem.goal.goal_contract === undefined ||
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

    const identity: MissionIdentity<"execute"> = {
      phase: "execute",
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

  private buildSavedGoal(
    current: WorkItem,
    input: SaveWorkItemInput,
    goalContract?: WorkItemGoal["goal_contract"],
  ): WorkItemGoal {
    return {
      schema_version: 2,
      work_item_id: current.goal.work_item_id,
      title: input.title,
      ...(input.type === null ? {} : { type: input.type }),
      ...(current.goal.capture === undefined
        ? {}
        : { capture: current.goal.capture }),
      ...(input.priority === null ? {} : { priority: input.priority }),
      ...(input.tags.length === 0 ? {} : { tags: input.tags }),
      ...(input.notes === null ? {} : { notes: input.notes }),
      ...(goalContract === undefined ? {} : { goal_contract: goalContract }),
    };
  }

  private buildUncontractedSave(
    current: WorkItem,
    input: SaveWorkItemInput,
  ): WorkItem {
    return workItemSchema.parse({
      goal: this.buildSavedGoal(current, input),
      state: current.state,
    });
  }

  private buildCrossSourceSave(
    current: WorkItem,
    input: SaveWorkItemInput,
  ): { work_item: WorkItem; manifest?: ControllerRunManifest } {
    const contractInput = input.goal_contract;
    if (contractInput === undefined) {
      return { work_item: this.buildUncontractedSave(current, input) };
    }

    const completedAt = nextTimestamp(current.state.updated_at);
    const runId = randomUUID();
    const idempotencyKey = deriveControllerIdempotencyKey(
      current.goal.work_item_id,
      current.state.phase,
      1,
      1,
      0,
    );
    const workItem = workItemSchema.parse({
      goal: this.buildSavedGoal(current, input, {
        schema_version: 1,
        goal_version: 1,
        purpose: contractInput.purpose,
        acceptance_criteria: contractInput.acceptance_criteria,
        non_goals: contractInput.non_goals,
        allowed_scope: contractInput.allowed_scope,
        review_ready: contractInput.review_ready,
      }),
      state: {
        ...current.state,
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        updated_at: completedAt,
      },
    });
    const manifest = controllerRunManifestSchema.parse({
      schema_version: 1,
      run_id: runId,
      work_item_id: current.goal.work_item_id,
      idempotency_key: idempotencyKey,
      phase: current.state.phase,
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      started_at: completedAt,
      completed_at: completedAt,
      outcome: "applied",
    });

    return { work_item: workItem, manifest };
  }

  private async transferWorkItem(
    source: ResolvedSource,
    target: ResolvedSource,
    targetItem: WorkItem,
    operation:
      | { kind: "move" }
      | { kind: "save"; manifest?: ControllerRunManifest },
  ): Promise<PortfolioWorkItem> {
    const workItemId = targetItem.goal.work_item_id;
    if (await target.workspace.hasWorkItem(workItemId)) {
      throw new WorkItemTargetCollisionError(
        source.source_id,
        workItemId,
        target.source_id,
      );
    }

    const transferId = `tr_${randomUUID()}`;
    const targetSha256 = fingerprintWorkItem(targetItem);
    let stagingPath: string | null = null;
    let record: TransferJournalRecord | null = null;

    try {
      stagingPath = await target.workspace.stageIncomingWorkItem(
        targetItem,
        operation.kind === "save" ? operation.manifest : undefined,
      );
      record = transferJournalRecordSchema.parse(
        operation.kind === "move"
          ? {
              schema_version: 1,
              kind: "move",
              transfer_id: transferId,
              work_item_id: workItemId,
              from_source_id: source.source_id,
              from_path: source.workspace.workspaceRoot,
              to_source_id: target.source_id,
              to_path: stagingPath,
              stage: "staged",
            }
          : {
              schema_version: 1,
              kind: "save",
              transfer_id: transferId,
              work_item_id: workItemId,
              from_source_id: source.source_id,
              from_path: source.workspace.workspaceRoot,
              to_source_id: target.source_id,
              to_path: stagingPath,
              stage: "staged",
              target_sha256: targetSha256,
              ...(operation.manifest === undefined
                ? {}
                : { staged_manifest_run_id: operation.manifest.run_id }),
            },
      );
      await this.writeTransferJournal(record);

      await target.workspace.publishStagedWorkItem(workItemId, stagingPath);
      const published = await target.workspace.read(workItemId);
      if (published === null) {
        throw new WorkItemTransferFailedError(
          source.source_id,
          workItemId,
          target.source_id,
          "published target could not be read",
        );
      }
      await this.validatePublishedTransferTarget(
        record,
        target,
        published,
        targetItem,
      );
      record = { ...record, stage: "published" };
      await this.writeTransferJournal(record);

      await source.workspace.removeWorkItem(workItemId);
      if ((await source.workspace.read(workItemId)) !== null) {
        throw new WorkItemTransferFailedError(
          source.source_id,
          workItemId,
          target.source_id,
          "source work item still exists after removal",
        );
      }
      record = { ...record, stage: "source_removed" };
      await this.writeTransferJournal(record);
      await this.deleteTransferJournal(record.transfer_id);

      await this.rebuild();
      return this.toPortfolioItem(target, published);
    } catch (error) {
      let cleanupError: unknown;
      const targetCollision =
        error instanceof InvalidWorkspaceError &&
        error.reason === "target work-item already exists";
      try {
        const durableTarget = await target.workspace.read(workItemId);
        if (
          targetCollision ||
          durableTarget === null ||
          fingerprintWorkItem(durableTarget) !== targetSha256
        ) {
          if (stagingPath !== null) {
            await target.workspace.discardStagedWorkItem(
              workItemId,
              stagingPath,
            );
          }
          if (record !== null) {
            await this.deleteTransferJournal(record.transfer_id);
          }
        }
      } catch (candidateCleanupError) {
        cleanupError = candidateCleanupError;
      }

      if (cleanupError === undefined && targetCollision) {
        throw new WorkItemTargetCollisionError(
          source.source_id,
          workItemId,
          target.source_id,
        );
      }
      if (
        cleanupError === undefined &&
        (error instanceof WorkItemTargetCollisionError ||
          error instanceof WorkItemTransferFailedError)
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

  private async validatePublishedTransferTarget(
    record: TransferJournalRecord,
    target: ResolvedSource,
    targetItem: WorkItem,
    expectedItem?: WorkItem,
  ): Promise<void> {
    const expectedSha256 =
      record.kind === "save"
        ? record.target_sha256
        : expectedItem === undefined
          ? undefined
          : fingerprintWorkItem(expectedItem);
    if (
      expectedSha256 !== undefined &&
      fingerprintWorkItem(targetItem) !== expectedSha256
    ) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        "published target does not match the staged work item",
      );
    }

    if (record.kind !== "save") {
      return;
    }
    if (record.staged_manifest_run_id === undefined) {
      if (targetItem.goal.goal_contract !== undefined) {
        throw new WorkItemTransferFailedError(
          record.from_source_id,
          record.work_item_id,
          record.to_source_id,
          "published target has a contract without a staged manifest reference",
        );
      }
      return;
    }

    const manifest = await target.workspace.readControllerRunManifest(
      record.work_item_id,
      record.staged_manifest_run_id,
    );
    if (
      manifest === null ||
      manifest.run_id !== record.staged_manifest_run_id ||
      !manifestMatchesWorkItem(manifest, targetItem)
    ) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        "published target manifest is missing or does not match the saved work item",
      );
    }
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
      workItem.goal.goal_contract === undefined ||
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
      phase: "execute",
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

    if (targetItem === null) {
      if (sourceItem === null) {
        throw new WorkItemTransferFailedError(
          record.from_source_id,
          record.work_item_id,
          record.to_source_id,
          "transfer has neither a source item nor a published target",
        );
      }
      await target.workspace.discardStagedWorkItem(
        record.work_item_id,
        record.to_path,
      );
      await this.deleteTransferJournal(record.transfer_id);
      return;
    }

    if (
      sourceItem !== null &&
      sourceItem.goal.goal_contract !== undefined
    ) {
      throw new WorkItemTransferFailedError(
        record.from_source_id,
        record.work_item_id,
        record.to_source_id,
        "transfer source unexpectedly contains a locked goal contract",
      );
    }
    await this.validatePublishedTransferTarget(
      record,
      target,
      targetItem,
      record.kind === "move" ? (sourceItem ?? undefined) : undefined,
    );

    if (sourceItem !== null) {
      await source.workspace.removeWorkItem(record.work_item_id);
      if ((await source.workspace.read(record.work_item_id)) !== null) {
        throw new WorkItemTransferFailedError(
          record.from_source_id,
          record.work_item_id,
          record.to_source_id,
          "source work item still exists after recovery removal",
        );
      }
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
