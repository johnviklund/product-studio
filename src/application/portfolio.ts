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
  portfolioWorkItemSchema,
} from "../domain/portfolio";
import {
  MISSION_SCHEMA_VERSION,
  compileMission as compileMissionPackage,
  compilePatchMission as compilePatchMissionPackage,
  compileReviewMission as compileReviewMissionPackage,
  patchSubjectSchema,
  type ExecuteMissionPackage,
  type MissionArtifactWriteResult,
  type MissionIdentity,
  type PatchMissionPackage,
  type ReviewMissionPackage,
} from "../domain/mission";
import {
  createImportRunId,
  hashResultContent,
  reviewExternalResultSubmissionForSubjectSchema,
  reviewFindingSchema,
  type ImportEvidenceSummary,
  type PatchExternalResultSubmission,
  type ReviewFinding,
  type ReviewExternalResultSubmission,
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
  workItemAttentionSchema,
  workItemIdSchema,
  workItemSchema,
  type CreateCaptureInput,
  type ControllerRunManifest,
  type SaveWorkItemInput,
  type UpdateWorkItemPhaseInput,
  type WorkItem,
  type WorkItemAttention,
  type WorkItemGoal,
} from "../domain/work-item";
import {
  canUpdateGoalContract,
  validatePhaseTransition,
} from "../domain/workflow-policy";
import {
  hashResolvedCapabilityEnvelope,
  summarizeConnectedRun,
  type ConnectedRunRecordV1,
  type ConnectedRunSummary,
} from "../domain/connected-run";
import {
  capabilityEnvelopeV1Schema,
  isCapabilityEnvelopeNarrowing,
  type CapabilityEnvelopeV1,
} from "../domain/capability-envelope";
import type {
  AcpClientAdapter,
  AcpEventSink,
  AcpRunResult,
  AcpSession,
} from "../infrastructure/acp/acp-client";
import {
  createCopilotRuntimeProfile,
  type CopilotRuntimeProfileInput,
  type CopilotSanitizedProfileEvidence,
} from "../infrastructure/acp/copilot-runtime-profile";
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
  | "findAppliedPatchManifest"
  | "readAppliedExecuteReviewSubject"
  | "readAppliedPatchReviewSubject"
  | "writePatchMissionPackage"
  | "writeReviewMissionPackage"
  | "writeMissionPackage"
  | "readMissionPackage"
  | "readMissionResult"
  | "createConnectedRun"
  | "readConnectedRun"
  | "listConnectedRuns"
  | "startConnectedRun"
  | "appendConnectedRunEvent"
  | "completeConnectedRun"
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

export type MissionCompilation = MissionArtifactWriteResult<ExecuteMissionPackage>;
export type ReviewMissionCompilation =
  MissionArtifactWriteResult<ReviewMissionPackage>;
export type PatchMissionCompilation =
  MissionArtifactWriteResult<PatchMissionPackage>;

export interface PortfolioImportResult extends PortfolioWorkItem {
  evidence: ImportEvidenceSummary;
}

export interface PortfolioReviewImportResult extends PortfolioWorkItem {
  evidence: ImportEvidenceSummary;
  result?: ReviewExternalResultSubmission;
}

export interface PortfolioPatchImportResult extends PortfolioWorkItem {
  evidence: ImportEvidenceSummary;
  result?: PatchExternalResultSubmission;
}

export interface PortfolioPatchPlanResult extends PortfolioWorkItem {
  controller_run: ControllerRunManifest;
}

export interface PortfolioAttentionItem {
  item: PortfolioWorkItem;
  attention: WorkItemAttention;
  acceptance_criteria: {
    criterion: string;
    status: "reviewed" | "needs_attention" | "unknown";
  }[];
  verification: {
    status: "passed" | "unknown";
    commands: { name: string; status: "passed" }[];
  };
  findings: ReviewFinding[];
  patch_cycle_limit: 3;
  elapsed_ms?: number;
  cost_capacity: "unknown";
}

export interface PortfolioRetryResult extends PortfolioWorkItem {
  controller_run: ControllerRunManifest;
}

export interface LaunchConnectedExecuteRequest {
  model_override?: string;
  narrowed_capability_envelope?: CapabilityEnvelopeV1;
}

export interface PortfolioConnectedRunResult extends PortfolioWorkItem {
  connected_run: ConnectedRunSummary;
}

export interface ConnectedRuntimePrepareInput {
  workspace_cwd: string;
  capability_envelope: CapabilityEnvelopeV1;
  limits: ConnectedRunRecordV1["limits"];
  model_override?: string;
}

export interface PreparedConnectedRuntime {
  requested_model: string;
  reasoning_effort: string;
  sanitized_profile: CopilotSanitizedProfileEvidence;
  start(event_sink: AcpEventSink): Promise<AcpSession>;
}

export interface ConnectedExecuteRuntime {
  prepare(input: ConnectedRuntimePrepareInput): Promise<PreparedConnectedRuntime>;
}

export interface CopilotConnectedExecuteRuntimeOptions {
  profile: Omit<
    CopilotRuntimeProfileInput,
    "requested_model" | "workspace_cwd" | "capability_envelope" | "limits"
  > & {
    default_model: string;
  };
}

