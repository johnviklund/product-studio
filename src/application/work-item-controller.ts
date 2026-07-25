import { createHash } from "node:crypto";

import type { ExecuteReviewSubject } from "../domain/mission";
import {
  commandEvidenceRecordSchema,
  createImportRunId,
  executeExternalResultSubmissionSchema,
  executeReviewExternalResultSubmissionSchema,
  hashResultContent,
  importEvidenceEnvelopeSchema,
  type CommandEvidenceRecord,
  type ExecuteExternalResultSubmission,
  type ExecuteReviewExternalResultSubmission,
  type ImportEvidenceOutcome,
  type ImportEvidenceSummary,
  type MissionResultSnapshot,
  type ReviewExternalResultSubmission,
  type StoredImportEvidence,
} from "../domain/result";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../domain/verification";
import {
  ControllerConflictError,
  controllerRunManifestSchema,
  controllerTransitionInputSchema,
  importExternalResultInputSchema,
  importReviewResultInputSchema,
  retryExecuteAttemptInputSchema,
  saveWorkItemInputSchema,
  workItemIdSchema,
  workItemSchema,
  type ActiveRun,
  type ControllerLease,
  type ControllerMutationResult,
  type ControllerRunManifest,
  type ControllerTransitionInput,
  type ControllerWorkItemRepository,
  type ImportExternalResultInput,
  type ImportReviewResultInput,
  type ProductManifest,
  type RetryExecuteAttemptInput,
  type SaveWorkItemInput,
  type WorkItem,
  type WorkItemPhase,
  type WorkItemStatus,
} from "../domain/work-item";
import {
  canUpdateGoalContract,
  validateWorkItemTransition,
} from "../domain/workflow-policy";
import {
  scopeMatchesPath,
  workspaceRelativePosixPathSchema,
} from "../domain/workspace-path";

type Clock = () => Date;

export interface ImportExternalResultResult extends ControllerMutationResult {
  evidence: ImportEvidenceSummary;
}

export interface ImportReviewResultResult {
  work_item: WorkItem;
  manifest: ControllerRunManifest | null;
  evidence: ImportEvidenceSummary;
  result?: ReviewExternalResultSubmission;
}

interface ExternalResultAssessment {
  outcome: ImportEvidenceOutcome;
  reasons: string[];
  result?: ExecuteExternalResultSubmission;
  verification: CommandEvidenceRecord[];
}

interface ReviewResultAssessment {
  outcome: "rejected" | "applied";
  reasons: string[];
  result?: ExecuteReviewExternalResultSubmission;
}

export function deriveControllerIdempotencyKey(
  workItemId: string,
  targetPhase: WorkItemPhase,
  goalVersion: number,
  inputRevision: number,
  attempt: number,
): string {
  return [
    workItemId,
    targetPhase,
    goalVersion,
    inputRevision,
    attempt,
  ].join(":");
}

