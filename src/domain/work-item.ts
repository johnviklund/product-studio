import { z } from "zod";

import type {
  MissionArtifactWriteResult,
  MissionIdentity,
  MissionPackageBuilder,
  ReviewMissionPackage,
} from "./mission";
import { portfolioSourceIdSchema } from "./portfolio-source";
import type {
  AppliedExecuteReviewSubject,
  ImportEvidenceSummary,
  ImportEvidenceWriteInput,
  MissionResultSnapshot,
  StoredImportEvidence,
} from "./result";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "./verification";
import { workspaceRelativePosixPathSchema } from "./workspace-path";

export const WORK_ITEM_TYPES = [
  "Explore",
  "Prototype",
  "MVP",
  "Feature",
  "Fix",
  "Maintenance",
  "Incident",
] as const;

export const WORK_ITEM_PHASES = [
  "idea",
  "brainstorm",
  "spec",
  "plan",
  "execute",
  "review",
  "test",
  "ship",
  "learn",
] as const;

export const WORK_ITEM_STATUSES = [
  "active",
  "paused",
  "blocked",
  "cancelled",
] as const;

export const CAPTURE_KINDS = ["idea", "todo"] as const;

export const WORK_ITEM_PRIORITIES = ["low", "normal", "high"] as const;

export const WORK_ITEM_ATTENTION_KINDS = [
  "spec_approval",
  "plan_approval",
  "patch_plan_approval",
  "ambiguous_goal",
  "cycle_limit",
  "missing_permission",
  "review_ready",
] as const;

export const CONTROLLER_RUN_OUTCOMES = [
  "pending",
  "applied",
  "rejected",
  "failed",
] as const;

export const CONTROLLER_CONFLICT_KINDS = [
  "work_item_not_found",
  "contract_required",
  "stale_expectation",
  "invalid_transition",
  "attempt_conflict",
  "lease_held",
  "repair_required",
  "idempotency_conflict",
  "contracted_details",
  "goal_contract_locked",
  "project_locked",
  "mission_not_ready",
] as const;

export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];
export type WorkItemPhase = (typeof WORK_ITEM_PHASES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];
export type WorkItemAttentionKind =
  (typeof WORK_ITEM_ATTENTION_KINDS)[number];
export type ControllerRunOutcome = (typeof CONTROLLER_RUN_OUTCOMES)[number];
export type ControllerConflictKind =
  (typeof CONTROLLER_CONFLICT_KINDS)[number];

export interface VerificationCommand {
  name: string;
  argv: [string, ...string[]];
  timeout_seconds: number;
}

export interface ProductManifest {
  schema_version: 2;
  product_name: string;
  verification: {
    required_commands: [VerificationCommand, ...VerificationCommand[]];
  };
}

export interface GoalContract {
  schema_version: 1;
  goal_version: number;
  purpose: string;
  acceptance_criteria: string[];
  non_goals: string[];
  allowed_scope: string[];
  review_ready: string[];
}

export interface WorkItemGoal {
  schema_version: 2;
  work_item_id: string;
  title: string;
  type?: WorkItemType;
  capture?: WorkItemCapture;
  priority?: WorkItemPriority;
  tags?: string[];
  notes?: string;
  goal_contract?: GoalContract;
}

export interface WorkItemCapture {
  kind: CaptureKind;
  original_title: string;
  captured_at: string;
}

export interface GovernedTuple {
  goal_version: number;
  input_revision: number;
  attempt: number;
  patch_cycle: number;
}

export interface WorkItemAttentionPins {
  artifact_paths: [string, ...string[]];
  evidence_paths: string[];
  git_commit?: string;
  mission_content_sha256?: string;
  result_content_sha256?: string;
}

interface WorkItemAttentionBase {
  question: string;
  recommendation: string;
  created_at: string;
  governed_tuple: GovernedTuple;
  pins: WorkItemAttentionPins;
}

