import { describe, expect, it } from "vitest";

import {
  compileMission,
  compilePatchMission,
  compileReviewMission,
  hashMissionContent,
  missionPackageSchema,
  patchSubjectSchema,
  renderTaskMd,
  reviewSubjectSchema,
  serializeMissionPackage,
  type ExecuteReviewSubject,
  type MissionPaths,
  type PatchMissionControllerRun,
  type PatchReviewSubject,
  type PatchSubject,
  type ReviewMissionControllerRun,
} from "../../src/domain/mission";
import type {
  ControllerRunManifest,
  WorkItem,
} from "../../src/domain/work-item";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const runId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";

const workItem: WorkItem = {
  goal: {
    schema_version: 2,
    work_item_id: workItemId,
    title: "Compile a portable mission",
    type: "Feature",
    goal_contract: {
      schema_version: 1,
      goal_version: 2,
      purpose: "Keep the package deterministic.",
      acceptance_criteria: ["The package is deterministic"],
      non_goals: ["Do not depend on provider-specific behavior."],
      allowed_scope: ["src/domain", "tests/domain"],
      review_ready: ["All deterministic checks pass"],
    },
  },
  state: {
    schema_version: 2,
    work_item_id: workItemId,
    phase: "execute",
    status: "active",
    updated_at: "2026-07-22T12:00:01.000Z",
    goal_version: 2,
    input_revision: 3,
    attempt: 1,
    patch_cycle: 0,
  },
};

const executeManifest: ControllerRunManifest = {
  schema_version: 1,
  run_id: runId,
  work_item_id: workItemId,
  idempotency_key: `${workItemId}:execute:2:3:1`,
  phase: "execute",
  goal_version: 2,
  input_revision: 3,
  attempt: 1,
  started_at: "2026-07-22T12:00:00.000Z",
  completed_at: "2026-07-22T12:00:01.000Z",
  outcome: "applied",
};

const paths: MissionPaths = {
  task_path: `.founder/missions/${workItemId}/execute-2-3-1/TASK.md`,
  output_path: `.founder/missions/${workItemId}/execute-2-3-1/result.json`,
  git_base_commit: "1".repeat(40),
};

const reviewWorkItem: WorkItem = {
  ...workItem,
  state: {
    ...workItem.state,
    phase: "review",
    updated_at: "2026-07-22T12:00:02.000Z",
  },
};

const reviewControllerRun: ReviewMissionControllerRun = {
  schema_version: 1,
  run_id: runId,
  work_item_id: workItemId,
  idempotency_key: `${workItemId}:review:2:3:1`,
  phase: "review",
  goal_version: 2,
  input_revision: 3,
  attempt: 1,
  started_at: "2026-07-22T12:00:00.000Z",
  completed_at: "2026-07-22T12:00:01.000Z",
  outcome: "applied",
};

const reviewSubject: ExecuteReviewSubject = {
  source: "execute",
  execute_mission_content_sha256: "a".repeat(64),
  execute_result_content_sha256: "b".repeat(64),
  git_base_commit: paths.git_base_commit,
  accepted_result_commit: "c".repeat(40),
  changed_files: ["src/domain/mission.ts", "tests/domain/mission.test.ts"],
  execute_mission_path: `.founder/missions/${workItemId}/execute-2-3-1/mission.json`,
  execute_evidence_path: `.founder/run-evidence/${workItemId}/execute-2-3-1/${"d".repeat(64)}`,
  command_evidence: [
    {
      name: "Tests",
      argv: ["npm", "test"],
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      duration_ms: 1_000,
      status: "passed",
      exit_code: 0,
      signal: null,
      stdout: "18 files passed",
      stderr: "",
      output_truncated: false,
    },
  ],
};

const reviewPaths: MissionPaths = {
  task_path: `.founder/missions/${workItemId}/review-2-3-1/TASK.md`,
  output_path: `.founder/missions/${workItemId}/review-2-3-1/result.json`,
  git_base_commit: paths.git_base_commit,
};

const patchWorkItem: WorkItem = {
  ...reviewWorkItem,
  state: {
    ...reviewWorkItem.state,
    phase: "patch",
    patch_cycle: 1,
    updated_at: "2026-07-22T12:00:03.000Z",
  },
};

