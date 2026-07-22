import { createHash } from "node:crypto";

import {
  ControllerConflictError,
  controllerRunManifestSchema,
  controllerTransitionInputSchema,
  goalContractUpdateInputSchema,
  workItemIdSchema,
  workItemSchema,
  type ActiveRun,
  type ControllerMutationResult,
  type ControllerRunManifest,
  type ControllerTransitionInput,
  type ControllerWorkItemRepository,
  type GoalContractUpdateInput,
  type WorkItem,
  type WorkItemPhase,
} from "../domain/work-item";
import { validateWorkItemTransition } from "../domain/workflow-policy";

type Clock = () => Date;

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

export class WorkItemController {
  constructor(
    private readonly repository: ControllerWorkItemRepository,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async updateGoalContract(
    workItemId: string,
    input: GoalContractUpdateInput,
  ): Promise<ControllerMutationResult> {
    const validatedId = workItemIdSchema.parse(workItemId);
    const validatedInput = goalContractUpdateInputSchema.parse(input);
    const preLockItem = await this.repository.read(validatedId);
    if (preLockItem === null) {
      throw this.conflict(
        "work_item_not_found",
        validatedId,
        `Work item ${validatedId} was not found.`,
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
      JSON.stringify({ operation: "goal_contract", input: validatedInput }),
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
          lease.work_item.goal.goal_version === nextGoalVersion &&
          lease.work_item.state.goal_version === nextGoalVersion &&
          lease.work_item.state.input_revision === nextInputRevision &&
          lease.work_item.state.attempt === 0 &&
          JSON.stringify(lease.work_item.goal.acceptance_criteria) ===
            JSON.stringify(validatedInput.acceptance_criteria) &&
          JSON.stringify(lease.work_item.goal.allowed_scope) ===
            JSON.stringify(validatedInput.allowed_scope) &&
          JSON.stringify(lease.work_item.goal.review_ready) ===
            JSON.stringify(validatedInput.review_ready)
        ) {
          return { work_item: lease.work_item, manifest: existing };
        }
        throw this.conflict(
          "idempotency_conflict",
          validatedId,
          `Run ${runId} already has a non-matching durable manifest.`,
        );
      }

      this.validateGoalContractExpectations(
        validatedId,
        lease.work_item,
        validatedInput,
      );
      if (lease.work_item.state.phase !== preLockItem.state.phase) {
        throw this.conflict(
          "stale_expectation",
          validatedId,
          "Work-item phase changed while the contract update was acquiring its lease.",
        );
      }

      const nextItem = workItemSchema.parse({
        goal: {
          ...lease.work_item.goal,
          goal_version: nextGoalVersion,
          acceptance_criteria: validatedInput.acceptance_criteria,
          allowed_scope: validatedInput.allowed_scope,
          review_ready: validatedInput.review_ready,
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

  private validateGoalContractExpectations(
    workItemId: string,
    current: WorkItem,
    input: GoalContractUpdateInput,
  ): void {
    if (current.goal.goal_version === undefined) {
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
      input.expected_goal_version !== current.goal.goal_version ||
      input.expected_input_revision !== current.state.input_revision
    ) {
      throw this.conflict(
        "stale_expectation",
        workItemId,
        `Expected goal/input versions ${String(input.expected_goal_version)}/${String(input.expected_input_revision)} but found ${current.goal.goal_version}/${current.state.input_revision}.`,
      );
    }
  }

  private validateTransitionExpectations(
    workItemId: string,
    current: WorkItem,
    input: ControllerTransitionInput,
  ): void {
    if (current.goal.goal_version === undefined) {
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