export type WorkItemAttention = {
  [TKind in WorkItemAttentionKind]: WorkItemAttentionBase & { kind: TKind };
}[WorkItemAttentionKind];

export interface WorkItemState {
  schema_version: 2;
  work_item_id: string;
  phase: WorkItemPhase;
  status: WorkItemStatus;
  updated_at: string;
  goal_version?: number;
  input_revision?: number;
  attempt?: number;
  patch_cycle?: number;
  attention?: WorkItemAttention;
  active_run?: ActiveRun;
}

export interface ActiveRun {
  run_id: string;
  idempotency_key: string;
  acquired_at: string;
}

export interface WorkItem {
  goal: WorkItemGoal;
  state: WorkItemState;
}

export interface CreateWorkItemInput {
  title: string;
  type: WorkItemType;
}

export interface CreateCaptureInput {
  title: string;
  capture_kind: CaptureKind;
  source_id?: string;
  priority?: WorkItemPriority;
  tags?: string[];
  notes?: string;
}

export interface UpdateWorkItemPhaseInput {
  target_phase: WorkItemPhase;
}

export interface SaveWorkItemInput {
  target_source_id: string;
  title: string;
  type: WorkItemType | null;
  priority: WorkItemPriority | null;
  tags: string[];
  notes: string | null;
  goal_contract?: {
    purpose: string;
    acceptance_criteria: string[];
    non_goals: string[];
    allowed_scope: string[];
    review_ready: string[];
  };
  expected_goal_version?: number;
  expected_input_revision?: number;
}

export interface ControllerTransitionInput {
  target_phase: WorkItemPhase;
  target_status: WorkItemStatus;
  expected_phase: WorkItemPhase;
  expected_status: WorkItemStatus;
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
}

export interface ImportExternalResultInput {
  expected_phase: "execute";
  expected_status: "active";
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
}

export interface ImportReviewResultInput {
  expected_phase: "review";
  expected_status: "active";
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
}

export interface RetryExecuteAttemptInput {
  expected_phase: "execute";
  expected_status: "blocked";
  expected_schema_version: 2;
  expected_goal_version: number;
  expected_input_revision: number;
  attempt: number;
}

export interface ControllerRunManifest {
  schema_version: 1;
  run_id: string;
  work_item_id: string;
  idempotency_key: string;
  phase: WorkItemPhase;
  goal_version: number;
  input_revision: number;
  attempt: number;
  started_at: string;
  completed_at?: string;
  outcome: ControllerRunOutcome;
}

export interface ControllerLease {
  work_item: WorkItem;
  active_run: ActiveRun;
}

export interface ControllerMutationInput {
  goal: WorkItemGoal;
  state: WorkItemState;
  manifest: ControllerRunManifest;
}

export interface ControllerMutationResult {
  work_item: WorkItem;
  manifest: ControllerRunManifest;
}

