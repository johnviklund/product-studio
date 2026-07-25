import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import {
  WorkItemController,
  deriveControllerIdempotencyKey,
} from "../../src/application/work-item-controller";
import {
  compileMission,
  compileReviewMission,
  type MissionIdentity,
  type ReviewSubject,
} from "../../src/domain/mission";
import {
  importEvidenceSummarySchema,
  serializeExternalResult,
  type AppliedExecuteReviewSubject,
  type ExecuteExternalResultSubmission,
  type ImportEvidenceWriteInput,
  type MissionResultSnapshot,
  type ReviewExternalResultSubmission,
  type ReviewFindingLink,
  type StoredImportEvidence,
} from "../../src/domain/result";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../../src/domain/verification";
import {
  ControllerConflictError,
  type ControllerRunManifest,
  type VerificationCommand,
  type WorkItem,
} from "../../src/domain/work-item";
import { ProductWorkspace } from "../../src/workspace/product-workspace";

const createdRoots: string[] = [];
const fixedClock = () => new Date("2026-07-21T21:00:00.000Z");
const testCommit = "a".repeat(40);
const passingGit: GitVerificationAdapter = {
  async resolveCommit() {
    return testCommit;
  },
  async isAncestor() {
    return true;
  },
  async readHeadCommit() {
    return testCommit;
  },
  async isWorktreeCleanExcludingFounder() {
    return true;
  },
  async listChangedFiles() {
    return ["src/domain/result.ts"];
  },
};
const passingRunner: VerificationRunner = {
  async run(command: VerificationCommand) {
    return {
      name: command.name,
      argv: command.argv,
      started_at: "2026-07-21T21:00:00.000Z",
      completed_at: "2026-07-21T21:00:01.000Z",
      duration_ms: 1000,
      status: "passed",
      exit_code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      output_truncated: false,
    };
  },
};

function createController(
  repository: ProductWorkspace,
  git: GitVerificationAdapter = passingGit,
  runner: VerificationRunner = passingRunner,
) {
  const controller = new WorkItemController(repository, fixedClock, git, runner);
  return Object.assign(controller, {
    updateGoalContract(
      workItemId: string,
      input: (typeof firstContract) & {
        expected_goal_version?: number;
        expected_input_revision?: number;
      },
    ) {
      return controller.saveWorkItem(workItemId, {
        target_source_id: "inbox",
        title: "Build the controller foundation",
        type: "Feature",
        priority: null,
        tags: [],
        notes: null,
        goal_contract: {
          purpose: "Keep controller transitions safe.",
          acceptance_criteria: input.acceptance_criteria,
          non_goals: ["Do not bypass the controller."],
          allowed_scope: input.allowed_scope,
          review_ready: input.review_ready,
        },
        ...(input.expected_goal_version === undefined
          ? {}
          : {
              expected_goal_version: input.expected_goal_version,
              expected_input_revision: input.expected_input_revision,
            }),
      });
    },
  });
}

async function createWorkspace(): Promise<{
  root: string;
  repository: ProductWorkspace;
}> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-controller-"));
  createdRoots.push(root);
  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: "Controller Test",
      verification: {
        required_commands: [
          {
            name: "Tests",
            argv: ["npm", "test"],
            timeout_seconds: 120,
          },
          {
            name: "Typecheck",
            argv: ["npm", "run", "typecheck"],
            timeout_seconds: 120,
          },
        ],
      },
    }),
    "utf8",
  );
  return { root, repository: new ProductWorkspace(root) };
}

interface ImportTestRepository extends ProductWorkspace {
  readMissionResult(identity: MissionIdentity): Promise<MissionResultSnapshot>;
  readImportEvidence(
    identity: MissionIdentity,
    importRunId: string,
  ): Promise<StoredImportEvidence | null>;
  writeImportEvidence(
    input: ImportEvidenceWriteInput,
  ): Promise<ReturnType<typeof importEvidenceSummarySchema.parse>>;
}

async function governToExecute(
  repository: ProductWorkspace,
): Promise<{ workItem: WorkItem; manifest: ControllerRunManifest }> {
  const created = await createUncontractedItem(repository);
  const controller = createController(repository);
  let mutation = await controller.updateGoalContract(
    created.goal.work_item_id,
    firstContract,
  );
  for (const targetPhase of ["spec", "plan", "execute"] as const) {
    mutation = await controller.transition(created.goal.work_item_id, {
      target_phase: targetPhase,
      target_status: "active",
      expected_phase: mutation.work_item.state.phase,
      expected_status: mutation.work_item.state.status,
      expected_schema_version: 2,
      expected_goal_version: mutation.work_item.state.goal_version!,
      expected_input_revision: mutation.work_item.state.input_revision!,
      attempt: mutation.work_item.state.attempt!,
    });
  }
  return { workItem: mutation.work_item, manifest: mutation.manifest };
}

