import { describe, expect, it } from "vitest";

import {
  compileMission,
  hashMissionContent,
  missionPackageSchema,
  renderTaskMd,
  serializeMissionPackage,
  type MissionPaths,
} from "../../src/domain/mission";
import type {
  ControllerRunManifest,
  WorkItem,
} from "../../src/domain/work-item";

const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const runId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";

const workItem: WorkItem = {
  goal: {
    schema_version: 1,
    work_item_id: workItemId,
    title: "Compile a portable mission",
    type: "Feature",
    goal_version: 2,
    acceptance_criteria: ["The package is deterministic"],
    allowed_scope: ["src/domain", "tests/domain"],
    review_ready: ["All deterministic checks pass"],
  },
  state: {
    schema_version: 1,
    work_item_id: workItemId,
    phase: "execute",
    status: "active",
    updated_at: "2026-07-22T12:00:01.000Z",
    goal_version: 2,
    input_revision: 3,
    attempt: 1,
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
  task_path: `.founder/missions/${workItemId}/2-3-1/TASK.md`,
  output_path: `.founder/missions/${workItemId}/2-3-1/result.json`,
  git_base_commit: "1".repeat(40),
};

describe("mission domain", () => {
  it("compiles stable canonical package and Markdown bytes", () => {
    const first = compileMission(workItem, executeManifest, paths);
    const second = compileMission(workItem, executeManifest, paths);

    expect(second).toEqual(first);
    expect(serializeMissionPackage(second)).toBe(serializeMissionPackage(first));
    expect(renderTaskMd(second)).toBe(renderTaskMd(first));
    expect(first.content_sha256).toBe(
      "1a1f78241c310faac7f31888ea03f1707de0fb94b68f90a7ea2d6a33d4be52f7",
    );
    expect(first.mission_schema_version).toBe(2);
    expect(first.source_revision.git_base_commit).toBe(paths.git_base_commit);
    expect(first.result_contract).toEqual({
      schema_version: 2,
      output_path: paths.output_path,
      result_schema_version: 1,
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
      task_path: `.founder/missions/${workItemId}/2-4-1/TASK.md`,
      output_path: `.founder/missions/${workItemId}/2-4-1/result.json`,
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

    expect(nextTupleMission.identity).not.toEqual(mission.identity);
    expect(nextTupleMission.content_sha256).not.toBe(mission.content_sha256);
    expect(changedGoalMission.identity).toEqual(mission.identity);
    expect(changedGoalMission.content_sha256).not.toBe(mission.content_sha256);
    expect(changedBaseMission.identity).toEqual(mission.identity);
    expect(changedBaseMission.content_sha256).not.toBe(mission.content_sha256);
  });

  it.each([
    {
      name: "an incomplete goal contract",
      item: {
        ...workItem,
        goal: { ...workItem.goal, acceptance_criteria: undefined },
      },
      manifest: executeManifest,
      missionPaths: paths,
    },
    {
      name: "an invalid work-item schema version",
      item: {
        ...workItem,
        goal: { ...workItem.goal, schema_version: 2 },
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
      missionPackageSchema.parse({ ...mission, provider: "not-in-version-2" }),
    ).toThrow();
    expect(() =>
      missionPackageSchema.parse({ ...mission, mission_schema_version: 1 }),
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
});
