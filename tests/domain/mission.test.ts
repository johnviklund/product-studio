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
};

describe("mission domain", () => {
  it("compiles stable canonical package and Markdown bytes", () => {
    const first = compileMission(workItem, executeManifest, paths);
    const second = compileMission(workItem, executeManifest, paths);

    expect(second).toEqual(first);
    expect(serializeMissionPackage(second)).toBe(serializeMissionPackage(first));
    expect(renderTaskMd(second)).toBe(renderTaskMd(first));
    expect(first.content_sha256).toBe(
      "0a629e14e3cd4a405baf078514e35e8e1bdcc34ccd9a6b4f6e3233293bfce745",
    );
    expect(first.result_contract).toEqual({
      schema_version: 1,
      output_path: paths.output_path,
      required_fields: ["summary", "changed_files", "verification"],
    });
  });

  it("hashes the canonical field order after JSON key reordering", () => {
    const mission = compileMission(workItem, executeManifest, paths);
    const reordered = {
      content_sha256: mission.content_sha256,
      task_path: mission.task_path,
      result_contract: mission.result_contract,
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

    expect(nextTupleMission.identity).not.toEqual(mission.identity);
    expect(nextTupleMission.content_sha256).not.toBe(mission.content_sha256);
    expect(changedGoalMission.identity).toEqual(mission.identity);
    expect(changedGoalMission.content_sha256).not.toBe(mission.content_sha256);
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
      missionPackageSchema.parse({ ...mission, provider: "not-in-version-1" }),
    ).toThrow();
    expect(() =>
      missionPackageSchema.parse({ ...mission, content_sha256: "0".repeat(64) }),
    ).toThrow("content_sha256 must match the canonical mission content");
  });

  it("renders a neutral handoff and the explicit next gate", () => {
    const task = renderTaskMd(compileMission(workItem, executeManifest, paths));

    expect(task).toContain(`Write the structured result to \`${paths.output_path}\`.`);
    expect(task).toContain(
      "Return the result for validation; do not advance controller state.",
    );
    expect(task.toLowerCase()).not.toMatch(
      /codex|claude|openai|anthropic|copilot|gemini/,
    );
  });
});