async function createImportFixture(options?: {
  resultSource?: string;
  transformResult?: (
    result: ExecuteExternalResultSubmission,
  ) => ExecuteExternalResultSubmission;
}): Promise<{
  repository: ImportTestRepository;
  workItem: WorkItem;
  input: {
    expected_phase: "execute";
    expected_status: "active";
    expected_schema_version: 2;
    expected_goal_version: number;
    expected_input_revision: number;
    attempt: number;
  };
  evidence: Map<string, StoredImportEvidence>;
  evidenceWrites: { count: number };
}> {
  const { repository: workspace } = await createWorkspace();
  const { workItem, manifest } = await governToExecute(workspace);
  const identity = {
    phase: "execute" as const,
    work_item_id: workItem.goal.work_item_id,
    goal_version: workItem.state.goal_version!,
    input_revision: workItem.state.input_revision!,
    attempt: workItem.state.attempt!,
  };
  const paths = {
    task_path: `.founder/missions/${identity.work_item_id}/execute-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/TASK.md`,
    output_path: `.founder/missions/${identity.work_item_id}/execute-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/result.json`,
    git_base_commit: "0".repeat(40),
  };
  const mission = compileMission(workItem, manifest, paths);
  const defaultResult: ExecuteExternalResultSubmission = {
    result_schema_version: 2,
    mission_content_sha256: mission.content_sha256,
    identity,
    commit: testCommit,
    summary: "Implemented result import",
    changed_files: ["src/domain/result.ts"],
    verification: [{ name: "Tests", status: "passed" }],
  };
  const resultSource =
    options?.resultSource ??
    serializeExternalResult(
      options?.transformResult?.(defaultResult) ?? defaultResult,
    );
  const snapshot: MissionResultSnapshot = {
    mission,
    mission_path: paths.task_path.replace(/TASK\.md$/, "mission.json"),
    result_path: paths.output_path,
    result_source: resultSource,
  };
  const evidence = new Map<string, StoredImportEvidence>();
  const evidenceWrites = { count: 0 };
  const repository = Object.assign(workspace, {
    async readMissionResult() {
      return snapshot;
    },
    async readImportEvidence(_identity: MissionIdentity, importRunId: string) {
      return evidence.get(importRunId) ?? null;
    },
    async writeImportEvidence(input: ImportEvidenceWriteInput) {
      evidenceWrites.count += 1;
      const summary = importEvidenceSummarySchema.parse({
        phase: input.evidence.phase,
        import_run_id: input.evidence.import_run_id,
        outcome: input.evidence.outcome,
        evidence_path: `.founder/run-evidence/${identity.work_item_id}/execute-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/${input.evidence.import_run_id}`,
        reasons: input.evidence.reasons,
      });
      evidence.set(input.evidence.import_run_id, {
        evidence: input.evidence,
        summary,
        verification: input.verification,
      });
      return summary;
    },
  }) as ImportTestRepository;

  return {
    repository,
    workItem,
    input: {
      expected_phase: "execute",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
    },
    evidence,
    evidenceWrites,
  };
}