function deriveControllerRunId(
  idempotencyKey: string,
  operationFingerprint: string,
): string {
  const digest = createHash("sha256")
    .update(idempotencyKey)
    .update("\0")
    .update(operationFingerprint)
    .digest("hex")
    .slice(0, 32)
    .split("");

  digest[12] = "5";
  digest[16] = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function nextTimestamp(currentTimestamp: string, clock: Clock): string {
  return new Date(
    Math.max(clock().getTime(), Date.parse(currentTimestamp) + 1),
  ).toISOString();
}

function manifestMatches(
  manifest: ControllerRunManifest,
  input: {
    work_item_id: string;
    run_id: string;
    idempotency_key: string;
    phase: WorkItemPhase;
    goal_version: number;
    input_revision: number;
    attempt: number;
  },
): boolean {
  return (
    manifest.outcome === "applied" &&
    manifest.work_item_id === input.work_item_id &&
    manifest.run_id === input.run_id &&
    manifest.idempotency_key === input.idempotency_key &&
    manifest.phase === input.phase &&
    manifest.goal_version === input.goal_version &&
    manifest.input_revision === input.input_revision &&
    manifest.attempt === input.attempt
  );
}

function goalMatchesSaveInput(
  goal: WorkItem["goal"],
  input: SaveWorkItemInput,
  goalVersion: number,
): boolean {
  const contract = goal.goal_contract;
  return (
    goal.title === input.title &&
    goal.type === (input.type ?? undefined) &&
    goal.priority === (input.priority ?? undefined) &&
    JSON.stringify(goal.tags ?? []) === JSON.stringify(input.tags) &&
    goal.notes === (input.notes ?? undefined) &&
    contract?.schema_version === 1 &&
    contract.goal_version === goalVersion &&
    contract.purpose === input.goal_contract?.purpose &&
    JSON.stringify(contract.acceptance_criteria) ===
      JSON.stringify(input.goal_contract?.acceptance_criteria) &&
    JSON.stringify(contract.non_goals) ===
      JSON.stringify(input.goal_contract?.non_goals) &&
    JSON.stringify(contract.allowed_scope) ===
      JSON.stringify(input.goal_contract?.allowed_scope) &&
    JSON.stringify(contract.review_ready) ===
      JSON.stringify(input.goal_contract?.review_ready)
  );
}

export class WorkItemController {
  constructor(
    private readonly repository: ControllerWorkItemRepository,
    private readonly clock: Clock,
    private readonly git: GitVerificationAdapter,
    private readonly verificationRunner: VerificationRunner,
  ) {}

  async saveWorkItem(
    workItemId: string,
    input: SaveWorkItemInput,
  ): Promise<ControllerMutationResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = saveWorkItemInputSchema.parse(input);
    const preLockItem = await this.repository.read(validatedId);
    if (preLockItem === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }
    const contractInput = validatedInput.goal_contract;
    if (contractInput === undefined) {
      throw this.conflict(
        "contract_required",
        validatedId,
        "Controller saves require a goal contract.",
      );
    }

    const nextGoalVersion =
      validatedInput.expected_goal_version === undefined
        ? 1
        : this.incrementVersion(
            validatedInput.expected_goal_version,
            validatedId,
            "goal_version",
          );
    const nextInputRevision =
      validatedInput.expected_input_revision === undefined
        ? 1
        : this.incrementVersion(
            validatedInput.expected_input_revision,
            validatedId,
            "input_revision",
          );
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      preLockItem.state.phase,
      nextGoalVersion,
      nextInputRevision,
      0,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "save_work_item", input: validatedInput }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      if (!canUpdateGoalContract(lease.work_item.state.phase)) {
        throw this.conflict(
          "goal_contract_locked",
          validatedId,
          `Goal contracts are locked after entering ${lease.work_item.state.phase}.`,
        );
      }
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: lease.work_item.state.phase,
        goal_version: nextGoalVersion,
        input_revision: nextInputRevision,
        attempt: 0,
      };
      if (existing !== null) {
        if (
          manifestMatches(existing, manifestIdentity) &&
          goalMatchesSaveInput(
            lease.work_item.goal,
            validatedInput,
            nextGoalVersion,
          ) &&
          lease.work_item.state.goal_version === nextGoalVersion &&
          lease.work_item.state.input_revision === nextInputRevision &&
          lease.work_item.state.attempt === 0
        ) {
          return { work_item: lease.work_item, manifest: existing };
        }
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Run ${runId} already has a non-matching durable manifest.`,
        );
      }

      this.validateSaveExpectations(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      if (lease.work_item.state.phase !== preLockItem.state.phase) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "Work-item phase changed while the save was acquiring its lease.",
        );
      }

      const nextItem = workItemSchema.parse({
        goal: {
          schema_version: 2,
          work_item_id: lease.work_item.goal.work_item_id,
          title: validatedInput.title,
          ...(validatedInput.type === null
            ? {}
            : { type: validatedInput.type }),
          ...(lease.work_item.goal.capture === undefined
            ? {}
            : { capture: lease.work_item.goal.capture }),
          ...(validatedInput.priority === null
            ? {}
            : { priority: validatedInput.priority }),
          ...(validatedInput.tags.length === 0
            ? {}
            : { tags: validatedInput.tags }),
          ...(validatedInput.notes === null
            ? {}
            : { notes: validatedInput.notes }),
          goal_contract: {
            schema_version: 1,
            goal_version: nextGoalVersion,
            purpose: contractInput.purpose,
            acceptance_criteria: contractInput.acceptance_criteria,
            non_goals: contractInput.non_goals,
            allowed_scope: contractInput.allowed_scope,
            review_ready: contractInput.review_ready,
          },
        },
        state: {
          ...lease.work_item.state,
          goal_version: nextGoalVersion,
          input_revision: nextInputRevision,
          attempt: 0,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const manifest = this.pendingManifest(
        manifestIdentity,
        activeRun.acquired_at,
      );

      return await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest,
      });
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async transition(
    workItemId: string,
    input: ControllerTransitionInput,
  ): Promise<ControllerMutationResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = controllerTransitionInputSchema.parse(input);
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      validatedInput.target_phase,
      validatedInput.expected_goal_version,
      validatedInput.expected_input_revision,
      validatedInput.attempt,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "transition", input: validatedInput }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: validatedInput.target_phase,
        goal_version: validatedInput.expected_goal_version,
        input_revision: validatedInput.expected_input_revision,
        attempt: validatedInput.attempt,
      };
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (existing !== null) {
        if (
          manifestMatches(existing, manifestIdentity) &&
          lease.work_item.state.phase === validatedInput.target_phase &&
          lease.work_item.state.status === validatedInput.target_status &&
          lease.work_item.state.goal_version ===
            validatedInput.expected_goal_version &&
          lease.work_item.state.input_revision ===
            validatedInput.expected_input_revision &&
          lease.work_item.state.attempt === validatedInput.attempt
        ) {
          return { work_item: lease.work_item, manifest: existing };
        }
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Run ${runId} already has a non-matching durable result.`,
        );
      }

      this.validateTransitionExpectations(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      const transition = validateWorkItemTransition(
        lease.work_item.state.phase,
        validatedInput.target_phase,
        lease.work_item.state.status,
        validatedInput.target_status,
      );
      if (!transition.ok) {
        throw this.conflict(
          "invalid_transition",
          validatedId,
          transition.reason,
        );
      }

      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          phase: validatedInput.target_phase,
          status: validatedInput.target_status,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const manifest = this.pendingManifest(
        manifestIdentity,
        activeRun.acquired_at,
      );

      return await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest,
      });
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  async importExternalResult(
    workItemId: string,
    input: ImportExternalResultInput,
  ): Promise<ImportExternalResultResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = importExternalResultInputSchema.parse(input);
    const repository = this.repository;
    const identity = {
      phase: "execute" as const,
      work_item_id: validatedId,
      goal_version: validatedInput.expected_goal_version,
      input_revision: validatedInput.expected_input_revision,
      attempt: validatedInput.attempt,
    };
    const snapshot = await repository.readMissionResult(identity);
    const resultContentSha256 = hashResultContent(snapshot.result_source);
    const importRunId = createImportRunId(
      snapshot.mission.content_sha256,
      resultContentSha256,
    );
    const idempotencyKey = [
      deriveControllerIdempotencyKey(
        validatedId,
        "execute",
        identity.goal_version,
        identity.input_revision,
        identity.attempt,
      ),
      "import",
      resultContentSha256,
    ].join(":");
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "import_external_result", importRunId }),
    );
    const storedEvidence = await repository.readImportEvidence(
      identity,
      importRunId,
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await repository.acquireControllerLease(validatedId, activeRun);
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const existingManifest = await repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (storedEvidence !== null) {
        return await this.reconcileStoredImport(
          repository,
          lease,
          existingManifest,
          storedEvidence,
          validatedInput,
          activeRun,
          idempotencyKey,
        );
      }
      if (existingManifest !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Import run ${runId} has a controller manifest but no immutable evidence.`,
        );
      }

      this.validateExecuteExpectation(
        validatedId,
        lease.work_item,
        validatedInput,
      );

      const manifest = await repository.readManifest();
      const assessment = await this.assessExternalResult(
        snapshot,
        identity,
        manifest,
      );
      const targetPhase: WorkItemPhase =
        assessment.outcome === "applied" ? "review" : "execute";
      const targetStatus: WorkItemStatus =
        assessment.outcome === "applied" ? "active" : "blocked";
      const transition = validateWorkItemTransition(
        lease.work_item.state.phase,
        targetPhase,
        lease.work_item.state.status,
        targetStatus,
      );
      if (!transition.ok) {
        throw this.conflict(
          "invalid_transition",
          validatedId,
          transition.reason,
        );
      }

      const completedAt = nextTimestamp(activeRun.acquired_at, this.clock);
      const evidence = importEvidenceEnvelopeSchema.parse({
        schema_version: 2,
        phase: "execute",
        import_run_id: importRunId,
        result_content_sha256: resultContentSha256,
        mission_content_sha256: snapshot.mission.content_sha256,
        identity,
        git_base_commit: snapshot.mission.source_revision.git_base_commit,
        result_commit: assessment.result?.commit ?? null,
        controller_run_id: runId,
        started_at: activeRun.acquired_at,
        completed_at: completedAt,
        outcome: assessment.outcome,
        reasons: assessment.reasons,
      });
      const evidenceSummary = await repository.writeImportEvidence({
        submission_source: snapshot.result_source,
        evidence,
        verification: assessment.verification,
      });
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          phase: targetPhase,
          status: targetStatus,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const pendingManifest = this.pendingManifest(
        {
          work_item_id: validatedId,
          run_id: runId,
          idempotency_key: idempotencyKey,
          phase: targetPhase,
          goal_version: identity.goal_version,
          input_revision: identity.input_revision,
          attempt: identity.attempt,
        },
        activeRun.acquired_at,
      );
      const mutation = await repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest: pendingManifest,
      });

      return { ...mutation, evidence: evidenceSummary };
    } finally {
      await repository.releaseControllerLease(lease);
    }
  }

  async importReviewResult(
    workItemId: string,
    input: ImportReviewResultInput,
  ): Promise<ImportReviewResultResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = importReviewResultInputSchema.parse(input);
    const repository = this.repository;
    const identity = {
      phase: "review" as const,
      work_item_id: validatedId,
      goal_version: validatedInput.expected_goal_version,
      input_revision: validatedInput.expected_input_revision,
      attempt: validatedInput.attempt,
    };
    const snapshot = await repository.readMissionResult(identity);
    if (!("review_subject" in snapshot.mission)) {
      throw this.conflict(
        "mission_not_ready",
        validatedId,
        "Review result import requires an immutable review mission.",
      );
    }
    const resultContentSha256 = hashResultContent(snapshot.result_source);
    const importRunId = createImportRunId(
      snapshot.mission.content_sha256,
      resultContentSha256,
    );
    const idempotencyKey = [
      deriveControllerIdempotencyKey(
        validatedId,
        "review",
        identity.goal_version,
        identity.input_revision,
        identity.attempt,
      ),
      "import",
      resultContentSha256,
    ].join(":");
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "import_review_result", importRunId }),
    );
    const storedEvidence = await repository.readImportEvidence(
      identity,
      importRunId,
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await repository.acquireControllerLease(validatedId, activeRun);
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const existingManifest = await repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (storedEvidence !== null) {
        return await this.reconcileStoredReviewImport(
          repository,
          lease,
          existingManifest,
          storedEvidence,
          validatedInput,
          activeRun,
          idempotencyKey,
          snapshot,
        );
      }
      if (existingManifest !== null) {
        throw this.conflict(
          "repair_required",
          validatedId,
          `Review import run ${runId} has a controller manifest but no immutable evidence.`,
        );
      }

      this.validateReviewExpectation(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      const executeSubject = await repository.readAppliedExecuteReviewSubject({
        ...identity,
        phase: "execute",
      });
      const assessment = await this.assessReviewResult(
        snapshot,
        identity,
        executeSubject.review_subject,
      );
      const completedAt = nextTimestamp(activeRun.acquired_at, this.clock);
      const evidence = importEvidenceEnvelopeSchema.parse({
        schema_version: 2,
        phase: "review",
        import_run_id: importRunId,
        result_content_sha256: resultContentSha256,
        mission_content_sha256: snapshot.mission.content_sha256,
        identity,
        git_base_commit: snapshot.mission.review_subject.git_base_commit,
        result_commit:
          snapshot.mission.review_subject.accepted_result_commit,
        controller_run_id: runId,
        started_at: activeRun.acquired_at,
        completed_at: completedAt,
        outcome: assessment.outcome,
        reasons: assessment.reasons,
      });
      const evidenceSummary = await repository.writeImportEvidence({
        submission_source: snapshot.result_source,
        evidence,
        verification: [],
      });
      if (assessment.outcome === "rejected") {
        return {
          work_item: lease.work_item,
          manifest: null,
          evidence: evidenceSummary,
          ...(assessment.result === undefined
            ? {}
            : { result: assessment.result }),
        };
      }

      const pendingManifest = this.pendingManifest(
        {
          work_item_id: validatedId,
          run_id: runId,
          idempotency_key: idempotencyKey,
          phase: "review",
          goal_version: identity.goal_version,
          input_revision: identity.input_revision,
          attempt: identity.attempt,
        },
        activeRun.acquired_at,
      );
      const mutation = await repository.commitControllerMutation(lease, {
        goal: lease.work_item.goal,
        state: lease.work_item.state,
        manifest: pendingManifest,
      });
      return {
        ...mutation,
        evidence: evidenceSummary,
        result: assessment.result,
      };
    } finally {
      await repository.releaseControllerLease(lease);
    }
  }

  async retryExecuteAttempt(
    workItemId: string,
    input: RetryExecuteAttemptInput,
  ): Promise<ControllerMutationResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = retryExecuteAttemptInputSchema.parse(input);
    const nextAttempt = this.incrementVersion(
      validatedInput.attempt,
      validatedId,
      "attempt",
    );
    const idempotencyKey = deriveControllerIdempotencyKey(
      validatedId,
      "execute",
      validatedInput.expected_goal_version,
      validatedInput.expected_input_revision,
      nextAttempt,
    );
    const runId = deriveControllerRunId(
      idempotencyKey,
      JSON.stringify({ operation: "retry_execute_attempt", input: validatedInput }),
    );
    const activeRun = this.activeRun(runId, idempotencyKey);
    const lease = await this.repository.acquireControllerLease(
      validatedId,
      activeRun,
    );
    if (lease === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
      );
    }

    try {
      const manifestIdentity = {
        work_item_id: validatedId,
        run_id: runId,
        idempotency_key: idempotencyKey,
        phase: "execute" as const,
        goal_version: validatedInput.expected_goal_version,
        input_revision: validatedInput.expected_input_revision,
        attempt: nextAttempt,
      };
      const existing = await this.repository.readControllerRunManifest(
        validatedId,
        runId,
      );
      if (existing !== null) {
        if (
          manifestMatches(existing, manifestIdentity) &&
          lease.work_item.state.phase === "execute" &&
          lease.work_item.state.status === "active" &&
          lease.work_item.state.goal_version ===
            validatedInput.expected_goal_version &&
          lease.work_item.state.input_revision ===
            validatedInput.expected_input_revision &&
          lease.work_item.state.attempt === nextAttempt
        ) {
          return { work_item: lease.work_item, manifest: existing };
        }
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Run ${runId} already has a non-matching durable result.`,
        );
      }

      this.validateExecuteExpectation(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      const nextItem = workItemSchema.parse({
        goal: lease.work_item.goal,
        state: {
          ...lease.work_item.state,
          status: "active",
          attempt: nextAttempt,
          updated_at: nextTimestamp(
            lease.work_item.state.updated_at,
            this.clock,
          ),
        },
      });
      const manifest = this.pendingManifest(
        manifestIdentity,
        activeRun.acquired_at,
      );
      return await this.repository.commitControllerMutation(lease, {
        goal: nextItem.goal,
        state: nextItem.state,
        manifest,
      });
    } finally {
      await this.repository.releaseControllerLease(lease);
    }
  }

  private async assessReviewResult(
    snapshot: MissionResultSnapshot,
    identity: ReviewExternalResultSubmission["identity"],
    currentSubject: ExecuteReviewSubject,
  ): Promise<ReviewResultAssessment> {
    const mission = snapshot.mission;
    if (!("review_subject" in mission)) {
      return {
        outcome: "rejected",
        reasons: ["Mission snapshot is not a review mission."],
      };
    }

    const reasons: string[] = [];
    if (JSON.stringify(mission.identity) !== JSON.stringify(identity)) {
      reasons.push("Review mission identity does not match the requested governed tuple.");
    }
    if (mission.result_contract.output_path !== snapshot.result_path) {
      reasons.push("Review result path does not match the immutable snapshot path.");
    }
    if (
      JSON.stringify(mission.review_subject) !== JSON.stringify(currentSubject)
    ) {
      reasons.push("Review mission subject is stale or does not match applied execute evidence.");
    }
    if (mission.review_subject.source !== "execute") {
      return {
        outcome: "rejected",
        reasons: [
          ...reasons,
          "Patch-subject review assessment is not available before the patch controller slice.",
        ],
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(snapshot.result_source);
    } catch {
      return {
        outcome: "rejected",
        reasons: [...reasons, "result.json is not valid JSON."],
      };
    }
    const parsedResult =
      executeReviewExternalResultSubmissionSchema.safeParse(parsedJson);
    if (!parsedResult.success) {
      return {
        outcome: "rejected",
        reasons: [
          ...reasons,
          ...parsedResult.error.issues.map(
            (issue) =>
              `result.json ${issue.path.map(String).join(".") || "value"}: ${issue.message}`,
          ),
        ],
      };
    }

    const result = parsedResult.data;
    if (result.review_mission_content_sha256 !== mission.content_sha256) {
      reasons.push("Review result mission hash does not match the immutable review mission.");
    }
    if (JSON.stringify(result.identity) !== JSON.stringify(identity)) {
      reasons.push("Review result identity does not match the requested governed tuple.");
    }
    const subjectBindings = {
      execute_mission_content_sha256:
        mission.review_subject.execute_mission_content_sha256,
      execute_result_content_sha256:
        mission.review_subject.execute_result_content_sha256,
      git_base_commit: mission.review_subject.git_base_commit,
      accepted_result_commit: mission.review_subject.accepted_result_commit,
    };
    for (const [field, expected] of Object.entries(subjectBindings)) {
      if (result[field as keyof typeof subjectBindings] !== expected) {
        reasons.push(`Review result ${field} does not match the immutable subject.`);
      }
    }
    const deterministicChecks = new Set(
      mission.review_subject.command_evidence.map((record) =>
        record.argv.join(" "),
      ),
    );
    for (const finding of result.findings) {
      switch (finding.link.type) {
        case "acceptance_criteria":
          if (
            !mission.goal.acceptance_criteria.includes(finding.link.criterion)
          ) {
            reasons.push(
              `Review finding ${finding.finding_id} does not name an exact pinned acceptance criterion.`,
            );
          }
          break;
        case "non_goals":
          if (!mission.goal.non_goals.includes(finding.link.non_goal)) {
            reasons.push(
              `Review finding ${finding.finding_id} does not name an exact pinned non-goal.`,
            );
          }
          break;
        case "deterministic_checks":
          if (!deterministicChecks.has(finding.link.command)) {
            reasons.push(
              `Review finding ${finding.finding_id} does not name an exact pinned deterministic check.`,
            );
          }
          break;
        case "defect":
        case "security":
          break;
      }
    }
    if (
      (await this.git.readHeadCommit()) !==
      currentSubject.accepted_result_commit
    ) {
      reasons.push("Workspace HEAD no longer equals the accepted execute commit.");
    }
    if (!(await this.git.isWorktreeCleanExcludingFounder())) {
      reasons.push("Workspace has uncommitted changes outside .founder/.");
    }

    return reasons.length === 0
      ? { outcome: "applied", reasons: [], result }
      : { outcome: "rejected", reasons, result };
  }

  private async assessExternalResult(
    snapshot: MissionResultSnapshot,
    identity: ExecuteExternalResultSubmission["identity"],
    manifest: ProductManifest,
  ): Promise<ExternalResultAssessment> {
    const reasons: string[] = [];
    if (JSON.stringify(snapshot.mission.identity) !== JSON.stringify(identity)) {
      reasons.push("Mission identity does not match the requested governed tuple.");
    }
    if (snapshot.mission.result_contract.output_path !== snapshot.result_path) {
      reasons.push("Mission result path does not match the immutable snapshot path.");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(snapshot.result_source);
    } catch {
      return {
        outcome: "rejected",
        reasons: [...reasons, "result.json is not valid JSON."],
        verification: [],
      };
    }
    const parsedResult =
      executeExternalResultSubmissionSchema.safeParse(parsedJson);
    if (!parsedResult.success) {
      return {
        outcome: "rejected",
        reasons: [
          ...reasons,
          ...parsedResult.error.issues.map(
            (issue) =>
              `result.json ${issue.path.map(String).join(".") || "value"}: ${issue.message}`,
          ),
        ],
        verification: [],
      };
    }
    const result = parsedResult.data;
    if (result.mission_content_sha256 !== snapshot.mission.content_sha256) {
      reasons.push("Result mission hash does not match the immutable mission.");
    }
    if (JSON.stringify(result.identity) !== JSON.stringify(identity)) {
      reasons.push("Result identity does not match the requested governed tuple.");
    }
    if (reasons.length === 0) {
      reasons.push(...(await this.validateGitProof(snapshot, result)));
    }
    if (reasons.length > 0) {
      return { outcome: "rejected", reasons, result, verification: [] };
    }

    const verification: CommandEvidenceRecord[] = [];
    for (
      let index = 0;
      index < manifest.verification.required_commands.length;
      index += 1
    ) {
      const command = manifest.verification.required_commands[index];
      let record: CommandEvidenceRecord;
      try {
        record = commandEvidenceRecordSchema.parse(
          await this.verificationRunner.run(command),
        );
        if (
          record.name !== command.name ||
          JSON.stringify(record.argv) !== JSON.stringify(command.argv)
        ) {
          throw new Error(
            "verification runner returned evidence for a different command",
          );
        }
      } catch (error) {
        const startedAt = this.clock().toISOString();
        record = commandEvidenceRecordSchema.parse({
          name: command.name,
          argv: command.argv,
          started_at: startedAt,
          completed_at: nextTimestamp(startedAt, this.clock),
          duration_ms: 0,
          status: "spawn_error",
          exit_code: null,
          signal: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          output_truncated: false,
        });
      }
      verification.push(record);
      if (record.status !== "passed") {
        reasons.push(
          `Required verification command ${command.name} ended with ${record.status}.`,
        );
        for (
          let remaining = index + 1;
          remaining < manifest.verification.required_commands.length;
          remaining += 1
        ) {
          verification.push(
            this.notRunEvidence(
              manifest.verification.required_commands[remaining],
            ),
          );
        }
        break;
      }
    }

    return reasons.length === 0
      ? { outcome: "applied", reasons: [], result, verification }
      : { outcome: "failed", reasons, result, verification };
  }

  private async validateGitProof(
    snapshot: MissionResultSnapshot,
    result: ExecuteExternalResultSubmission,
  ): Promise<string[]> {
    const resolvedCommit = await this.git.resolveCommit(result.commit);
    if (resolvedCommit === null || resolvedCommit !== result.commit) {
      return ["Result commit is not a canonical local commit object."];
    }
    const baseCommit = snapshot.mission.source_revision.git_base_commit;
    if (!(await this.git.isAncestor(baseCommit, resolvedCommit))) {
      return ["Mission Git base is not an ancestor of the result commit."];
    }
    if ((await this.git.readHeadCommit()) !== resolvedCommit) {
      return ["Workspace HEAD does not equal the submitted result commit."];
    }
    if (!(await this.git.isWorktreeCleanExcludingFounder())) {
      return ["Workspace has uncommitted changes outside .founder/."];
    }

    const changedFiles = await this.git.listChangedFiles(
      baseCommit,
      resolvedCommit,
    );
    if (changedFiles.length === 0) {
      return ["Git reports no changed files for the result commit."];
    }
    for (const path of changedFiles) {
      if (!workspaceRelativePosixPathSchema.safeParse(path).success) {
        return [`Git reported an unsafe changed path: ${path}`];
      }
      if (path === ".founder" || path.startsWith(".founder/")) {
        return [`Controller-owned path is outside external result scope: ${path}`];
      }
      if (
        !snapshot.mission.goal.allowed_scope.some((scopeEntry) =>
          scopeMatchesPath(scopeEntry, path),
        )
      ) {
        return [`Changed path is outside allowed_scope: ${path}`];
      }
    }
    const canonicalGitFiles = [...changedFiles].sort();
    const canonicalReportedFiles = [...result.changed_files].sort();
    if (
      JSON.stringify(canonicalGitFiles) !==
      JSON.stringify(canonicalReportedFiles)
    ) {
      return ["Result changed_files do not exactly match the Git diff."];
    }
    return [];
  }

  private async reconcileStoredReviewImport(
    repository: ControllerWorkItemRepository,
    lease: ControllerLease,
    existingManifest: ControllerRunManifest | null,
    stored: StoredImportEvidence,
    input: ImportReviewResultInput,
    activeRun: ActiveRun,
    idempotencyKey: string,
    snapshot: MissionResultSnapshot,
  ): Promise<ImportReviewResultResult> {
    const workItemId = lease.work_item.goal.work_item_id;
    const identity = {
      phase: "review" as const,
      work_item_id: workItemId,
      goal_version: input.expected_goal_version,
      input_revision: input.expected_input_revision,
      attempt: input.attempt,
    };
    if (!("review_subject" in snapshot.mission)) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Stored review evidence is not backed by a review mission snapshot.",
      );
    }
    if (
      stored.evidence.phase !== "review" ||
      stored.evidence.controller_run_id !== activeRun.run_id ||
      JSON.stringify(stored.evidence.identity) !== JSON.stringify(identity) ||
      stored.evidence.mission_content_sha256 !==
        snapshot.mission.content_sha256 ||
      stored.evidence.result_content_sha256 !==
        hashResultContent(snapshot.result_source) ||
      stored.evidence.git_base_commit !==
        snapshot.mission.review_subject.git_base_commit ||
      stored.evidence.result_commit !==
        snapshot.mission.review_subject.accepted_result_commit ||
      stored.summary.import_run_id !== stored.evidence.import_run_id ||
      stored.summary.phase !== "review" ||
      stored.summary.outcome !== stored.evidence.outcome ||
      JSON.stringify(stored.summary.reasons) !==
        JSON.stringify(stored.evidence.reasons) ||
      stored.verification.length !== 0
    ) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Stored review import evidence does not match its controller run or summary.",
      );
    }
    this.validateReviewExpectation(workItemId, lease.work_item, input);

    let result: ExecuteReviewExternalResultSubmission | undefined;
    try {
      const parsed = executeReviewExternalResultSubmissionSchema.safeParse(
        JSON.parse(snapshot.result_source),
      );
      result = parsed.success ? parsed.data : undefined;
    } catch {
      result = undefined;
    }

    if (stored.evidence.outcome === "rejected") {
      if (existingManifest !== null) {
        throw this.conflict(
          "idempotency_conflict",
          workItemId,
          `Rejected review run ${activeRun.run_id} must not have a controller manifest.`,
        );
      }
      return {
        work_item: lease.work_item,
        manifest: null,
        evidence: stored.summary,
        ...(result === undefined ? {} : { result }),
      };
    }

    const manifestIdentity = {
      work_item_id: workItemId,
      run_id: activeRun.run_id,
      idempotency_key: idempotencyKey,
      phase: "review" as const,
      goal_version: input.expected_goal_version,
      input_revision: input.expected_input_revision,
      attempt: input.attempt,
    };
    if (existingManifest !== null) {
      if (manifestMatches(existingManifest, manifestIdentity)) {
        return {
          work_item: lease.work_item,
          manifest: existingManifest,
          evidence: stored.summary,
          ...(result === undefined ? {} : { result }),
        };
      }
      throw this.conflict(
        "idempotency_conflict",
        workItemId,
        `Review run ${activeRun.run_id} already has a non-matching durable result.`,
      );
    }

    const executeSubject = await repository.readAppliedExecuteReviewSubject({
      ...identity,
      phase: "execute",
    });
    const assessment = await this.assessReviewResult(
      snapshot,
      identity,
      executeSubject.review_subject,
    );
    if (assessment.outcome !== "applied") {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Applied review evidence no longer validates for state-preserving recovery.",
      );
    }

    const mutation = await repository.commitControllerMutation(lease, {
      goal: lease.work_item.goal,
      state: lease.work_item.state,
      manifest: this.pendingManifest(manifestIdentity, activeRun.acquired_at),
    });
    return {
      ...mutation,
      evidence: stored.summary,
      result: assessment.result,
    };
  }

  private async reconcileStoredImport(
    repository: ControllerWorkItemRepository,
    lease: ControllerLease,
    existingManifest: ControllerRunManifest | null,
    stored: StoredImportEvidence,
    input: ImportExternalResultInput,
    activeRun: ActiveRun,
    idempotencyKey: string,
  ): Promise<ImportExternalResultResult> {
    const workItemId = lease.work_item.goal.work_item_id;
    if (
      stored.evidence.controller_run_id !== activeRun.run_id ||
      JSON.stringify(stored.evidence.identity) !==
        JSON.stringify({
          phase: "execute",
          work_item_id: workItemId,
          goal_version: input.expected_goal_version,
          input_revision: input.expected_input_revision,
          attempt: input.attempt,
        }) ||
      stored.summary.import_run_id !== stored.evidence.import_run_id ||
      stored.summary.phase !== stored.evidence.phase ||
      stored.summary.outcome !== stored.evidence.outcome ||
      JSON.stringify(stored.summary.reasons) !==
        JSON.stringify(stored.evidence.reasons)
    ) {
      throw this.conflict(
        "repair_required",
        workItemId,
        "Stored import evidence does not match its controller run or summary.",
      );
    }
    const outcome = stored.evidence.outcome;
    const targetPhase: WorkItemPhase =
      outcome === "applied" ? "review" : "execute";
    const targetStatus: WorkItemStatus =
      outcome === "applied" ? "active" : "blocked";
    const manifestIdentity = {
      work_item_id: workItemId,
      run_id: activeRun.run_id,
      idempotency_key: idempotencyKey,
      phase: targetPhase,
      goal_version: input.expected_goal_version,
      input_revision: input.expected_input_revision,
      attempt: input.attempt,
    };
    const isTargetState =
      lease.work_item.state.phase === targetPhase &&
      lease.work_item.state.status === targetStatus &&
      lease.work_item.state.goal_version === input.expected_goal_version &&
      lease.work_item.state.input_revision === input.expected_input_revision &&
      lease.work_item.state.attempt === input.attempt;
    if (existingManifest !== null) {
      if (manifestMatches(existingManifest, manifestIdentity) && isTargetState) {
        return {
          work_item: lease.work_item,
          manifest: existingManifest,
          evidence: stored.summary,
        };
      }
      throw this.conflict(
        "idempotency_conflict",
        workItemId,
        `Run ${activeRun.run_id} already has a non-matching durable result.`,
      );
    }
    if (!isTargetState) {
      this.validateExecuteExpectation(workItemId, lease.work_item, input);
    }

    const nextItem = workItemSchema.parse({
      goal: lease.work_item.goal,
      state: {
        ...lease.work_item.state,
        phase: targetPhase,
        status: targetStatus,
        updated_at: isTargetState
          ? lease.work_item.state.updated_at
          : nextTimestamp(lease.work_item.state.updated_at, this.clock),
      },
    });
    const mutation = await repository.commitControllerMutation(lease, {
      goal: nextItem.goal,
      state: nextItem.state,
      manifest: this.pendingManifest(
        manifestIdentity,
        activeRun.acquired_at,
      ),
    });
    return { ...mutation, evidence: stored.summary };
  }

  private notRunEvidence(
    command: ProductManifest["verification"]["required_commands"][number],
  ): CommandEvidenceRecord {
    return commandEvidenceRecordSchema.parse({
      name: command.name,
      argv: command.argv,
      started_at: null,
      completed_at: null,
      duration_ms: 0,
      status: "not_run",
      exit_code: null,
      signal: null,
      stdout: "",
      stderr: "",
      output_truncated: false,
    });
  }

  private validateExecuteExpectation(
    workItemId: string,
    current: WorkItem,
    input: ImportExternalResultInput | RetryExecuteAttemptInput,
  ): void {
    if (current.goal.goal_contract === undefined) {
      throw this.conflict(
        "contract_required",
        workItemId,
        "External result operations require an active goal contract.",
      );
    }
    if (
      current.state.phase !== input.expected_phase ||
      current.state.status !== input.expected_status ||
      current.state.schema_version !== input.expected_schema_version ||
      current.state.goal_version !== input.expected_goal_version ||
      current.state.input_revision !== input.expected_input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "External result expectations do not match durable state.",
      );
    }
    if (current.state.attempt !== input.attempt) {
      throw this.conflict(
        "attempt_conflict",
        workItemId,
        `Expected attempt ${input.attempt} but found ${current.state.attempt}.`,
      );
    }
  }

  private validateReviewExpectation(
    workItemId: string,
    current: WorkItem,
    input: ImportReviewResultInput,
  ): void {
    if (current.goal.goal_contract === undefined) {
      throw this.conflict(
        "contract_required",
        workItemId,
        "Review result import requires an active goal contract.",
      );
    }
    if (
      current.state.phase !== input.expected_phase ||
      current.state.status !== input.expected_status ||
      current.state.schema_version !== input.expected_schema_version ||
      current.state.goal_version !== input.expected_goal_version ||
      current.state.input_revision !== input.expected_input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Review result expectations do not match durable state.",
      );
    }
    if (current.state.attempt !== input.attempt) {
      throw this.conflict(
        "attempt_conflict",
        workItemId,
        `Expected attempt ${input.attempt} but found ${current.state.attempt}.`,
      );
    }
  }

  private activeRun(runId: string, idempotencyKey: string): ActiveRun {
    return {
      run_id: runId,
      idempotency_key: idempotencyKey,
      acquired_at: this.clock().toISOString(),
    };
  }

  private pendingManifest(
    identity: Omit<
      ControllerRunManifest,
      "schema_version" | "started_at" | "completed_at" | "outcome"
    >,
    startedAt: string,
  ): ControllerRunManifest {
    return controllerRunManifestSchema.parse({
      schema_version: 1,
      ...identity,
      started_at: startedAt,
      outcome: "pending",
    });
  }

  private validateSaveExpectations(
    workItemId: string,
    current: WorkItem,
    input: SaveWorkItemInput,
  ): void {
    const currentGoalVersion = current.goal.goal_contract?.goal_version;
    if (currentGoalVersion === undefined) {
      if (
        input.expected_goal_version !== undefined ||
        input.expected_input_revision !== undefined
      ) {
        throw this.conflict(
          "stale_expectation",
          workItemId,
          "First contract activation requires absent expected versions.",
        );
      }
      return;
    }

    if (
      input.expected_goal_version === undefined ||
      input.expected_input_revision === undefined ||
      input.expected_goal_version !== currentGoalVersion ||
      input.expected_input_revision !== current.state.input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        `Expected goal/input versions ${String(input.expected_goal_version)}/${String(input.expected_input_revision)} but found ${currentGoalVersion}/${current.state.input_revision}.`,
      );
    }
  }

  private validateTransitionExpectations(
    workItemId: string,
    current: WorkItem,
    input: ControllerTransitionInput,
  ): void {
    if (current.goal.goal_contract === undefined) {
      throw this.conflict(
        "contract_required",
        workItemId,
        "Controller transitions require an active goal contract.",
      );
    }
    if (
      current.state.phase !== input.expected_phase ||
      current.state.status !== input.expected_status ||
      current.state.schema_version !== input.expected_schema_version ||
      current.state.goal_version !== input.expected_goal_version ||
      current.state.input_revision !== input.expected_input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        "Controller transition expectations do not match durable state.",
      );
    }
    if (current.state.attempt !== input.attempt) {
      throw this.conflict(
        "attempt_conflict",
        workItemId,
        `Expected attempt ${input.attempt} but found ${current.state.attempt}.`,
      );
    }
  }

  private incrementVersion(
    version: number,
    workItemId: string,
    field: string,
  ): number {
    const nextVersion = version + 1;
    if (!Number.isSafeInteger(nextVersion)) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        `${field} cannot be incremented beyond the safe-integer range.`,
      );
    }
    return nextVersion;
  }

  private conflict(
    kind: ConstructorParameters<typeof ControllerConflictError>[0],
    workItemId: string,
    reason: string,
  ): ControllerConflictError {
    return new ControllerConflictError(kind, workItemId, reason);
  }
}