export interface WorkItemRepository {
  readManifest(): Promise<ProductManifest>;
  create(input: CreateWorkItemInput): Promise<WorkItem>;
  createCapture(input: CreateCaptureInput): Promise<WorkItem>;
  read(workItemId: string): Promise<WorkItem | null>;
  list(): Promise<WorkItem[]>;
  updateGoal(
    workItemId: string,
    nextGoal: WorkItemGoal,
  ): Promise<WorkItem | null>;
  updatePhase(
    workItemId: string,
    input: UpdateWorkItemPhaseInput,
  ): Promise<WorkItem | null>;
  hasWorkItem(workItemId: string): Promise<boolean>;
  stageIncomingWorkItem(
    item: WorkItem,
    manifest?: ControllerRunManifest,
  ): Promise<string>;
  publishStagedWorkItem(
    workItemId: string,
    stagingPath: string,
  ): Promise<void>;
  discardStagedWorkItem(
    workItemId: string,
    stagingPath: string,
  ): Promise<void>;
  removeWorkItem(workItemId: string): Promise<void>;
  acquireControllerLease(
    workItemId: string,
    activeRun: ActiveRun,
  ): Promise<ControllerLease | null>;
  readControllerRunManifest(
    workItemId: string,
    runId: string,
  ): Promise<ControllerRunManifest | null>;
  findAppliedExecuteManifest(
    identity: MissionIdentity<"execute">,
  ): Promise<ControllerRunManifest | null>;
  writeMissionPackage(
    identity: MissionIdentity,
    buildPackage: MissionPackageBuilder,
  ): Promise<MissionArtifactWriteResult>;
  readMissionResult(identity: MissionIdentity): Promise<MissionResultSnapshot>;
  readImportEvidence(
    identity: MissionIdentity,
    importRunId: string,
  ): Promise<StoredImportEvidence | null>;
  writeImportEvidence(
    input: ImportEvidenceWriteInput,
  ): Promise<ImportEvidenceSummary>;
  listImportEvidence(workItemId: string): Promise<StoredImportEvidence[]>;
  gitVerificationAdapter(): GitVerificationAdapter;
  verificationRunner(): VerificationRunner;
  commitControllerMutation(
    lease: ControllerLease,
    input: ControllerMutationInput,
  ): Promise<ControllerMutationResult>;
  releaseControllerLease(lease: ControllerLease): Promise<void>;
}

export interface ReviewWorkItemRepository extends WorkItemRepository {
  readAppliedExecuteReviewSubject(
    identity: MissionIdentity<"execute">,
  ): Promise<AppliedExecuteReviewSubject>;
  writeReviewMissionPackage(
    identity: MissionIdentity<"review">,
    reviewSubject: ReviewMissionPackage["review_subject"],
    buildPackage: MissionPackageBuilder<ReviewMissionPackage>,
  ): Promise<MissionArtifactWriteResult<ReviewMissionPackage>>;
}

export type ControllerWorkItemRepository = ReviewWorkItemRepository;

export const workItemIdSchema = z
  .string()
  .regex(
    /^wi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "work_item_id must use the wi_<uuid> format",
  );

const titleSchema = z
  .string()
  .refine((title) => title.trim().length > 0, "title must not be empty")
  .refine(
    (title) => title === title.trim(),
    "title must not have leading or trailing whitespace",
  );

const tagSchema = z.string().trim().min(1, "tags must not be empty");

const tagsSchema: z.ZodType<string[]> = z
  .array(tagSchema)
  .refine(
    (tags) => new Set(tags.map((tag) => tag.toLocaleLowerCase())).size === tags.length,
    "tags must not contain case-insensitive duplicates",
  );

const notesSchema = z
  .string()
  .refine((notes) => notes.trim().length > 0, "notes must not be empty");

const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();

function uniqueNonEmptyListSchema(label: string): z.ZodType<string[]> {
  return z
    .array(z.string().trim().min(1, `${label} entries must not be empty`))
    .min(1, `${label} must not be empty`)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.toLocaleLowerCase())).size ===
        entries.length,
      `${label} must not contain case-insensitive duplicates`,
    );
}

const acceptanceCriteriaSchema = uniqueNonEmptyListSchema(
  "acceptance_criteria",
);
const purposeSchema = z
  .string()
  .refine((purpose) => purpose.trim().length > 0, "purpose must not be empty")
  .refine(
    (purpose) => purpose === purpose.trim(),
    "purpose must not have leading or trailing whitespace",
  )
  .refine(
    (purpose) => !/[\r\n]/u.test(purpose),
    "purpose must not contain line breaks",
  );
const nonGoalsSchema = uniqueNonEmptyListSchema("non_goals");
const allowedScopeSchema = z
  .array(workspaceRelativePosixPathSchema)
  .min(1, "allowed_scope must not be empty")
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.toLocaleLowerCase())).size ===
      entries.length,
    "allowed_scope must not contain case-insensitive duplicates",
  );