async function createReviewImportFixture(options?: {
  resultSource?: string;
  transformResult?: (
    result: ReviewExternalResultSubmission,
  ) => ReviewExternalResultSubmission;
  transformCurrentSubject?: (subject: ReviewSubject) => ReviewSubject;
}): Promise<{
  repository: ImportTestRepository;
  workItem: WorkItem;
  input: {
    expected_phase: "review";
    expected_status: "active";
    expected_schema_version: 2;
    expected_goal_version: number;
    expected_input_revision: number;
    attempt: number;
  };
  evidence: Map<string, StoredImportEvidence>;
  evidenceWrites: { count: number };
}> {
  const { repository: workspace } = await createWorkspace();
  const execute = await governToExecute(workspace);
  const controller = createController(workspace);
  const transitioned = await controller.transition(
    execute.workItem.goal.work_item_id,
    {
      target_phase: "review",
      target_status: "active",
      expected_phase: "execute",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: execute.workItem.state.goal_version!,
      expected_input_revision: execute.workItem.state.input_revision!,
      attempt: execute.workItem.state.attempt!,
    },
  );
  const workItem = transitioned.work_item;
  const identity = {
    phase: "review" as const,
    work_item_id: workItem.goal.work_item_id,
    goal_version: workItem.state.goal_version!,
    input_revision: workItem.state.input_revision!,
    attempt: workItem.state.attempt!,
  };
  const commandEvidence = [
    {
      name: "Tests",
      argv: ["npm", "test"] as [string, ...string[]],
      started_at: "2026-07-21T20:58:00.000Z",
      completed_at: "2026-07-21T20:58:01.000Z",
      duration_ms: 1_000,
      status: "passed" as const,
      exit_code: 0 as const,
      signal: null,
      stdout: "green",
      stderr: "",
      output_truncated: false,
    },
    {
      name: "Typecheck",
      argv: ["npm", "run", "typecheck"] as [string, ...string[]],
      started_at: "2026-07-21T20:58:01.000Z",
      completed_at: "2026-07-21T20:58:02.000Z",
      duration_ms: 1_000,
      status: "passed" as const,
      exit_code: 0 as const,
      signal: null,
      stdout: "green",
      stderr: "",
      output_truncated: false,
    },
  ];
  const subject: ReviewSubject = {
    execute_mission_content_sha256: "1".repeat(64),
    execute_result_content_sha256: "2".repeat(64),
    git_base_commit: "0".repeat(40),
    accepted_result_commit: testCommit,
    changed_files: ["src/domain/result.ts"],
    execute_mission_path: `.founder/missions/${identity.work_item_id}/execute-1-1-0/mission.json`,
    execute_evidence_path: `.founder/run-evidence/${identity.work_item_id}/execute-1-1-0/${"3".repeat(64)}`,
    command_evidence: commandEvidence,
  };
  const paths = {
    task_path: `.founder/missions/${identity.work_item_id}/review-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/TASK.md`,
    output_path: `.founder/missions/${identity.work_item_id}/review-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/result.json`,
    git_base_commit: subject.git_base_commit,
  };
  const mission = compileReviewMission({
    work_item: workItem,
    controller_run: {
      schema_version: 1,
      run_id: "77777777-7777-4777-8777-777777777777",
      work_item_id: identity.work_item_id,
      idempotency_key: `${identity.work_item_id}:review:1:1:0:mission`,
      phase: "review",
      goal_version: identity.goal_version,
      input_revision: identity.input_revision,
      attempt: identity.attempt,
      started_at: "2026-07-21T20:59:00.000Z",
      completed_at: "2026-07-21T20:59:01.000Z",
      outcome: "applied",
    },
    review_subject: subject,
    paths,
    independence_attested: true,
  });
  const defaultResult: ReviewExternalResultSubmission = {
    result_schema_version: 2,
    review_mission_content_sha256: mission.content_sha256,
    identity,
    execute_mission_content_sha256:
      subject.execute_mission_content_sha256,
    execute_result_content_sha256: subject.execute_result_content_sha256,
    git_base_commit: subject.git_base_commit,
    accepted_result_commit: subject.accepted_result_commit,
    summary: "Review found no blocking issues.",
    verdict: "clean",
    findings: [],
  };
  const resultSource =
    options?.resultSource ??
    serializeExternalResult(
      options?.transformResult?.(defaultResult) ?? defaultResult,
    );
  const snapshot: MissionResultSnapshot = {
    mission,
    mission_path: paths.task_path.replace(/TASK\.md$/, "mission.json"),
    result_path: paths.output_path,
    result_source: resultSource,
  };
  const evidence = new Map<string, StoredImportEvidence>();
  const evidenceWrites = { count: 0 };
  const appliedSubject: AppliedExecuteReviewSubject = {
    review_subject:
      options?.transformCurrentSubject?.(subject) ?? subject,
    submission_source: "{\"execute\":\"result\"}\n",
    evidence: {
      schema_version: 2,
      phase: "execute",
      import_run_id: "3".repeat(64),
      result_content_sha256: subject.execute_result_content_sha256,
      mission_content_sha256: subject.execute_mission_content_sha256,
      identity: { ...identity, phase: "execute" },
      git_base_commit: subject.git_base_commit,
      result_commit: subject.accepted_result_commit,
      controller_run_id: transitioned.manifest.run_id,
      started_at: "2026-07-21T20:58:00.000Z",
      completed_at: "2026-07-21T20:58:02.000Z",
      outcome: "applied",
      reasons: [],
    },
    verification: commandEvidence,
  };
  const repository = Object.assign(workspace, {
    async readMissionResult() {
      return snapshot;
    },
    async readAppliedExecuteReviewSubject() {
      return appliedSubject;
    },
    async readImportEvidence(_identity: MissionIdentity, importRunId: string) {
      return evidence.get(importRunId) ?? null;
    },
    async writeImportEvidence(input: ImportEvidenceWriteInput) {
      evidenceWrites.count += 1;
      const summary = importEvidenceSummarySchema.parse({
        phase: input.evidence.phase,
        import_run_id: input.evidence.import_run_id,
        outcome: input.evidence.outcome,
        evidence_path: `.founder/run-evidence/${identity.work_item_id}/review-${identity.goal_version}-${identity.input_revision}-${identity.attempt}/${input.evidence.import_run_id}`,
        reasons: input.evidence.reasons,
      });
      evidence.set(input.evidence.import_run_id, {
        evidence: input.evidence,
        summary,
        verification: input.verification,
      });
      return summary;
    },
  }) as ImportTestRepository;

  return {
    repository,
    workItem,
    input: {
      expected_phase: "review",
      expected_status: "active",
      expected_schema_version: 2,
      expected_goal_version: identity.goal_version,
      expected_input_revision: identity.input_revision,
      attempt: identity.attempt,
    },
    evidence,
    evidenceWrites,
  };
}

async function createUncontractedItem(repository: ProductWorkspace) {
  return repository.create({
    title: "Build the controller foundation",
    type: "Feature",
  });
}