export class CopilotConnectedExecuteRuntime
  implements ConnectedExecuteRuntime
{
  constructor(
    private readonly adapter: AcpClientAdapter,
    private readonly options: CopilotConnectedExecuteRuntimeOptions,
  ) {}

  async prepare(
    input: ConnectedRuntimePrepareInput,
  ): Promise<PreparedConnectedRuntime> {
    const requestedModel = input.model_override ?? this.options.profile.default_model;
    const profile = createCopilotRuntimeProfile({
      ...this.options.profile,
      requested_model: requestedModel,
      workspace_cwd: input.workspace_cwd,
      capability_envelope: input.capability_envelope,
      limits: input.limits,
    });
    return {
      requested_model: requestedModel,
      reasoning_effort: this.options.profile.reasoning_effort,
      sanitized_profile: profile.sanitized_profile_evidence,
      start: (eventSink) => this.adapter.start(profile.runtime_profile, eventSink),
    };
  }
}

const CONNECTED_RUN_LIMITS: ConnectedRunRecordV1["limits"] = {
  wall_clock_timeout_ms: 900_000,
  max_event_count: 1_000,
  max_event_bytes: 1_000_000,
  max_output_bytes: 100_000,
  termination_grace_ms: 5_000,
  drain_grace_ms: 1_000,
};

const launchConnectedExecuteRequestSchema: z.ZodType<LaunchConnectedExecuteRequest> =
  z.strictObject({
    model_override: z.string().trim().min(1).max(200).optional(),
    narrowed_capability_envelope: capabilityEnvelopeV1Schema.optional(),
  });

export interface ConnectedPermissionDecisionRequest {
  connected_run_id: string;
  operation_sha256: string;
  decision: "allow_once" | "keep_denied";
}

export interface PortfolioConnectedPermissionResult extends PortfolioWorkItem {
  controller_run: ControllerRunManifest | null;
}