const reviewReadySchema = uniqueNonEmptyListSchema("review_ready");

const nonEmptyIdentifierSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be empty")
  .refine(
    (value) => value === value.trim(),
    "must not have leading or trailing whitespace",
  );

export const controllerRunIdSchema = z.uuid();

export const verificationCommandSchema: z.ZodType<VerificationCommand> =
  z.strictObject({
    name: nonEmptyIdentifierSchema,
    argv: z.tuple([nonEmptyIdentifierSchema], z.string()),
    timeout_seconds: z.number().int().min(1).max(900),
  });

const requiredVerificationCommandsSchema = z
  .tuple([verificationCommandSchema], verificationCommandSchema)
  .refine(
    (commands) =>
      new Set(commands.map((command) => command.name.toLocaleLowerCase()))
        .size === commands.length,
    "verification command names must not contain case-insensitive duplicates",
  );

export const productManifestSchema: z.ZodType<ProductManifest> = z.strictObject({
  schema_version: z.literal(2),
  product_name: z.string(),
  verification: z.strictObject({
    required_commands: requiredVerificationCommandsSchema,
  }),
});

export const workItemCaptureSchema: z.ZodType<WorkItemCapture> = z.strictObject({
  kind: z.enum(CAPTURE_KINDS),
  original_title: titleSchema,
  captured_at: z.iso.datetime(),
});

export const goalContractSchema: z.ZodType<GoalContract> = z.strictObject({
  schema_version: z.literal(1),
  goal_version: positiveSafeIntegerSchema,
  purpose: purposeSchema,
  acceptance_criteria: acceptanceCriteriaSchema,
  non_goals: nonGoalsSchema,
  allowed_scope: allowedScopeSchema,
  review_ready: reviewReadySchema,
});

export const workItemGoalSchema: z.ZodType<WorkItemGoal> = z.strictObject({
  schema_version: z.literal(2),
  work_item_id: workItemIdSchema,
  title: titleSchema,
  type: z.enum(WORK_ITEM_TYPES).optional(),
  capture: workItemCaptureSchema.optional(),
  priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
  tags: tagsSchema.optional(),
  notes: notesSchema.optional(),
  goal_contract: goalContractSchema.optional(),
});

export const activeRunSchema: z.ZodType<ActiveRun> = z.strictObject({
  run_id: controllerRunIdSchema,
  idempotency_key: nonEmptyIdentifierSchema,
  acquired_at: z.iso.datetime(),
});

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const nonEmptyPathListSchema: z.ZodType<[string, ...string[]]> = z
  .tuple([workspaceRelativePosixPathSchema], workspaceRelativePosixPathSchema)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    "artifact_paths must not contain duplicates",
  );
const evidencePathListSchema = z
  .array(workspaceRelativePosixPathSchema)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    "evidence_paths must not contain duplicates",
  );

export const governedTupleSchema: z.ZodType<GovernedTuple> = z.strictObject({
  goal_version: positiveSafeIntegerSchema,
  input_revision: positiveSafeIntegerSchema,
  attempt: nonNegativeSafeIntegerSchema,
  patch_cycle: nonNegativeSafeIntegerSchema,
});

export const workItemAttentionPinsSchema: z.ZodType<WorkItemAttentionPins> =
  z.strictObject({
    artifact_paths: nonEmptyPathListSchema,
    evidence_paths: evidencePathListSchema,
    git_commit: gitCommitSchema.optional(),
    mission_content_sha256: sha256Schema.optional(),
    result_content_sha256: sha256Schema.optional(),
  });

const attentionRecordFields = {
  question: nonEmptyIdentifierSchema,
  recommendation: nonEmptyIdentifierSchema,
  created_at: z.iso.datetime(),
  governed_tuple: governedTupleSchema,
  pins: workItemAttentionPinsSchema,
};