const firstContract = {
  acceptance_criteria: ["Reject stale transitions"],
  allowed_scope: ["src/domain", "src/application"],
  review_ready: ["Deterministic checks pass"],
};

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("WorkItemController", () => {
  it("activates and updates a goal contract exactly once per expected revision", async () => {
    const { root, repository } = await createWorkspace();
    const created = await createUncontractedItem(repository);
    const controller = createController(repository);

    const activated = await controller.updateGoalContract(
      created.goal.work_item_id,
      firstContract,
    );
    expect(activated.work_item.goal).toMatchObject({
      goal_contract: {
        ...firstContract,
        purpose: "Keep controller transitions safe.",
        non_goals: ["Do not bypass the controller."],
        goal_version: 1,
      },
    });
    expect(activated.work_item.state).toMatchObject({
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
    });
    expect(activated.manifest).toMatchObject({ outcome: "applied" });

    const secondInput = {
      acceptance_criteria: ["Reject stale transitions", "Replay is idempotent"],
      allowed_scope: ["src/domain", "src/application"],
      review_ready: ["Deterministic checks pass"],
      expected_goal_version: 1,
      expected_input_revision: 1,
    };
    const updated = await controller.updateGoalContract(
      created.goal.work_item_id,
      secondInput,
    );
    expect(updated.work_item.goal.goal_contract?.goal_version).toBe(2);
    expect(updated.work_item.state).toMatchObject({
      goal_version: 2,
      input_revision: 2,
      attempt: 0,
    });

    const replay = await controller.updateGoalContract(
      created.goal.work_item_id,
      secondInput,
    );
    expect(replay).toEqual(updated);

    const beforeStaleAttempt = await repository.read(created.goal.work_item_id);
    const stalePromise = controller.updateGoalContract(
      created.goal.work_item_id,
      {
        ...secondInput,
        acceptance_criteria: ["Different stale contract"],
        expected_input_revision: 2,
      },
    );
    await expect(stalePromise).rejects.toMatchObject({
      name: "ControllerConflictError",
      kind: "stale_expectation",
    });
    expect(await repository.read(created.goal.work_item_id)).toEqual(
      beforeStaleAttempt,
    );

    const runEntries = await readdir(
      join(
        root,
        ".founder",
        "work-items",
        created.goal.work_item_id,
        "runs",
      ),
    );
    expect(runEntries).toHaveLength(2);
  });

  it("rejects goal-contract updates in execute without mutating or retaining its lease", async () => {
    const { root, repository } = await createWorkspace();
    const created = await createUncontractedItem(repository);
    const controller = createController(repository);
    let mutation = await controller.updateGoalContract(
      created.goal.work_item_id,
      firstContract,
    );

    for (const targetPhase of ["spec", "plan", "execute"] as const) {
      mutation = await controller.transition(created.goal.work_item_id, {
        target_phase: targetPhase,
        target_status: "active",
        expected_phase: mutation.work_item.state.phase,
        expected_status: mutation.work_item.state.status,
        expected_schema_version: 2,
        expected_goal_version: mutation.work_item.state.goal_version!,
        expected_input_revision: mutation.work_item.state.input_revision!,
        attempt: mutation.work_item.state.attempt!,
      });
    }

    const before = await repository.read(created.goal.work_item_id);
    const runsPath = join(
      root,
      ".founder",
      "work-items",
      created.goal.work_item_id,
      "runs",
    );
    const runsBefore = await readdir(runsPath);

    await expect(
      controller.updateGoalContract(created.goal.work_item_id, {
        ...firstContract,
        acceptance_criteria: ["Execute contracts stay fixed"],
        expected_goal_version: 1,
        expected_input_revision: 1,
      }),
    ).rejects.toMatchObject({
      name: "ControllerConflictError",
      kind: "goal_contract_locked",
    });
    expect(await repository.read(created.goal.work_item_id)).toEqual(before);
    expect(await readdir(runsPath)).toEqual(runsBefore);

    const afterRejectedUpdate = await repository.read(created.goal.work_item_id);
    const transitioned = await controller.transition(created.goal.work_item_id, {
      target_phase: "review",
      target_status: "active",
      expected_phase: afterRejectedUpdate!.state.phase,
      expected_status: afterRejectedUpdate!.state.status,
      expected_schema_version: 2,
      expected_goal_version: afterRejectedUpdate!.state.goal_version!,
      expected_input_revision: afterRejectedUpdate!.state.input_revision!,
      attempt: afterRejectedUpdate!.state.attempt!,
    });
    expect(transitioned.work_item.state.phase).toBe("review");
  });

  it("applies and replays an exact transition without changing durable state twice", async () => {
    const { root, repository } = await createWorkspace();
    const created = await createUncontractedItem(repository);
    const controller = createController(repository);
    await controller.updateGoalContract(created.goal.work_item_id, firstContract);
    const input = {
      target_phase: "spec" as const,
      target_status: "active" as const,
      expected_phase: "idea" as const,
      expected_status: "active" as const,
      expected_schema_version: 2 as const,
      expected_goal_version: 1,
      expected_input_revision: 1,
      attempt: 0,
    };

    const applied = await controller.transition(created.goal.work_item_id, input);
    expect(applied.work_item.state).toMatchObject({
      phase: "spec",
      status: "active",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
    });
    const durableAfterFirst = await repository.read(created.goal.work_item_id);

    const replay = await controller.transition(created.goal.work_item_id, input);
    expect(replay).toEqual(applied);
    expect(await repository.read(created.goal.work_item_id)).toEqual(
      durableAfterFirst,
    );
    expect(
      await readdir(
        join(
          root,
          ".founder",
          "work-items",
          created.goal.work_item_id,
          "runs",
        ),
      ),
    ).toHaveLength(2);
  });

  it("rejects missing contracts, stale expectations, invalid moves, and attempt conflicts", async () => {
    const { repository } = await createWorkspace();
    const created = await createUncontractedItem(repository);
    const controller = createController(repository);

    await expect(
      controller.transition(created.goal.work_item_id, {
        target_phase: "spec",
        target_status: "active",
        expected_phase: "idea",
        expected_status: "active",
        expected_schema_version: 2,
        expected_goal_version: 1,
        expected_input_revision: 1,
        attempt: 0,
      }),
    ).rejects.toMatchObject({ kind: "contract_required" });

    await controller.updateGoalContract(created.goal.work_item_id, firstContract);
    const contracted = await repository.read(created.goal.work_item_id);

    const cases = [
      {
        kind: "stale_expectation",
        input: {
          target_phase: "spec" as const,
          target_status: "active" as const,
          expected_phase: "plan" as const,
          expected_status: "active" as const,
          expected_schema_version: 2 as const,
          expected_goal_version: 1,
          expected_input_revision: 1,
          attempt: 0,
        },
      },
      {
        kind: "invalid_transition",
        input: {
          target_phase: "ship" as const,
          target_status: "active" as const,
          expected_phase: "idea" as const,
          expected_status: "active" as const,
          expected_schema_version: 2 as const,
          expected_goal_version: 1,
          expected_input_revision: 1,
          attempt: 0,
        },
      },
      {
        kind: "attempt_conflict",
        input: {
          target_phase: "spec" as const,
          target_status: "active" as const,
          expected_phase: "idea" as const,
          expected_status: "active" as const,
          expected_schema_version: 2 as const,
          expected_goal_version: 1,
          expected_input_revision: 1,
          attempt: 1,
        },
      },
    ];

    for (const testCase of cases) {
      const promise = controller.transition(
        created.goal.work_item_id,
        testCase.input,
      );
      await expect(promise).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ControllerConflictError &&
          error.kind === testCase.kind,
      );
      expect(await repository.read(created.goal.work_item_id)).toEqual(
        contracted,
      );
    }
  });

  it("imports a green result once and replays immutable evidence without rerunning", async () => {
    const { repository, workItem, input, evidence, evidenceWrites } =
      await createImportFixture();
    const commandNames: string[] = [];
    const runner: VerificationRunner = {
      async run(command) {
        commandNames.push(command.name);
        return passingRunner.run(command);
      },
    };
    const controller = createController(repository, passingGit, runner);

    const imported = await controller.importExternalResult(
      workItem.goal.work_item_id,
      input,
    );
    expect(imported.work_item.state).toMatchObject({
      phase: "review",
      status: "active",
      attempt: 0,
    });
    expect(imported.evidence).toMatchObject({ outcome: "applied" });
    expect(commandNames).toEqual(["Tests", "Typecheck"]);
    expect(evidenceWrites.count).toBe(1);

    const replay = await controller.importExternalResult(
      imported.work_item.goal.work_item_id,
      input,
    );
    expect(replay).toEqual(imported);
    expect(commandNames).toEqual(["Tests", "Typecheck"]);
    expect(evidenceWrites.count).toBe(1);
    expect(evidence.size).toBe(1);
  });

  it.each(["failed", "timed_out", "spawn_error"] as const)(
    "blocks on a %s command, marks remaining checks not-run, and starts one repair attempt",
    async (status) => {
      const { repository, workItem, input, evidence } =
        await createImportFixture();
      let commandRuns = 0;
      const redRunner: VerificationRunner = {
        async run(command) {
          commandRuns += 1;
          return {
            ...(await passingRunner.run(command)),
            status,
            exit_code: status === "failed" ? 1 : null,
            signal: status === "timed_out" ? "SIGKILL" : null,
            stderr: `${status} verification`,
          };
        },
      };
      const controller = createController(repository, passingGit, redRunner);

      const imported = await controller.importExternalResult(
        workItem.goal.work_item_id,
        input,
      );
      expect(imported.work_item.state).toMatchObject({
        phase: "execute",
        status: "blocked",
        attempt: 0,
      });
      expect(imported.evidence.outcome).toBe("failed");
      expect(imported.manifest.outcome).toBe("applied");
      expect(commandRuns).toBe(1);
      expect(
        [...evidence.values()][0].verification.map((record) => record.status),
      ).toEqual([status, "not_run"]);

      const retried = await controller.retryExecuteAttempt(
        workItem.goal.work_item_id,
        {
          expected_phase: "execute",
          expected_status: "blocked",
          expected_schema_version: 2,
          expected_goal_version: input.expected_goal_version,
          expected_input_revision: input.expected_input_revision,
          attempt: 0,
        },
      );
      expect(retried.work_item.state).toMatchObject({
        phase: "execute",
        status: "active",
        attempt: 1,
      });
      expect(
        await controller.retryExecuteAttempt(workItem.goal.work_item_id, {
          expected_phase: "execute",
          expected_status: "blocked",
          expected_schema_version: 2,
          expected_goal_version: input.expected_goal_version,
          expected_input_revision: input.expected_input_revision,
          attempt: 0,
        }),
      ).toEqual(retried);
    },
  );

  it("releases the controller lease after timed-out verification blocks an import", async () => {
    const { repository, workItem, input } = await createImportFixture();
    const timedOutRunner: VerificationRunner = {
      async run(command) {
        return {
          ...(await passingRunner.run(command)),
          status: "timed_out",
          exit_code: null,
          signal: "SIGKILL",
          stderr: "timed_out verification",
        };
      },
    };
    const controller = createController(
      repository,
      passingGit,
      timedOutRunner,
    );

    const imported = await controller.importExternalResult(
      workItem.goal.work_item_id,
      input,
    );

    expect(imported.work_item.state).toMatchObject({
      phase: "execute",
      status: "blocked",
    });
    expect(imported.evidence.outcome).toBe("failed");
    expect(
      await readdir(
        join(
          repository.workspaceRoot,
          ".founder",
          "work-items",
          workItem.goal.work_item_id,
        ),
      ),
    ).not.toContain(".controller.lock");
    expect(
      (await repository.read(workItem.goal.work_item_id))?.state.active_run,
    ).toBeUndefined();
  });

  it("preserves malformed and out-of-scope submissions as rejected evidence", async () => {
    const malformed = await createImportFixture({ resultSource: "{invalid" });
    const malformedController = createController(malformed.repository);
    const malformedResult = await malformedController.importExternalResult(
      malformed.workItem.goal.work_item_id,
      malformed.input,
    );
    expect(malformedResult.work_item.state.status).toBe("blocked");
    expect(malformedResult.evidence).toMatchObject({ outcome: "rejected" });
    expect(malformedResult.manifest.outcome).toBe("applied");
    expect([...malformed.evidence.values()][0].evidence.reasons).toContain(
      "result.json is not valid JSON.",
    );

    const outside = await createImportFixture();
    const outsideGit: GitVerificationAdapter = {
      ...passingGit,
      async listChangedFiles() {
        return ["src/outside.ts"];
      },
    };
    const outsideResult = await createController(
      outside.repository,
      outsideGit,
    ).importExternalResult(outside.workItem.goal.work_item_id, outside.input);
    expect(outsideResult.work_item.state.status).toBe("blocked");
    expect(outsideResult.evidence).toMatchObject({ outcome: "rejected" });
    expect(outsideResult.evidence.reasons[0]).toContain("allowed_scope");
  });

  it.each([
    {
      name: "a mismatched mission hash",
      transformResult: (result: ExecuteExternalResultSubmission) => ({
        ...result,
        mission_content_sha256: "f".repeat(64),
      }),
      git: passingGit,
      reason: "mission hash",
    },
    {
      name: "a mismatched governed tuple",
      transformResult: (result: ExecuteExternalResultSubmission) => ({
        ...result,
        identity: { ...result.identity, attempt: result.identity.attempt + 1 },
      }),
      git: passingGit,
      reason: "identity",
    },
    {
      name: "a non-commit object",
      git: { ...passingGit, resolveCommit: async () => null },
      reason: "canonical local commit",
    },
    {
      name: "a non-descendant commit",
      git: { ...passingGit, isAncestor: async () => false },
      reason: "not an ancestor",
    },
    {
      name: "a commit that is not HEAD",
      git: { ...passingGit, readHeadCommit: async () => "b".repeat(40) },
      reason: "HEAD",
    },
    {
      name: "a dirty worktree",
      git: {
        ...passingGit,
        isWorktreeCleanExcludingFounder: async () => false,
      },
      reason: "uncommitted changes",
    },
    {
      name: "an empty Git diff",
      git: { ...passingGit, listChangedFiles: async () => [] },
      reason: "no changed files",
    },
    {
      name: "reported files that differ from Git",
      transformResult: (result: ExecuteExternalResultSubmission) => ({
        ...result,
        changed_files: ["src/application/work-item-controller.ts"],
      }),
      git: passingGit,
      reason: "do not exactly match",
    },
  ])("rejects $name before verification or state advance", async (testCase) => {
    const fixture = await createImportFixture({
      transformResult: testCase.transformResult,
    });
    let commandRuns = 0;
    const runner: VerificationRunner = {
      async run(command) {
        commandRuns += 1;
        return passingRunner.run(command);
      },
    };

    const imported = await createController(
      fixture.repository,
      testCase.git,
      runner,
    ).importExternalResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.work_item.state).toMatchObject({
      phase: "execute",
      status: "blocked",
      attempt: 0,
    });
    expect(imported.evidence).toMatchObject({ outcome: "rejected" });
    expect(imported.evidence.reasons.join(" ")).toContain(testCase.reason);
    expect(commandRuns).toBe(0);
  });

  it("imports review findings once without commands or a work-item transition", async () => {
    const fixture = await createReviewImportFixture({
      transformResult: (result) => ({
        ...result,
        summary: "Review found one correctness issue.",
        verdict: "findings",
        findings: [
          {
            finding_id: "F-1",
            severity: "P1",
            title: "Preserve immutable evidence",
            evidence: {
              path: "src/application/work-item-controller.ts",
              summary: "The rejected branch must not mutate controller state.",
            },
            required_action: "Keep rejected review imports evidence-only.",
            link: {
              type: "acceptance_criteria",
              criterion: "Reject stale transitions",
            },
          },
        ],
      }),
    });
    const before = await fixture.repository.read(
      fixture.workItem.goal.work_item_id,
    );
    let commandRuns = 0;
    const runner: VerificationRunner = {
      async run(command) {
        commandRuns += 1;
        return passingRunner.run(command);
      },
    };
    const controller = createController(
      fixture.repository,
      passingGit,
      runner,
    );

    const imported = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(imported.work_item).toEqual(before);
    expect(await fixture.repository.read(fixture.workItem.goal.work_item_id))
      .toEqual(before);
    expect(imported).toMatchObject({
      manifest: { phase: "review", outcome: "applied" },
      evidence: { phase: "review", outcome: "applied" },
      result: { verdict: "findings", findings: [{ finding_id: "F-1" }] },
    });
    expect([...fixture.evidence.values()][0].verification).toEqual([]);
    expect(commandRuns).toBe(0);
    expect(fixture.evidenceWrites.count).toBe(1);

    const replay = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(replay).toEqual(imported);
    expect(commandRuns).toBe(0);
    expect(fixture.evidenceWrites.count).toBe(1);
    expect(fixture.evidence.size).toBe(1);
  });

  it.each<{
    name: string;
    link: ReviewFindingLink;
    reason: string;
  }>([
    {
      name: "an unknown acceptance criterion",
      link: {
        type: "acceptance_criteria",
        criterion: "A criterion that is not in the pinned goal",
      },
      reason: "acceptance criterion",
    },
    {
      name: "an unknown non-goal",
      link: {
        type: "non_goals",
        non_goal: "A non-goal that is not in the pinned goal",
      },
      reason: "non-goal",
    },
    {
      name: "an unknown deterministic check",
      link: { type: "deterministic_checks", command: "npm run unknown" },
      reason: "deterministic check",
    },
  ])("rejects a review finding linked to $name", async ({ link, reason }) => {
    const fixture = await createReviewImportFixture({
      transformResult: (result) => ({
        ...result,
        summary: "Review finding names an unpinned contract target.",
        verdict: "findings",
        findings: [
          {
            finding_id: "F-unpinned",
            severity: "P1",
            title: "Unpinned finding target",
            evidence: { summary: "The target is not in the review mission." },
            required_action: "Link the finding to an exact pinned target.",
            link,
          },
        ],
      }),
    });
    const before = await fixture.repository.read(
      fixture.workItem.goal.work_item_id,
    );
    let commandRuns = 0;
    const runner: VerificationRunner = {
      async run(command) {
        commandRuns += 1;
        return passingRunner.run(command);
      },
    };

    const imported = await createController(
      fixture.repository,
      passingGit,
      runner,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.manifest).toBeNull();
    expect(imported.evidence).toMatchObject({ outcome: "rejected" });
    expect(imported.evidence.reasons.join(" ")).toContain(reason);
    expect(imported.work_item).toEqual(before);
    expect(commandRuns).toBe(0);
    expect(fixture.evidenceWrites.count).toBe(1);
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .active_run,
    ).toBeUndefined();
    expect(
      await readdir(
        join(
          fixture.repository.workspaceRoot,
          ".founder",
          "work-items",
          fixture.workItem.goal.work_item_id,
        ),
      ),
    ).not.toContain(".controller.lock");
  });

  it("preserves malformed review output as replayable rejected evidence only", async () => {
    const fixture = await createReviewImportFixture({ resultSource: "{invalid" });
    const before = await fixture.repository.read(
      fixture.workItem.goal.work_item_id,
    );
    const runsDirectory = join(
      fixture.repository.workspaceRoot,
      ".founder",
      "work-items",
      fixture.workItem.goal.work_item_id,
      "runs",
    );
    const runsBefore = await readdir(runsDirectory);
    const controller = createController(fixture.repository);

    const imported = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(imported).toMatchObject({
      manifest: null,
      evidence: {
        phase: "review",
        outcome: "rejected",
        reasons: ["result.json is not valid JSON."],
      },
    });
    expect(imported.result).toBeUndefined();
    expect(imported.work_item).toEqual(before);
    expect(await fixture.repository.read(fixture.workItem.goal.work_item_id))
      .toEqual(before);
    expect(await readdir(runsDirectory)).toEqual(runsBefore);

    const replay = await controller.importReviewResult(
      fixture.workItem.goal.work_item_id,
      fixture.input,
    );
    expect(replay).toEqual(imported);
    expect(fixture.evidenceWrites.count).toBe(1);
    expect(
      await readdir(
        join(
          fixture.repository.workspaceRoot,
          ".founder",
          "work-items",
          fixture.workItem.goal.work_item_id,
        ),
      ),
    ).not.toContain(".controller.lock");
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .active_run,
    ).toBeUndefined();
  });

  it("recovers an applied review import from evidence written before a failed commit", async () => {
    const fixture = await createReviewImportFixture();
    const commit = fixture.repository.commitControllerMutation.bind(
      fixture.repository,
    );
    Object.assign(fixture.repository, {
      async commitControllerMutation() {
        throw new Error("simulated state-preserving commit failure");
      },
    });
    const controller = createController(fixture.repository);

    await expect(
      controller.importReviewResult(
        fixture.workItem.goal.work_item_id,
        fixture.input,
      ),
    ).rejects.toThrow("simulated state-preserving commit failure");
    expect(fixture.evidenceWrites.count).toBe(1);
    expect([...fixture.evidence.values()][0]).toMatchObject({
      evidence: { phase: "review", outcome: "applied" },
      verification: [],
    });
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .active_run,
    ).toBeUndefined();

    Object.assign(fixture.repository, { commitControllerMutation: commit });
    const recovered = await createController(
      fixture.repository,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);
    expect(recovered).toMatchObject({
      manifest: { phase: "review", outcome: "applied" },
      evidence: { phase: "review", outcome: "applied" },
      result: { verdict: "clean", findings: [] },
    });
    expect(fixture.evidenceWrites.count).toBe(1);
  });

  it.each([
    {
      name: "a changed HEAD",
      git: { ...passingGit, readHeadCommit: async () => "b".repeat(40) },
      reason: "HEAD",
    },
    {
      name: "a dirty worktree",
      git: {
        ...passingGit,
        isWorktreeCleanExcludingFounder: async () => false,
      },
      reason: "uncommitted changes",
    },
  ])("rejects review import for $name without mutating state", async ({ git, reason }) => {
    const fixture = await createReviewImportFixture();
    const before = await fixture.repository.read(
      fixture.workItem.goal.work_item_id,
    );

    const imported = await createController(
      fixture.repository,
      git,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.manifest).toBeNull();
    expect(imported.evidence).toMatchObject({ outcome: "rejected" });
    expect(imported.evidence.reasons.join(" ")).toContain(reason);
    expect(imported.work_item).toEqual(before);
    expect(await fixture.repository.read(fixture.workItem.goal.work_item_id))
      .toEqual(before);
    expect(
      (await fixture.repository.read(fixture.workItem.goal.work_item_id))?.state
        .active_run,
    ).toBeUndefined();
    expect(
      await readdir(
        join(
          fixture.repository.workspaceRoot,
          ".founder",
          "work-items",
          fixture.workItem.goal.work_item_id,
        ),
      ),
    ).not.toContain(".controller.lock");
  });

  it.each([
    {
      name: "a mismatched review mission hash",
      options: {
        transformResult: (result: ReviewExternalResultSubmission) => ({
          ...result,
          review_mission_content_sha256: "f".repeat(64),
        }),
      },
      reason: "mission hash",
    },
    {
      name: "a stale execute subject",
      options: {
        transformCurrentSubject: (subject: ReviewSubject) => ({
          ...subject,
          accepted_result_commit: "b".repeat(40),
        }),
      },
      reason: "stale",
    },
  ])("rejects review import for $name without a controller run", async ({ options, reason }) => {
    const fixture = await createReviewImportFixture(options);
    const imported = await createController(
      fixture.repository,
    ).importReviewResult(fixture.workItem.goal.work_item_id, fixture.input);

    expect(imported.manifest).toBeNull();
    expect(imported.evidence).toMatchObject({ outcome: "rejected" });
    expect(imported.evidence.reasons.join(" ")).toContain(reason);
  });

  it("rejects repair attempts unless execute is blocked at the exact tuple", async () => {
    const { repository, workItem, input } = await createImportFixture();
    await expect(
      createController(repository).retryExecuteAttempt(
        workItem.goal.work_item_id,
        {
          expected_phase: "execute",
          expected_status: "blocked",
          expected_schema_version: 2,
          expected_goal_version: input.expected_goal_version,
          expected_input_revision: input.expected_input_revision,
          attempt: input.attempt,
        },
      ),
    ).rejects.toMatchObject({ kind: "stale_expectation" });
  });

  it("derives the transition idempotency key from exactly the governed tuple", () => {
    expect(
      deriveControllerIdempotencyKey(
        "wi_123e4567-e89b-12d3-a456-426614174000",
        "review",
        3,
        5,
        2,
      ),
    ).toBe(
      "wi_123e4567-e89b-12d3-a456-426614174000:review:3:5:2",
    );
  });
});