const patchControllerRun: PatchMissionControllerRun = {
  schema_version: 1,
  run_id: "77777777-7777-4777-8777-777777777777",
  work_item_id: workItemId,
  idempotency_key: `${workItemId}:patch:2:3:1:1`,
  phase: "patch",
  goal_version: 2,
  input_revision: 3,
  attempt: 1,
  started_at: "2026-07-22T12:00:02.000Z",
  completed_at: "2026-07-22T12:00:03.000Z",
  outcome: "applied",
};

const patchSubject: PatchSubject = {
  review_mission_content_sha256: "d".repeat(64),
  review_result_content_sha256: "e".repeat(64),
  review_mission_path: `.founder/missions/${workItemId}/review-2-3-1/mission.json`,
  review_result_path: `.founder/missions/${workItemId}/review-2-3-1/result.json`,
  review_evidence_path: `.founder/run-evidence/${workItemId}/review-2-3-1/${"f".repeat(64)}`,
  reviewed_commit: reviewSubject.accepted_result_commit,
  findings: [
    {
      finding_id: "F-001",
      severity: "P1",
      title: "Preserve the active contract",
      evidence: {
        path: "src/domain/mission.ts",
        summary: "The patch must retain strict schema validation.",
      },
      required_action: "Keep the patch package phase-discriminated.",
      link: {
        type: "acceptance_criteria",
        criterion: "The package is deterministic",
      },
    },
    {
      finding_id: "F-002",
      severity: "P2",
      title: "Keep the task bounded",
      evidence: { summary: "The patch task must cover only listed findings." },
      required_action: "Render every assigned finding in TASK.md.",
      link: { type: "defect", evidence_summary: "Missing patch boundary." },
    },
  ],
  prior_review_subject: reviewSubject,
};

const patchPaths: MissionPaths = {
  task_path: `.founder/missions/${workItemId}/patch-2-3-1-1/TASK.md`,
  output_path: `.founder/missions/${workItemId}/patch-2-3-1-1/result.json`,
  git_base_commit: patchSubject.reviewed_commit,
};

const patchReviewSubject: PatchReviewSubject = {
  source: "patch",
  patch_cycle: 1,
  patch_mission_content_sha256: "1".repeat(64),
  patch_result_content_sha256: "2".repeat(64),
  git_base_commit: patchSubject.reviewed_commit,
  accepted_result_commit: "3".repeat(40),
  changed_files: ["src/domain/mission.ts"],
  patch_mission_path: `.founder/missions/${workItemId}/patch-2-3-1-1/mission.json`,
  patch_evidence_path: `.founder/run-evidence/${workItemId}/patch-2-3-1-1/${"4".repeat(64)}`,
  command_evidence: reviewSubject.command_evidence,
  resolved_from: {
    review_mission_content_sha256:
      patchSubject.review_mission_content_sha256,
    review_result_content_sha256: patchSubject.review_result_content_sha256,
    finding_ids: ["F-001", "F-002"],
  },
};