export const workItemAttentionSchema: z.ZodType<WorkItemAttention> =
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("spec_approval"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("plan_approval"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("patch_plan_approval"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("ambiguous_goal"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("cycle_limit"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("missing_permission"),
      ...attentionRecordFields,
    }),
    z.strictObject({
      kind: z.literal("review_ready"),
      ...attentionRecordFields,
    }),
  ]);

interface VersionedStateFields {
  goal_version?: number;
  input_revision?: number;
  attempt?: number;
}

function validateVersionedStateFields(
  state: VersionedStateFields,
  context: z.RefinementCtx,
): void {
  const versionedFields = [
    "goal_version",
    "input_revision",
    "attempt",
  ] as const;
  const presentFields = versionedFields.filter(
    (field) => state[field] !== undefined,
  );

  if (presentFields.length > 0 && presentFields.length < versionedFields.length) {
    for (const field of versionedFields) {
      if (state[field] === undefined) {
        context.addIssue({
          code: "custom",
          message: `${field} is required when controller state is present`,
          path: [field],
          input: state,
        });
      }
    }
  }
}

const legacyWorkItemStateSchema = z
  .strictObject({
    schema_version: z.literal(1),
    work_item_id: workItemIdSchema,
    phase: z.enum(WORK_ITEM_PHASES),
    status: z.enum(WORK_ITEM_STATUSES),
    updated_at: z.iso.datetime(),
    goal_version: positiveSafeIntegerSchema.optional(),
    input_revision: positiveSafeIntegerSchema.optional(),
    attempt: nonNegativeSafeIntegerSchema.optional(),
    active_run: activeRunSchema.optional(),
  })
  .superRefine(validateVersionedStateFields);

export const workItemStateSchema: z.ZodType<WorkItemState> = z
  .strictObject({
    schema_version: z.literal(2),
    work_item_id: workItemIdSchema,
    phase: z.enum(WORK_ITEM_PHASES),
    status: z.enum(WORK_ITEM_STATUSES),
    updated_at: z.iso.datetime(),
    goal_version: positiveSafeIntegerSchema.optional(),
    input_revision: positiveSafeIntegerSchema.optional(),
    attempt: nonNegativeSafeIntegerSchema.optional(),
    patch_cycle: nonNegativeSafeIntegerSchema.optional(),
    attention: workItemAttentionSchema.optional(),
    active_run: activeRunSchema.optional(),
  })
  .superRefine((state, context) => {
    validateVersionedStateFields(state, context);

    const hasControllerState =
      state.goal_version !== undefined &&
      state.input_revision !== undefined &&
      state.attempt !== undefined;

    if (hasControllerState && state.patch_cycle === undefined) {
      context.addIssue({
        code: "custom",
        message: "patch_cycle is required when controller state is present",
        path: ["patch_cycle"],
        input: state,
      });
    } else if (!hasControllerState && state.patch_cycle !== undefined) {
      context.addIssue({
        code: "custom",
        message: "patch_cycle requires controller state",
        path: ["patch_cycle"],
        input: state,
      });
    }

    if (state.attention !== undefined && !hasControllerState) {
      context.addIssue({
        code: "custom",
        message: "attention requires controller state",
        path: ["attention"],
        input: state,
      });
    }

    if (state.attention !== undefined && state.patch_cycle !== undefined) {
      const expectedTuple = {
        goal_version: state.goal_version,
        input_revision: state.input_revision,
        attempt: state.attempt,
        patch_cycle: state.patch_cycle,
      };
      for (const field of Object.keys(expectedTuple) as Array<
        keyof GovernedTuple
      >) {
        if (state.attention.governed_tuple[field] !== expectedTuple[field]) {
          context.addIssue({
            code: "custom",
            message: `attention governed_tuple ${field} must match state ${field}`,
            path: ["attention", "governed_tuple", field],
            input: state.attention.governed_tuple[field],
          });
        }
      }
    }
  });

export function parseWorkItemStateForRead(input: unknown): WorkItemState {
  if (
    typeof input === "object" &&
    input !== null &&
    "schema_version" in input &&
    input.schema_version === 2
  ) {
    return workItemStateSchema.parse(input);
  }

  const legacyState = legacyWorkItemStateSchema.parse(input);
  const hasControllerState =
    legacyState.goal_version !== undefined &&
    legacyState.input_revision !== undefined &&
    legacyState.attempt !== undefined;

  return workItemStateSchema.parse({
    ...legacyState,
    schema_version: 2,
    ...(hasControllerState ? { patch_cycle: 0 } : {}),
  });
}

export const workItemSchema: z.ZodType<WorkItem> = z
  .strictObject({
    goal: workItemGoalSchema,
    state: workItemStateSchema,
  })
  .superRefine(({ goal, state }, context) => {
    if (goal.work_item_id !== state.work_item_id) {
      context.addIssue({
        code: "custom",
        message: "goal.yaml and state.json work_item_id values must agree",
        path: ["state", "work_item_id"],
        input: state.work_item_id,
      });
    }

    const goalContract = goal.goal_contract;
    const hasContract = goalContract !== undefined;
    const hasControllerState =
      state.goal_version !== undefined ||
      state.input_revision !== undefined ||
      state.attempt !== undefined ||
      state.patch_cycle !== undefined ||
      state.attention !== undefined ||
      state.active_run !== undefined;

    if (hasContract) {
      if (state.goal_version !== goalContract.goal_version) {
        context.addIssue({
          code: "custom",
          message: "state goal_version must match goal contract goal_version",
          path: ["state", "goal_version"],
          input: state.goal_version,
        });
      }
      if (state.input_revision === undefined) {
        context.addIssue({
          code: "custom",
          message: "input_revision is required for a contracted item",
          path: ["state", "input_revision"],
          input: state,
        });
      }
      if (state.attempt === undefined) {
        context.addIssue({
          code: "custom",
          message: "attempt is required for a contracted item",
          path: ["state", "attempt"],
          input: state,
        });
      }
    } else if (hasControllerState) {
      context.addIssue({
        code: "custom",
        message: "controller state requires a goal contract",
        path: ["state"],
        input: state,
      });
    }
  });

export const saveWorkItemInputSchema: z.ZodType<SaveWorkItemInput> = z
  .strictObject({
    target_source_id: portfolioSourceIdSchema,
    title: titleSchema,
    type: z.enum(WORK_ITEM_TYPES).nullable(),
    priority: z.enum(WORK_ITEM_PRIORITIES).nullable(),
    tags: tagsSchema,
    notes: notesSchema.nullable(),
    goal_contract: z
      .strictObject({
        purpose: purposeSchema,
        acceptance_criteria: acceptanceCriteriaSchema,
        non_goals: nonGoalsSchema,
        allowed_scope: allowedScopeSchema,
        review_ready: reviewReadySchema,
      })
      .optional(),
    expected_goal_version: positiveSafeIntegerSchema.optional(),
    expected_input_revision: positiveSafeIntegerSchema.optional(),
  })
  .superRefine((input, context) => {
    const hasExpectedGoalVersion = input.expected_goal_version !== undefined;
    const hasExpectedInputRevision =
      input.expected_input_revision !== undefined;

    if (hasExpectedGoalVersion !== hasExpectedInputRevision) {
      context.addIssue({
        code: "custom",
        message:
          "expected_goal_version and expected_input_revision must be provided together",
        path: hasExpectedGoalVersion
          ? ["expected_input_revision"]
          : ["expected_goal_version"],
        input,
      });
    }

    if (
      (hasExpectedGoalVersion || hasExpectedInputRevision) &&
      input.goal_contract === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "expected versions require a goal contract",
        path: ["goal_contract"],
        input,
      });
    }
  });