const connectedPermissionDecisionRequestSchema: z.ZodType<ConnectedPermissionDecisionRequest> =
  z.strictObject({
    connected_run_id: controllerRunIdSchema,
    operation_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    decision: z.enum(["allow_once", "keep_denied"]),
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const compileReviewMissionInputSchema = z.strictObject({
  independence_attested: z.literal(true),
});

const portfolioAttentionItemSchema: z.ZodType<PortfolioAttentionItem> =
  z.strictObject({
    item: portfolioWorkItemSchema,
    attention: workItemAttentionSchema,
    acceptance_criteria: z.array(
      z.strictObject({
        criterion: z.string().trim().min(1),
        status: z.enum(["reviewed", "needs_attention", "unknown"]),
      }),
    ),
    verification: z.strictObject({
      status: z.enum(["passed", "unknown"]),
      commands: z.array(
        z.strictObject({
          name: z.string().trim().min(1),
          status: z.literal("passed"),
        }),
      ),
    }),
    findings: z.array(reviewFindingSchema),
    patch_cycle_limit: z.literal(3),
    elapsed_ms: z.number().int().nonnegative().safe().optional(),
    cost_capacity: z.literal("unknown"),
  });

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
    private readonly connectedRuntime?: ConnectedExecuteRuntime,
  ) {
    this.inboxRoot = resolve(inboxRoot);
    this.transfersRoot = join(dirname(this.inboxRoot), "transfers");
  }

  readonly inboxRoot: string;
  readonly transfersRoot: string;
  private readonly liveConnectedSessions = new Map<string, AcpSession>();

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
    ) as Promise<MissionCompilation>;
  }

  async launchConnectedExecute(
    sourceId: string,
    workItemId: string,
    input: LaunchConnectedExecuteRequest = {},
  ): Promise<PortfolioConnectedRunResult> {
    const validatedInput = launchConnectedExecuteRequestSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedExecuteIdentity(source, workItem);
    const governedTuple = this.governedExecuteTuple(workItem, identity);
    const controller = this.workItemController(source.workspace);
    const activeRuns = (await source.workspace.listConnectedRuns(workItemId)).filter(
      (record) => record.lifecycle.status !== "terminal",
    );
    if (activeRuns.length > 1) {
      throw new ControllerConflictError(
        "repair_required",
        workItemId,
        "Only one connected run may be active for a governed item.",
      );
    }
    if (activeRuns.length === 1) {
      const activeRun = activeRuns[0]!;
      const replay = await controller.launchConnectedExecute(
        workItemId,
        this.connectedLaunchInput(
          governedTuple,
          activeRun.mission.content_sha256,
          validatedInput.model_override,
        ),
        activeRun,
      );
      return {
        ...this.toPortfolioItem(source, replay.work_item),
        connected_run: summarizeConnectedRun(replay.connected_run),
      };
    }
    if (this.connectedRuntime === undefined) {
      throw this.missionNotReady(
        workItemId,
        "Connected execution is not configured for this Product Studio service.",
      );
    }

    const mission = await this.compileMission(sourceId, workItemId);
    const capabilityEnvelope = this.resolveConnectedCapabilityEnvelope(
      workItemId,
      mission.mission.capability_envelope,
      validatedInput.narrowed_capability_envelope,
    );
    const launchInput = this.connectedLaunchInput(
      governedTuple,
      mission.mission.content_sha256,
      validatedInput.model_override,
    );

    const prepared = await this.connectedRuntime.prepare({
      workspace_cwd: source.workspace.workspaceRoot,
      capability_envelope: capabilityEnvelope,
      limits: CONNECTED_RUN_LIMITS,
      ...(validatedInput.model_override === undefined
        ? {}
        : { model_override: validatedInput.model_override }),
    });
    const record = this.connectedRunRecord(
      mission,
      governedTuple,
      capabilityEnvelope,
      prepared,
    );
    const launched = await controller.launchConnectedExecute(
      workItemId,
      launchInput,
      record,
    );
    if (!launched.created) {
      return {
        ...this.toPortfolioItem(source, launched.work_item),
        connected_run: summarizeConnectedRun(launched.connected_run),
      };
    }

    const eventSink: AcpEventSink = {
      append: (event) =>
        source.workspace.appendConnectedRunEvent(
          workItemId,
          launched.connected_run.connected_run_id,
          event,
        ),
    };
    let session: AcpSession | undefined;
    let running: ConnectedRunRecordV1;
    try {
      session = await prepared.start(eventSink);
      running = await source.workspace.startConnectedRun(
        workItemId,
        launched.connected_run.connected_run_id,
        {
          protocol_version: {
            value: session.protocol_version,
            assurance: "adapter_attested",
          },
          session_id: {
            value: session.session_id,
            assurance: "adapter_attested",
          },
        },
        session.process,
      );
      const key = this.connectedSessionKey(
        source.source_id,
        workItemId,
        running.connected_run_id,
      );
      this.liveConnectedSessions.set(key, session);
      void this.observeConnectedRun(source, workItemId, mission, running, session);
    } catch (error) {
      if (session !== undefined) {
        await session.close().catch(() => undefined);
      }
      await source.workspace
        .completeConnectedRun(
          workItemId,
          launched.connected_run.connected_run_id,
          this.failedConnectedTerminal(),
        )
        .catch(() => undefined);
      throw error;
    }
    await this.rebuild();
    return {
      ...this.toPortfolioItem(source, launched.work_item),
      connected_run: summarizeConnectedRun(running),
    };
  }

  async listConnectedRuns(
    sourceId: string,
    workItemId: string,
  ): Promise<ConnectedRunSummary[]> {
    const source = await this.resolveSource(sourceId);
    if ((await source.workspace.read(workItemId)) === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    return (await source.workspace.listConnectedRuns(workItemId)).map(
      summarizeConnectedRun,
    );
  }

  async cancelConnectedRun(
    sourceId: string,
    workItemId: string,
    connectedRunId: string,
  ): Promise<PortfolioConnectedRunResult> {
    const validatedRunId = controllerRunIdSchema.parse(connectedRunId);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const record = await source.workspace.readConnectedRun(workItemId, validatedRunId);
    if (record === null) {
      throw this.missionNotReady(workItemId, "Connected run was not found.");
    }
    if (record.lifecycle.status === "terminal") {
      return {
        ...this.toPortfolioItem(source, workItem),
        connected_run: summarizeConnectedRun(record),
      };
    }
    const key = this.connectedSessionKey(source.source_id, workItemId, validatedRunId);
    const session = this.liveConnectedSessions.get(key);
    if (session === undefined) {
      throw this.missionNotReady(
        workItemId,
        "This service cannot safely cancel a connected run it did not start.",
      );
    }
    await session.cancel();
    const terminal = await source.workspace.completeConnectedRun(
      workItemId,
      validatedRunId,
      {
        outcome: "cancelled",
        partial: true,
        reason: "Cancellation was requested by the Product Studio operator.",
      },
    );
    this.liveConnectedSessions.delete(key);
    await this.rebuild();
    return {
      ...this.toPortfolioItem(source, workItem),
      connected_run: summarizeConnectedRun(terminal),
    };
  }

  async decideConnectedPermission(
    sourceId: string,
    workItemId: string,
    input: ConnectedPermissionDecisionRequest,
  ): Promise<PortfolioConnectedPermissionResult> {
    const validatedInput = connectedPermissionDecisionRequestSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedExecuteIdentity(source, workItem);
    const governedTuple = this.governedExecuteTuple(workItem, identity);
    const attention = workItem.state.attention;
    if (attention?.kind !== "missing_permission") {
      throw this.missionNotReady(
        workItemId,
        "A connected permission decision requires active missing-permission attention.",
      );
    }
    const missionContentSha256 = attention.pins.mission_content_sha256;
    if (missionContentSha256 === undefined) {
      throw this.missionNotReady(
        workItemId,
        "Missing-permission attention does not pin its connected mission.",
      );
    }
    const decided = await this.workItemController(
      source.workspace,
    ).resolveConnectedPermission(workItemId, {
      decision: validatedInput.decision,
      governed_tuple: governedTuple,
      connected_run_id: validatedInput.connected_run_id,
      operation_sha256: validatedInput.operation_sha256,
      mission_content_sha256: missionContentSha256,
    });
    await this.rebuild();
    return {
      ...this.toPortfolioItem(source, decided.work_item),
      controller_run: decided.manifest,
    };
  }

  async compileReviewMission(
    sourceId: string,
    workItemId: string,
    input: { independence_attested: true },
  ): Promise<ReviewMissionCompilation> {
    const validatedInput = compileReviewMissionInputSchema.parse(input);
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedReviewIdentity(source, workItem);
    if (
      workItem.state.phase !== "review" ||
      workItem.state.status !== "active"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Review mission compilation requires an assigned, governed item in active review.",
      );
    }

    const patchCycle = workItem.state.patch_cycle!;
    const applied =
      patchCycle === 0
        ? await source.workspace.readAppliedExecuteReviewSubject({
            ...identity,
            phase: "execute",
          })
        : await source.workspace.readAppliedPatchReviewSubject({
            ...identity,
            phase: "patch",
            patch_cycle: patchCycle,
          });
    const controllerRun = await source.workspace.readControllerRunManifest(
      workItemId,
      applied.evidence.controller_run_id,
    );
    if (
      controllerRun === null ||
      controllerRun.phase !== "review" ||
      controllerRun.outcome !== "applied" ||
      controllerRun.completed_at === undefined
    ) {
      throw this.missionNotReady(
        workItemId,
        "Applied result evidence is missing its review transition controller run.",
      );
    }
    const reviewRun = {
      schema_version: controllerRun.schema_version,
      run_id: controllerRun.run_id,
      work_item_id: controllerRun.work_item_id,
      idempotency_key: controllerRun.idempotency_key,
      phase: "review" as const,
      goal_version: controllerRun.goal_version,
      input_revision: controllerRun.input_revision,
      attempt: controllerRun.attempt,
      started_at: controllerRun.started_at,
      completed_at: controllerRun.completed_at,
      outcome: "applied" as const,
    };

    const reviewSubject = applied.review_subject;
    return source.workspace.writeReviewMissionPackage(
      identity,
      reviewSubject,
      (paths) =>
        reviewSubject.source === "execute"
          ? compileReviewMissionPackage({
              work_item: workItem,
              controller_run: reviewRun,
              review_subject: reviewSubject,
              paths,
              independence_attested: validatedInput.independence_attested,
            })
          : compileReviewMissionPackage({
              work_item: workItem,
              controller_run: reviewRun,
              review_subject: reviewSubject,
              paths,
              independence_attested: validatedInput.independence_attested,
            }),
    );
  }

  async compilePatchMission(
    sourceId: string,
    workItemId: string,
  ): Promise<PatchMissionCompilation> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedPatchIdentity(source, workItem);
    if (
      workItem.state.phase !== "patch" ||
      workItem.state.status !== "active"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Patch mission compilation requires an assigned, governed item in active patch.",
      );
    }

    const appliedReview = await this.readAppliedReviewResult(
      source,
      workItem,
      identity.patch_cycle - 1,
    );
    const patchPlanIdempotencyKey = [
      deriveControllerIdempotencyKey(
        workItemId,
        "patch",
        identity.goal_version,
        identity.input_revision,
        identity.attempt,
      ),
      `cycle-${identity.patch_cycle}`,
      "accept-plan",
      appliedReview.resultContentSha256,
    ].join(":");
    const patchManifest = await source.workspace.findAppliedPatchManifest(
      identity,
    );
    if (
      patchManifest === null ||
      patchManifest.completed_at === undefined ||
      patchManifest.idempotency_key !== patchPlanIdempotencyKey
    ) {
      throw this.missionNotReady(
        workItemId,
        "No applied patch-plan manifest matches the governed cycle and review result.",
      );
    }
    if (appliedReview.result.verdict !== "findings") {
      throw this.missionNotReady(
        workItemId,
        "Patch mission compilation requires an applied review with findings.",
      );
    }
    const patchSubject = patchSubjectSchema.parse({
      review_mission_content_sha256:
        appliedReview.snapshot.mission.content_sha256,
      review_result_content_sha256: appliedReview.resultContentSha256,
      review_mission_path: appliedReview.snapshot.mission_path,
      review_result_path: appliedReview.snapshot.result_path,
      review_evidence_path: appliedReview.evidence.summary.evidence_path,
      reviewed_commit: appliedReview.result.accepted_result_commit,
      findings: [...appliedReview.result.findings].sort((left, right) =>
        left.finding_id.localeCompare(right.finding_id),
      ),
      prior_review_subject: appliedReview.snapshot.mission.review_subject,
    });
    const patchRun = {
      schema_version: patchManifest.schema_version,
      run_id: patchManifest.run_id,
      work_item_id: patchManifest.work_item_id,
      idempotency_key: patchManifest.idempotency_key,
      phase: "patch" as const,
      goal_version: patchManifest.goal_version,
      input_revision: patchManifest.input_revision,
      attempt: patchManifest.attempt,
      started_at: patchManifest.started_at,
      completed_at: patchManifest.completed_at,
      outcome: "applied" as const,
    };

    return source.workspace.writePatchMissionPackage(
      identity,
      patchSubject,
      (paths) =>
        compilePatchMissionPackage({
          work_item: workItem,
          controller_run: patchRun,
          patch_subject: patchSubject,
          paths,
        }),
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
      expected_schema_version: 2,
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

  async importReviewResult(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioReviewImportResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedReviewIdentity(source, workItem);
    if (
      workItem.state.phase !== "review" ||
      workItem.state.status !== "active"
    ) {
      throw this.missionNotReady(
        workItemId,
        "Review result import requires an assigned, governed item in active review.",
      );
    }

    const imported = await this.workItemController(
      source.workspace,
    ).importReviewResult(workItemId, {
      expected_phase: "review",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
      expected_patch_cycle: workItem.state.patch_cycle!,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: imported.work_item,
      evidence: imported.evidence,
      ...(imported.result === undefined ? {} : { result: imported.result }),
    };
  }

  async acceptPatchPlan(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioPatchPlanResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedReviewIdentity(source, workItem);
    const patchCycle = workItem.state.patch_cycle!;
    const expectedPatchCycle =
      workItem.state.phase === "patch" ? patchCycle - 1 : patchCycle;
    if (
      workItem.state.status !== "active" ||
      !["review", "patch"].includes(workItem.state.phase) ||
      expectedPatchCycle < 0
    ) {
      throw this.missionNotReady(
        workItemId,
        "Patch-plan approval requires an assigned, governed item in active review.",
      );
    }

    const accepted = await this.workItemController(
      source.workspace,
    ).acceptPatchPlan(workItemId, {
      expected_phase: "review",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
      expected_patch_cycle: expectedPatchCycle,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: accepted.work_item,
      controller_run: accepted.manifest,
    };
  }

  async importPatchResult(
    sourceId: string,
    workItemId: string,
  ): Promise<PortfolioPatchImportResult> {
    const source = await this.resolveSource(sourceId);
    const workItem = await source.workspace.read(workItemId);
    if (workItem === null) {
      throw new PortfolioWorkItemNotFoundError(sourceId, workItemId);
    }
    const identity = this.governedPatchIdentity(source, workItem);
    const isActivePatch =
      workItem.state.phase === "patch" && workItem.state.status === "active";
    if (!isActivePatch) {
      const isReplayState =
        workItem.state.phase === "review" &&
        workItem.state.status === "active";
      if (!isReplayState) {
        throw this.missionNotReady(
          workItemId,
          "Patch result import requires an assigned, governed item in active patch.",
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
          "An active review item only accepts an identical patch import replay.",
        );
      }
    }

    const imported = await this.workItemController(
      source.workspace,
    ).importPatchResult(workItemId, {
      expected_phase: "patch",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
      expected_patch_cycle: identity.patch_cycle,
    });
    await this.rebuild();
    return {
      source_id: source.source_id,
      project: source.project,
      work_item: imported.work_item,
      evidence: imported.evidence,
      ...(imported.result === undefined ? {} : { result: imported.result }),
    };
  }

  async listAttention(): Promise<PortfolioAttentionItem[]> {
    const attentionItems: PortfolioAttentionItem[] = [];
    for (const project of await this.registry.read()) {
      const source: ResolvedSource = {
        source_id: project.workspace_id,
        project,
        workspace: this.makeWorkspace(project.workspace_path),
      };
      for (const workItem of await source.workspace.list()) {
        const attentionItem = await this.projectAttention(source, workItem);
        if (attentionItem !== null) {
          attentionItems.push(attentionItem);
        }
      }
    }

    return z.array(portfolioAttentionItemSchema).parse(
      attentionItems.sort(
        (left, right) =>
          right.attention.created_at.localeCompare(
            left.attention.created_at,
          ) ||
          left.item.source_id.localeCompare(right.item.source_id) ||
          left.item.work_item.goal.work_item_id.localeCompare(
            right.item.work_item.goal.work_item_id,
          ),
      ),
    );
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
      expected_schema_version: 2,
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

  private async readAppliedReviewResult(
    source: ResolvedSource,
    workItem: WorkItem,
    reviewPatchCycle: number,
  ) {
    const identity = this.governedReviewIdentity(source, workItem);
    const snapshot = await source.workspace.readMissionResult(
      identity,
      reviewPatchCycle === 0 ? undefined : reviewPatchCycle,
    );
    if (
      snapshot.mission.mission_schema_version !== MISSION_SCHEMA_VERSION ||
      !("review_subject" in snapshot.mission)
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review evidence must bind an active review mission.",
      );
    }
    const reviewMission = snapshot.mission;
    const reviewSnapshot = { ...snapshot, mission: reviewMission };

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(snapshot.result_source);
    } catch {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review result is not valid JSON.",
      );
    }
    const resultParse = reviewExternalResultSubmissionForSubjectSchema(
      reviewMission.review_subject,
    ).safeParse(parsedJson);
    if (!resultParse.success) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review result no longer satisfies its pinned subject contract.",
      );
    }
    const result = resultParse.data;
    const resultContentSha256 = hashResultContent(snapshot.result_source);
    const importRunId = createImportRunId(
      snapshot.mission.content_sha256,
      resultContentSha256,
    );
    const evidence = await source.workspace.readImportEvidence(
      identity,
      importRunId,
    );
    if (
      evidence === null ||
      evidence.evidence.phase !== "review" ||
      evidence.evidence.outcome !== "applied" ||
      evidence.evidence.mission_content_sha256 !==
        reviewMission.content_sha256 ||
      evidence.evidence.result_content_sha256 !== resultContentSha256 ||
      evidence.evidence.git_base_commit !==
        reviewMission.review_subject.git_base_commit ||
      evidence.evidence.result_commit !== result.accepted_result_commit ||
      JSON.stringify(evidence.evidence.identity) !== JSON.stringify(identity)
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review mission, result, and evidence do not match.",
      );
    }
    const controllerRun = await source.workspace.readControllerRunManifest(
      workItem.goal.work_item_id,
      evidence.evidence.controller_run_id,
    );
    if (
      controllerRun === null ||
      controllerRun.phase !== "review" ||
      controllerRun.outcome !== "applied" ||
      controllerRun.goal_version !== identity.goal_version ||
      controllerRun.input_revision !== identity.input_revision ||
      controllerRun.attempt !== identity.attempt
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Applied review evidence is missing its matching controller run.",
      );
    }

    return {
      snapshot: reviewSnapshot,
      result,
      resultContentSha256,
      evidence,
    };
  }

  private async projectAttention(
    source: ResolvedSource,
    workItem: WorkItem,
  ): Promise<PortfolioAttentionItem | null> {
    const contract = workItem.goal.goal_contract;
    const state = workItem.state;
    if (
      contract === undefined ||
      state.status !== "active" ||
      state.goal_version === undefined ||
      state.input_revision === undefined ||
      state.attempt === undefined ||
      state.patch_cycle === undefined
    ) {
      return null;
    }

    const attention =
      state.attention ?? this.phaseApprovalAttention(workItem);
    if (attention === null) {
      return null;
    }
    const acceptanceCriteria: PortfolioAttentionItem["acceptance_criteria"] =
      contract.acceptance_criteria.map(
      (criterion) => ({
        criterion,
        status: "unknown" as const,
      }),
      );
    let verification: PortfolioAttentionItem["verification"] = {
      status: "unknown",
      commands: [],
    };
    let findings: ReviewFinding[] = [];
    let elapsedMs: number | undefined;

    if (state.attention !== undefined && state.phase === "review") {
      const appliedReview = await this.readAppliedReviewResult(
        source,
        workItem,
        state.patch_cycle,
      );
      const expectedArtifactPaths = [
        appliedReview.snapshot.mission_path,
        appliedReview.snapshot.result_path,
      ];
      if (
        JSON.stringify(attention.pins.artifact_paths) !==
          JSON.stringify(expectedArtifactPaths) ||
        JSON.stringify(attention.pins.evidence_paths) !==
          JSON.stringify([appliedReview.evidence.summary.evidence_path]) ||
        attention.pins.git_commit !==
          appliedReview.result.accepted_result_commit ||
        attention.pins.mission_content_sha256 !==
          appliedReview.snapshot.mission.content_sha256 ||
        attention.pins.result_content_sha256 !==
          appliedReview.resultContentSha256
      ) {
        throw new ControllerConflictError(
          "repair_required",
          workItem.goal.work_item_id,
          "Current attention does not match its pinned review evidence.",
        );
      }
      verification = {
        status: "passed",
        commands:
          appliedReview.snapshot.mission.review_subject.command_evidence.map(
            (record) => ({ name: record.name, status: "passed" as const }),
          ),
      };
      findings = appliedReview.result.findings;
      const needsAttention = new Set(
        findings.flatMap((finding) =>
          finding.link.type === "acceptance_criteria"
            ? [finding.link.criterion]
            : [],
        ),
      );
      for (const criterion of acceptanceCriteria) {
        criterion.status =
          appliedReview.result.verdict === "clean"
            ? "reviewed"
            : needsAttention.has(criterion.criterion)
              ? "needs_attention"
              : "unknown";
      }
      elapsedMs = Math.max(
        0,
        Date.parse(appliedReview.evidence.evidence.completed_at) -
          Date.parse(appliedReview.evidence.evidence.started_at),
      );
    }

    return portfolioAttentionItemSchema.parse({
      item: this.toPortfolioItem(source, workItem),
      attention,
      acceptance_criteria: acceptanceCriteria,
      verification,
      findings,
      patch_cycle_limit: 3,
      ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs }),
      cost_capacity: "unknown",
    });
  }

  private phaseApprovalAttention(workItem: WorkItem): WorkItemAttention | null {
    const state = workItem.state;
    if (
      state.phase !== "spec" &&
      state.phase !== "plan"
    ) {
      return null;
    }
    const tuple = {
      goal_version: state.goal_version!,
      input_revision: state.input_revision!,
      attempt: state.attempt!,
      patch_cycle: state.patch_cycle!,
    };
    const artifactPaths = [
      `.founder/work-items/${state.work_item_id}/goal.yaml`,
      `.founder/work-items/${state.work_item_id}/state.json`,
    ] as [string, ...string[]];
    return workItemAttentionSchema.parse(
      state.phase === "spec"
        ? {
            kind: "spec_approval",
            question:
              "Does the current goal contract authorize planning this work?",
            recommendation:
              "Open the item and approve its existing transition to Plan.",
            created_at: state.updated_at,
            governed_tuple: tuple,
            pins: { artifact_paths: artifactPaths, evidence_paths: [] },
          }
        : {
            kind: "plan_approval",
            question:
              "Does the current goal contract and allowed scope authorize execution?",
            recommendation:
              "Open the item and approve its existing transition to Execute.",
            created_at: state.updated_at,
            governed_tuple: tuple,
            pins: { artifact_paths: artifactPaths, evidence_paths: [] },
          },
    );
  }

  private resolveConnectedCapabilityEnvelope(
    workItemId: string,
    compiled: CapabilityEnvelopeV1,
    narrowed: CapabilityEnvelopeV1 | undefined,
  ): CapabilityEnvelopeV1 {
    if (narrowed === undefined) {
      return compiled;
    }
    if (!isCapabilityEnvelopeNarrowing(narrowed, compiled)) {
      throw this.missionNotReady(
        workItemId,
        "A connected capability envelope may only narrow the compiled mission envelope.",
      );
    }
    return narrowed;
  }

  private connectedRunRecord(
    mission: MissionCompilation,
    governedTuple: ConnectedRunRecordV1["governed_tuple"],
    capabilityEnvelope: CapabilityEnvelopeV1,
    prepared: PreparedConnectedRuntime,
  ): ConnectedRunRecordV1 {
    const profileSha256 = this.hashConnectedValue(prepared.sanitized_profile);
    const authorizationSha256 = this.hashConnectedValue({
      mission_content_sha256: mission.mission.content_sha256,
      capability_envelope_sha256: hashResolvedCapabilityEnvelope(capabilityEnvelope),
      requested_model: prepared.requested_model,
    });
    const timestamp = new Date().toISOString();
    const envelopeSha256 = hashResolvedCapabilityEnvelope(capabilityEnvelope);
    return {
      schema_version: 1,
      connected_run_id: randomUUID(),
      mission: {
        identity: mission.mission.identity,
        path: mission.mission_path.slice(
          mission.workspace_path.length + 1,
        ),
        content_sha256: mission.mission.content_sha256,
        source_commit: mission.mission.source_revision.git_base_commit,
      },
      governed_tuple: governedTuple,
      provenance: {
        role: { value: "writer", assurance: "controller_observed" },
        seat: { value: "executor", assurance: "controller_observed" },
        requested_model: {
          value: prepared.requested_model,
          assurance: "user_declared",
        },
        effective_model: {
          assurance: "unknown",
          model_id: null,
          deployment_id: null,
          observed_event_sha256: null,
        },
        effort: {
          value: prepared.reasoning_effort,
          assurance: "user_declared",
        },
        harness: {
          value: {
            id: prepared.sanitized_profile.adapter_id,
            version: prepared.sanitized_profile.adapter_version,
          },
          assurance: "adapter_attested",
        },
        adapter_profile: {
          value: {
            adapter_id: prepared.sanitized_profile.adapter_id,
            adapter_version: prepared.sanitized_profile.adapter_version,
            profile_id: prepared.sanitized_profile.profile_id,
          },
          assurance: "adapter_attested",
        },
        resolved_profile_sha256: {
          value: profileSha256,
          assurance: "controller_observed",
        },
        resolved_skill_set_sha256: { value: null, assurance: "unknown" },
        capability_envelope_sha256: {
          value: envelopeSha256,
          assurance: "controller_observed",
        },
        authorization_sha256: {
          value: authorizationSha256,
          assurance: "controller_observed",
        },
      },
      resolved_capability_envelope: {
        envelope: capabilityEnvelope,
        envelope_sha256: envelopeSha256,
      },
      acp: {
        protocol_version: { value: null, assurance: "unknown" },
        session_id: { value: null, assurance: "unknown" },
      },
      lifecycle: {
        status: "starting",
        started_at: timestamp,
        updated_at: timestamp,
        completed_at: null,
        terminal: null,
      },
      limits: CONNECTED_RUN_LIMITS,
      process: null,
      diagnostics: { entries: [], truncated: false },
    };
  }

  private async observeConnectedRun(
    source: ResolvedSource,
    workItemId: string,
    mission: MissionCompilation,
    record: ConnectedRunRecordV1,
    session: AcpSession,
  ): Promise<void> {
    const key = this.connectedSessionKey(
      source.source_id,
      workItemId,
      record.connected_run_id,
    );
    try {
      const result = await session.run(
        `Execute the governed task in ${mission.mission.task_path} and write only the required result to ${mission.mission.result_contract.output_path}.`,
      );
      const terminal = await this.completeObservedConnectedRun(
        source,
        workItemId,
        record.connected_run_id,
        result,
      );
      if (terminal.lifecycle.terminal?.outcome !== result.outcome) {
        return;
      }
      if (result.outcome === "missing_permission") {
        await this.recordMissingPermission(
          source,
          workItemId,
          mission,
          record,
          result,
        );
      } else if (result.outcome === "completed") {
        await this.importResult(source.source_id, workItemId);
      }
      await this.rebuild();
    } catch {
      await source.workspace
        .completeConnectedRun(
          workItemId,
          record.connected_run_id,
          this.failedConnectedTerminal(),
        )
        .catch(() => undefined);
      await this.rebuild().catch(() => undefined);
    } finally {
      if (this.liveConnectedSessions.get(key) === session) {
        this.liveConnectedSessions.delete(key);
      }
      await session.close().catch(() => undefined);
    }
  }

  private async completeObservedConnectedRun(
    source: ResolvedSource,
    workItemId: string,
    connectedRunId: string,
    result: AcpRunResult,
  ): Promise<ConnectedRunRecordV1> {
    const terminal = this.connectedTerminalFromResult(result);
    try {
      return await source.workspace.completeConnectedRun(
        workItemId,
        connectedRunId,
        terminal,
      );
    } catch (error) {
      const current = await source.workspace.readConnectedRun(
        workItemId,
        connectedRunId,
      );
      if (current?.lifecycle.status === "terminal") {
        return current;
      }
      throw error;
    }
  }

  private async recordMissingPermission(
    source: ResolvedSource,
    workItemId: string,
    mission: MissionCompilation,
    record: ConnectedRunRecordV1,
    result: AcpRunResult,
  ): Promise<void> {
    const missing = result.permissions.find(
      (permission) => permission.kind === "missing_permission",
    );
    if (missing === undefined) {
      throw this.missionNotReady(
        workItemId,
        "A missing-permission run did not retain an exact denied operation.",
      );
    }
    await this.workItemController(source.workspace).recordConnectedPermissionDenial(
      workItemId,
      {
        expected_phase: "execute",
        expected_status: "active",
        expected_schema_version: 2,
        governed_tuple: record.governed_tuple,
        mission_content_sha256: mission.mission.content_sha256,
        operation: {
          normalized_operation: missing.request,
          canonical_args_sha256: this.hashConnectedValue(missing.request),
          operation_sha256: missing.operation_sha256,
          reason: missing.reason,
          resolved_envelope_sha256:
            record.resolved_capability_envelope.envelope_sha256,
          connected_run_id: record.connected_run_id,
        },
      },
    );
  }

  private connectedTerminalFromResult(result: AcpRunResult) {
    if (result.outcome === "completed") {
      return { outcome: "completed" as const, partial: false, reason: null };
    }
    return {
      outcome: result.outcome,
      partial: result.partial,
      reason:
        result.outcome === "missing_permission"
          ? "The ACP adapter denied an operation outside the approved capability envelope."
          : "The ACP adapter did not complete the governed mission.",
    };
  }

  private failedConnectedTerminal() {
    return {
      outcome: "failed" as const,
      partial: true,
      reason: "The ACP runtime failed before the governed mission completed.",
    };
  }

  private connectedSessionKey(
    sourceId: string,
    workItemId: string,
    connectedRunId: string,
  ): string {
    return `${sourceId}:${workItemId}:${connectedRunId}`;
  }

  private hashConnectedValue(value: unknown): string {
    return createHash("sha256")
      .update(`${JSON.stringify(value)}\n`)
      .digest("hex");
  }

  private governedExecuteIdentity(
    source: ResolvedSource,
    workItem: WorkItem,
  ): MissionIdentity<"execute"> {
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

  private governedExecuteTuple(
    workItem: WorkItem,
    identity: MissionIdentity<"execute">,
  ): ConnectedRunRecordV1["governed_tuple"] {
    if (workItem.state.patch_cycle === undefined) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Connected execution requires an explicit patch-cycle pin.",
      );
    }
    return {
      goal_version: identity.goal_version,
      input_revision: identity.input_revision,
      attempt: identity.attempt,
      patch_cycle: workItem.state.patch_cycle,
    };
  }

  private connectedLaunchInput(
    governedTuple: ConnectedRunRecordV1["governed_tuple"],
    missionContentSha256: string,
    modelOverride: string | undefined,
  ) {
    return {
      expected_phase: "execute" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      governed_tuple: governedTuple,
      mission_content_sha256: missionContentSha256,
      ...(modelOverride === undefined ? {} : { model_override: modelOverride }),
    };
  }

  private governedReviewIdentity(
    source: ResolvedSource,
    workItem: WorkItem,
  ): MissionIdentity<"review"> {
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.goal.goal_contract === undefined ||
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.state.attempt === undefined
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Review operations require an assigned, governed item.",
      );
    }
    return {
      phase: "review",
      work_item_id: workItem.goal.work_item_id,
      goal_version: workItem.state.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
    };
  }

  private governedPatchIdentity(
    source: ResolvedSource,
    workItem: WorkItem,
  ): MissionIdentity<"patch"> {
    if (
      source.source_id === INBOX_SOURCE_ID ||
      workItem.goal.goal_contract === undefined ||
      workItem.state.goal_version === undefined ||
      workItem.state.input_revision === undefined ||
      workItem.state.attempt === undefined ||
      workItem.state.patch_cycle === undefined ||
      workItem.state.patch_cycle < 1
    ) {
      throw this.missionNotReady(
        workItem.goal.work_item_id,
        "Patch operations require an assigned, governed item with an active patch cycle.",
      );
    }
    return {
      phase: "patch",
      work_item_id: workItem.goal.work_item_id,
      goal_version: workItem.state.goal_version,
      input_revision: workItem.state.input_revision,
      attempt: workItem.state.attempt,
      patch_cycle: workItem.state.patch_cycle,
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