describe("mission domain", () => {
  it("compiles stable canonical package and Markdown bytes", () => {
    const first = compileMission(workItem, executeManifest, paths);
    const second = compileMission(workItem, executeManifest, paths);

    expect(second).toEqual(first);
    expect(serializeMissionPackage(second)).toBe(serializeMissionPackage(first));
    expect(renderTaskMd(second)).toBe(renderTaskMd(first));
    expect(first.content_sha256).toBe(
      "cfd32dc901956d7371b8e3afb950b4f8ce17e7f7c3eae28386f8984d5c4c61b1",
    );
    expect(first.mission_schema_version).toBe(4);
    expect(first.identity.phase).toBe("execute");
    expect(first.source_revision.git_base_commit).toBe(paths.git_base_commit);
    expect(first.result_contract).toEqual({
      schema_version: 4,
      output_path: paths.output_path,
      result_schema_version: 2,
      required_fields: [
        "result_schema_version",
        "mission_content_sha256",
        "identity",
        "commit",
        "summary",
        "changed_files",
        "verification",
      ],
    });
  });

  it("hashes the canonical field order after JSON key reordering", () => {
    const mission = compileMission(workItem, executeManifest, paths);
    const reordered = {
      content_sha256: mission.content_sha256,
      task_path: mission.task_path,
      result_contract: mission.result_contract,
      source_revision: mission.source_revision,
      goal: mission.goal,
      controller_run: mission.controller_run,
      identity: mission.identity,
      mission_schema_version: mission.mission_schema_version,
    };

    expect(hashMissionContent(reordered)).toBe(mission.content_sha256);
    expect(missionPackageSchema.parse(reordered)).toEqual(mission);
  });

  it("changes identity or hash when governed inputs change", () => {
    const mission = compileMission(workItem, executeManifest, paths);
    const nextTupleItem: WorkItem = {
      ...workItem,
      state: { ...workItem.state, input_revision: 4 },
    };
    const nextTupleManifest = {
      ...executeManifest,
      input_revision: 4,
      idempotency_key: `${workItemId}:execute:2:4:1`,
    };
    const nextTuplePaths = {
      task_path: `.founder/missions/${workItemId}/execute-2-4-1/TASK.md`,
      output_path: `.founder/missions/${workItemId}/execute-2-4-1/result.json`,
      git_base_commit: paths.git_base_commit,
    };
    const nextTupleMission = compileMission(
      nextTupleItem,
      nextTupleManifest,
      nextTuplePaths,
    );
    const changedGoalMission = compileMission(
      {
        ...workItem,
        goal: { ...workItem.goal, title: "Compile a revised portable mission" },
      },
      executeManifest,
      paths,
    );
    const changedBaseMission = compileMission(workItem, executeManifest, {
      ...paths,
      git_base_commit: "2".repeat(40),
    });
    const changedResultContractHash = hashMissionContent({
      ...mission,
      result_contract: {
        ...mission.result_contract,
        output_path: `.founder/missions/${workItemId}/execute-2-3-1/alternate/result.json`,
      },
    });

    expect(nextTupleMission.identity).not.toEqual(mission.identity);
    expect(nextTupleMission.content_sha256).not.toBe(mission.content_sha256);
    expect(changedGoalMission.identity).toEqual(mission.identity);
    expect(changedGoalMission.content_sha256).not.toBe(mission.content_sha256);
    expect(changedBaseMission.identity).toEqual(mission.identity);
    expect(changedBaseMission.content_sha256).not.toBe(mission.content_sha256);
    expect(changedResultContractHash).not.toBe(mission.content_sha256);
  });

  it.each([
    {
      name: "an incomplete goal contract",
      item: {
        ...workItem,
        goal: {
          ...workItem.goal,
          goal_contract: {
            ...workItem.goal.goal_contract,
            acceptance_criteria: undefined,
          },
        },
      },
      manifest: executeManifest,
      missionPaths: paths,
    },
    {
      name: "an invalid work-item schema version",
      item: {
        ...workItem,
        goal: { ...workItem.goal, schema_version: 1 },
      },
      manifest: executeManifest,
      missionPaths: paths,
    },
    {
      name: "a non-execute work item",
      item: { ...workItem, state: { ...workItem.state, phase: "review" } },
      manifest: executeManifest,
      missionPaths: paths,
    },
    {
      name: "a non-applied manifest",
      item: workItem,
      manifest: { ...executeManifest, outcome: "failed" },
      missionPaths: paths,
    },
    {
      name: "a tuple-mismatched manifest",
      item: workItem,
      manifest: { ...executeManifest, input_revision: 4 },
      missionPaths: paths,
    },
    {
      name: "an unsafe result path",
      item: workItem,
      manifest: executeManifest,
      missionPaths: { ...paths, output_path: "../result.json" },
    },
    {
      name: "paths in different mission directories",
      item: workItem,
      manifest: executeManifest,
      missionPaths: {
        ...paths,
        output_path: `.founder/missions/${workItemId}/elsewhere/result.json`,
      },
    },
  ])("rejects $name", ({ item, manifest, missionPaths }) => {
    expect(() =>
      compileMission(
        item as WorkItem,
        manifest as ControllerRunManifest,
        missionPaths,
      ),
    ).toThrow();
  });

  it("rejects tampered or extended packages", () => {
    const mission = compileMission(workItem, executeManifest, paths);

    expect(() =>
      missionPackageSchema.parse({ ...mission, provider: "not-in-version-3" }),
    ).toThrow();
    expect(() =>
      missionPackageSchema.parse({ ...mission, mission_schema_version: 2 }),
    ).toThrow();
    expect(() =>
      missionPackageSchema.parse({ ...mission, content_sha256: "0".repeat(64) }),
    ).toThrow("content_sha256 must match the canonical mission content");
  });

  it("renders a neutral handoff and the explicit next gate", () => {
    const task = renderTaskMd(compileMission(workItem, executeManifest, paths));

    expect(task).toContain(`Write the structured result to \`${paths.output_path}\`.`);
    expect(task).toContain("Commit the code changes before returning the result.");
    expect(task).toContain('"mission_content_sha256"');
    expect(task).toContain('"commit"');
    expect(task).toContain(
      "The controller validates the commit and runs the authoritative checks.",
    );
    expect(task).toContain(
      "Return the result for validation; do not advance controller state.",
    );
    expect(task.toLowerCase()).not.toMatch(
      /codex|claude|openai|anthropic|copilot|gemini/,
    );
  });

  it("compiles a stable phase-distinct review package bound to immutable evidence", () => {
    const input = {
      work_item: reviewWorkItem,
      controller_run: reviewControllerRun,
      review_subject: reviewSubject,
      paths: reviewPaths,
      independence_attested: true as const,
    };
    const first = compileReviewMission(input);
    const second = compileReviewMission(input);
    const execute = compileMission(workItem, executeManifest, paths);

    expect(second).toEqual(first);
    expect(serializeMissionPackage(second)).toBe(serializeMissionPackage(first));
    expect(first.content_sha256).toBe(
      "f9f72c73e54e455ec3af6009f57026235b7b5bae7251570ab388fc278f133230",
    );
    expect(first.content_sha256).not.toBe(execute.content_sha256);
    expect(first.identity.phase).toBe("review");
    expect(first.controller_run.phase).toBe("review");
    expect(first.independence_attested).toBe(true);
    expect(first.review_subject).toEqual(reviewSubject);
    expect(first.result_contract.schema_version).toBe(4);
  });

  it("binds the review package hash to the immutable review subject", () => {
    const input = {
      work_item: reviewWorkItem,
      controller_run: reviewControllerRun,
      review_subject: reviewSubject,
      paths: reviewPaths,
      independence_attested: true as const,
    };
    const original = compileReviewMission(input);
    const changedSubject = compileReviewMission({
      ...input,
      review_subject: {
        ...reviewSubject,
        accepted_result_commit: "f".repeat(40),
      },
    });

    expect(changedSubject.identity).toEqual(original.identity);
    expect(changedSubject.content_sha256).not.toBe(original.content_sha256);
    expect(changedSubject.review_subject.accepted_result_commit).toBe(
      "f".repeat(40),
    );
    expect(changedSubject.independence_attested).toBe(true);
  });

  it("round-trips execute and patch review subjects without hybrid shapes", () => {
    expect(reviewSubjectSchema.parse(reviewSubject)).toEqual(reviewSubject);
    expect(reviewSubjectSchema.parse(patchReviewSubject)).toEqual(
      patchReviewSubject,
    );
    expect(() =>
      reviewSubjectSchema.parse({
        ...reviewSubject,
        source: "patch",
        patch_mission_content_sha256: "1".repeat(64),
      }),
    ).toThrow();
  });

  it("compiles a patch-subject re-review into its own cycle-qualified path", () => {
    const mission = compileReviewMission({
      work_item: {
        ...reviewWorkItem,
        state: {
          ...reviewWorkItem.state,
          patch_cycle: 1,
        },
      },
      controller_run: reviewControllerRun,
      review_subject: patchReviewSubject,
      paths: {
        task_path: `.founder/missions/${workItemId}/review-2-3-1-patch-1/TASK.md`,
        output_path: `.founder/missions/${workItemId}/review-2-3-1-patch-1/result.json`,
        git_base_commit: patchReviewSubject.git_base_commit,
      },
      independence_attested: true,
    });

    expect(mission.review_subject).toEqual(patchReviewSubject);
    expect(mission.task_path).toContain("review-2-3-1-patch-1");
    expect(mission.result_contract.required_fields).toContain("resolutions");
  });

  it("compiles a canonical phase-qualified patch package", () => {
    const input = {
      work_item: patchWorkItem,
      controller_run: patchControllerRun,
      patch_subject: patchSubject,
      paths: patchPaths,
    };
    const first = compilePatchMission(input);
    const second = compilePatchMission(input);
    const reordered = {
      content_sha256: first.content_sha256,
      task_path: first.task_path,
      result_contract: first.result_contract,
      patch_subject: {
        prior_review_subject: first.patch_subject.prior_review_subject,
        findings: first.patch_subject.findings,
        reviewed_commit: first.patch_subject.reviewed_commit,
        review_evidence_path: first.patch_subject.review_evidence_path,
        review_result_path: first.patch_subject.review_result_path,
        review_mission_path: first.patch_subject.review_mission_path,
        review_result_content_sha256:
          first.patch_subject.review_result_content_sha256,
        review_mission_content_sha256:
          first.patch_subject.review_mission_content_sha256,
      },
      source_revision: first.source_revision,
      goal: first.goal,
      controller_run: first.controller_run,
      identity: first.identity,
      mission_schema_version: first.mission_schema_version,
    };

    expect(second).toEqual(first);
    expect(first.identity).toMatchObject({ phase: "patch", patch_cycle: 1 });
    expect(first.task_path).toBe(patchPaths.task_path);
    expect(hashMissionContent(reordered)).toBe(first.content_sha256);
    expect(missionPackageSchema.parse(reordered)).toEqual(first);
    expect(renderTaskMd(first)).toContain(
      "Apply one bounded repair that addresses every finding listed below.",
    );
    expect(renderTaskMd(first)).toContain("F-001");
    expect(renderTaskMd(first)).toContain("F-002");
    expect(renderTaskMd(first)).toContain(
      "do not advance controller state or self-declare findings resolved",
    );
  });

  it("rejects reordered findings and execute-overloaded patch packages", () => {
    expect(() =>
      patchSubjectSchema.parse({
        ...patchSubject,
        findings: [...patchSubject.findings].reverse(),
      }),
    ).toThrow("patch findings must use canonical finding_id order");

    const patch = compilePatchMission({
      work_item: patchWorkItem,
      controller_run: patchControllerRun,
      patch_subject: patchSubject,
      paths: patchPaths,
    });
    expect(() =>
      missionPackageSchema.parse({
        ...patch,
        identity: {
          ...patch.identity,
          phase: "execute",
        },
      }),
    ).toThrow();

    expect(() =>
      compilePatchMission({
        work_item: patchWorkItem,
        controller_run: patchControllerRun,
        patch_subject: patchSubject,
        paths: {
          ...patchPaths,
          task_path: `.founder/missions/${workItemId}/patch-2-3-1/TASK.md`,
          output_path: `.founder/missions/${workItemId}/patch-2-3-1/result.json`,
        },
      }),
    ).toThrow("task_path must match the phase-qualified mission identity");
  });

  it("rejects legacy tuple-only mission paths", () => {
    const tupleDirectory = `.founder/missions/${workItemId}/2-3-1`;
    const tuplePaths = {
      ...paths,
      task_path: `${tupleDirectory}/TASK.md`,
      output_path: `${tupleDirectory}/result.json`,
    };

    expect(() => compileMission(workItem, executeManifest, tuplePaths)).toThrow(
      "task_path must match the phase-qualified mission identity",
    );
    expect(() =>
      compileReviewMission({
        work_item: reviewWorkItem,
        controller_run: reviewControllerRun,
        review_subject: reviewSubject,
        paths: tuplePaths,
        independence_attested: true,
      }),
    ).toThrow("task_path must match the phase-qualified mission identity");

    const mission = compileMission(workItem, executeManifest, paths);
    const legacyPackage = {
      ...mission,
      task_path: tuplePaths.task_path,
      result_contract: {
        ...mission.result_contract,
        output_path: tuplePaths.output_path,
      },
    };
    expect(() =>
      missionPackageSchema.parse({
        ...legacyPackage,
        content_sha256: hashMissionContent(legacyPackage),
      }),
    ).toThrow("task_path must match the phase-qualified mission identity");
  });

  it("renders review as a pinned read-only assessment without execution instructions", () => {
    const mission = compileReviewMission({
      work_item: reviewWorkItem,
      controller_run: reviewControllerRun,
      review_subject: reviewSubject,
      paths: reviewPaths,
      independence_attested: true,
    });
    const task = renderTaskMd(mission);

    expect(task).toContain(reviewSubject.accepted_result_commit);
    expect(task).toContain(reviewSubject.execute_mission_path);
    expect(task).toContain(reviewSubject.execute_evidence_path);
    expect(task).toContain("Do not modify workspace files");
    expect(task).toContain('"evidence_summary"');
    expect(task).not.toContain('"changed_files"');
    expect(task).not.toContain('"verification"');
    expect(task).not.toContain("Commit the code changes");
    expect(task).not.toMatch(/run (?:the )?checks/i);
    expect(task.toLowerCase()).not.toMatch(
      /codex|claude|openai|anthropic|copilot|gemini/,
    );
  });
});