export const controllerTransitionInputSchema: z.ZodType<ControllerTransitionInput> =
  z.strictObject({
    target_phase: z.enum(WORK_ITEM_PHASES),
    target_status: z.enum(WORK_ITEM_STATUSES),
    expected_phase: z.enum(WORK_ITEM_PHASES),
    expected_status: z.enum(WORK_ITEM_STATUSES),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

export const importExternalResultInputSchema: z.ZodType<ImportExternalResultInput> =
  z.strictObject({
    expected_phase: z.literal("execute"),
    expected_status: z.literal("active"),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

export const importReviewResultInputSchema: z.ZodType<ImportReviewResultInput> =
  z.strictObject({
    expected_phase: z.literal("review"),
    expected_status: z.literal("active"),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

export const retryExecuteAttemptInputSchema: z.ZodType<RetryExecuteAttemptInput> =
  z.strictObject({
    expected_phase: z.literal("execute"),
    expected_status: z.literal("blocked"),
    expected_schema_version: z.literal(2),
    expected_goal_version: positiveSafeIntegerSchema,
    expected_input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
  });

export const controllerRunManifestSchema: z.ZodType<ControllerRunManifest> =
  z.strictObject({
    schema_version: z.literal(1),
    run_id: controllerRunIdSchema,
    work_item_id: workItemIdSchema,
    idempotency_key: nonEmptyIdentifierSchema,
    phase: z.enum(WORK_ITEM_PHASES),
    goal_version: positiveSafeIntegerSchema,
    input_revision: positiveSafeIntegerSchema,
    attempt: nonNegativeSafeIntegerSchema,
    started_at: z.iso.datetime(),
    completed_at: z.iso.datetime().optional(),
    outcome: z.enum(CONTROLLER_RUN_OUTCOMES),
  });

export const createWorkItemInputSchema: z.ZodType<CreateWorkItemInput> =
  z.strictObject({
    title: titleSchema,
    type: z.enum(WORK_ITEM_TYPES),
  });

export const createCaptureInputSchema: z.ZodType<CreateCaptureInput> =
  z.strictObject({
    title: titleSchema,
    capture_kind: z.enum(CAPTURE_KINDS),
    source_id: portfolioSourceIdSchema.optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
    tags: tagsSchema.optional(),
    notes: notesSchema.optional(),
  });

export const updateWorkItemPhaseInputSchema: z.ZodType<UpdateWorkItemPhaseInput> =
  z.strictObject({
    target_phase: z.enum(WORK_ITEM_PHASES),
  });

export class InvalidWorkspaceError extends Error {
  readonly kind = "invalid_workspace" as const;

  constructor(
    readonly artifactPath: string,
    readonly reason: string,
  ) {
    super(`${artifactPath}: ${reason}`);
    this.name = "InvalidWorkspaceError";
  }
}

export class ControllerConflictError extends Error {
  constructor(
    readonly kind: ControllerConflictKind,
    readonly workItemId: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "ControllerConflictError";
  }
}

export class WorkItemTargetCollisionError extends Error {
  readonly kind = "target_collision" as const;

  constructor(
    readonly sourceId: string,
    readonly workItemId: string,
    readonly targetSourceId: string,
  ) {
    super(
      `Work item ${workItemId} from source ${sourceId} already exists in target ${targetSourceId}`,
    );
    this.name = "WorkItemTargetCollisionError";
  }
}

export class WorkItemTransferFailedError extends Error {
  readonly kind = "transfer_failed" as const;

  constructor(
    readonly sourceId: string,
    readonly workItemId: string,
    readonly targetSourceId: string,
    readonly reason: string,
  ) {
    super(
      `Failed to transfer work item ${workItemId} from ${sourceId} to ${targetSourceId}: ${reason}`,
    );
    this.name = "WorkItemTransferFailedError";
  }
}
