import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify } from "yaml";

import {
  resolveCapabilityEnvelope,
  type ExecutionDefaultsV1,
} from "../../src/domain/capability-envelope";
import {
  hashResolvedCapabilityEnvelope,
  type ConnectedRunRecordV2,
} from "../../src/domain/connected-run";
import {
  compileBrainstormMission,
  hashShapingInput,
  type BrainstormMissionPackage,
} from "../../src/domain/shaping";
import {
  ProductWorkspace,
  type ShapingRunCreateInput,
} from "../../src/workspace/product-workspace";

export const LEGACY_CONNECTED_WORK_ITEM_ID =
  "wi_10000000-0000-4000-8000-000000000001";
export const LEGACY_SHAPING_WORK_ITEM_ID =
  "wi_10000000-0000-4000-8000-000000000002";
export const LEGACY_CONNECTED_RUN_ID =
  "10000000-0000-4000-8000-000000000011";
export const LEGACY_SHAPING_RUN_ID =
  "10000000-0000-4000-8000-000000000012";
export const NEW_CONNECTED_RUN_ID =
  "10000000-0000-4000-8000-000000000021";
export const NEW_SHAPING_RUN_ID =
  "10000000-0000-4000-8000-000000000022";

const connectedMissionSource = `${JSON.stringify(
  { phase: "execute", fixture: "legacy-semantic-workspace" },
  null,
  2,
)}\n`;
const executionDefaults: ExecutionDefaultsV1 = {
  schema_version: 1,
  approved_command_forms: [
    { executable: "npm", args: ["run", "test"] },
  ],
  approved_url_operations: [],
  mcp: "forbidden",
  credentials: "forbidden",
};

export interface LegacySemanticWorkspaceFixture {
  root: string;
  shapingMission: BrainstormMissionPackage;
}

export async function readLegacyFixtureSemanticEvents(
  root: string,
  workItemId: string,
): Promise<unknown[]> {
  const directory = join(
    root,
    ".founder",
    "semantic-events",
    workItemId,
    "events",
  );
  return Promise.all(
    (await readdir(directory)).sort().map(async (entry) =>
      JSON.parse(await readFile(join(directory, entry), "utf8")),
    ),
  );
}

export function legacyConnectedRun(
  connectedRunId: string,
): ConnectedRunRecordV2 {
  const envelope = resolveCapabilityEnvelope(
    ["src", "tests"],
    executionDefaults,
  );
  return {
    schema_version: 2,
    connected_run_id: connectedRunId,
    mission: {
      identity: {
        phase: "execute",
        work_item_id: LEGACY_CONNECTED_WORK_ITEM_ID,
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
      },
      path: `.founder/missions/${LEGACY_CONNECTED_WORK_ITEM_ID}/execute-1-1-0/mission.json`,
      content_sha256: createHash("sha256")
        .update(connectedMissionSource)
        .digest("hex"),
      source_commit: "b".repeat(40),
    },
    governed_tuple: {
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 0,
    },
    provenance: {
      role: { value: "writer", assurance: "controller_observed" },
      seat: { value: "executor", assurance: "controller_observed" },
      requested_model: {
        value: "legacy-fixture-model",
        assurance: "user_declared",
      },
      effective_model: {
        assurance: "unknown",
        model_id: null,
        deployment_id: null,
        observed_event_sha256: null,
      },
      effort: { value: "high", assurance: "user_declared" },
      harness: {
        value: { id: "fixture-cli", version: "1.0.0" },
        assurance: "controller_observed",
      },
      adapter_profile: {
        value: {
          adapter_id: "fixture-acp",
          adapter_version: "1.0.0",
          profile_id: "execute-v1",
        },
        assurance: "controller_observed",
      },
      resolved_profile_sha256: {
        value: "c".repeat(64),
        assurance: "controller_observed",
      },
      resolved_skill_set_sha256: {
        value: "d".repeat(64),
        assurance: "controller_observed",
      },
      authorization_sha256: {
        value: "e".repeat(64),
        assurance: "controller_observed",
      },
    },
    authorization: {
      kind: "capability_envelope",
      envelope,
      envelope_sha256: hashResolvedCapabilityEnvelope(envelope),
    },
    acp: {
      protocol_version: { value: null, assurance: "unknown" },
      session_id: { value: null, assurance: "unknown" },
    },
    lifecycle: {
      status: "starting",
      started_at: "2026-08-01T10:00:01.000Z",
      updated_at: "2026-08-01T10:00:01.000Z",
      completed_at: null,
      terminal: null,
    },
    limits: {
      wall_clock_timeout_ms: 900_000,
      max_event_count: 100,
      max_event_bytes: 100_000,
      max_output_bytes: 10_000,
      termination_grace_ms: 5_000,
      drain_grace_ms: 1_000,
    },
    process: null,
    diagnostics: { entries: [], truncated: false },
  };
}

export function legacyShapingRun(
  mission: BrainstormMissionPackage,
  shapingRunId: string,
): ShapingRunCreateInput {
  return {
    mission,
    record: {
      schema_version: 1,
      shaping_run_id: shapingRunId,
      mission: {
        phase: mission.identity.phase,
        work_item_id: mission.identity.work_item_id,
        input_sha256: mission.identity.input_sha256,
        content_sha256: mission.content_sha256,
      },
      provenance: {
        role: { value: "writer", assurance: "controller_observed" },
        seat: { value: "brainstorm", assurance: "controller_observed" },
        requested_model: {
          value: "legacy-fixture-model",
          assurance: "user_declared",
        },
        effective_model: {
          assurance: "unknown",
          model_id: null,
          deployment_id: null,
          observed_event_sha256: null,
        },
        effort: { value: "high", assurance: "user_declared" },
        harness: {
          value: { id: "fixture-cli", version: "1.0.0" },
          assurance: "adapter_attested",
        },
        adapter_profile: {
          value: {
            adapter_id: "fixture-acp",
            adapter_version: "1.0.0",
            profile_id: "shaping-v1",
          },
          assurance: "adapter_attested",
        },
        resolved_profile_sha256: {
          value: "a".repeat(64),
          assurance: "controller_observed",
        },
        resolved_skill_set_sha256: {
          value: "b".repeat(64),
          assurance: "controller_observed",
        },
      },
      lifecycle: {
        status: "starting",
        started_at: "2026-08-01T10:00:01.000Z",
        updated_at: "2026-08-01T10:00:01.000Z",
        completed_at: null,
        terminal: null,
      },
      limits: {
        wall_clock_timeout_ms: 900_000,
        max_event_count: 100,
        max_event_bytes: 100_000,
        max_output_bytes: 10_000,
        termination_grace_ms: 5_000,
        drain_grace_ms: 1_000,
      },
      process: null,
      diagnostics: { entries: [], truncated: false },
    },
  };
}

export async function createLegacySemanticWorkspace(
  root: string,
): Promise<LegacySemanticWorkspaceFixture> {
  const founderDirectory = join(root, ".founder");
  const connectedWorkItemDirectory = join(
    founderDirectory,
    "work-items",
    LEGACY_CONNECTED_WORK_ITEM_ID,
  );
  const shapingWorkItemDirectory = join(
    founderDirectory,
    "work-items",
    LEGACY_SHAPING_WORK_ITEM_ID,
  );
  await mkdir(connectedWorkItemDirectory, { recursive: true });
  await mkdir(shapingWorkItemDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: "Legacy Semantic Workspace",
      verification: {
        required_commands: [
          {
            name: "Tests",
            argv: ["npm", "test"],
            timeout_seconds: 120,
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(connectedWorkItemDirectory, "goal.yaml"),
    stringify({
      schema_version: 2,
      work_item_id: LEGACY_CONNECTED_WORK_ITEM_ID,
      title: "Legacy connected run",
      type: "Feature",
      goal_contract: {
        schema_version: 1,
        goal_version: 1,
        purpose: "Prove historical connected runs stay silent.",
        acceptance_criteria: ["Reconciliation does not create history."],
        non_goals: ["Do not backfill semantic events."],
        allowed_scope: ["src", "tests"],
        review_ready: ["Focused regression tests pass."],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(connectedWorkItemDirectory, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 2,
        work_item_id: LEGACY_CONNECTED_WORK_ITEM_ID,
        phase: "execute",
        status: "active",
        updated_at: "2026-08-01T10:00:00.000Z",
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        patch_cycle: 0,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(shapingWorkItemDirectory, "goal.yaml"),
    stringify({
      schema_version: 2,
      work_item_id: LEGACY_SHAPING_WORK_ITEM_ID,
      title: "Legacy shaping run",
      type: "Feature",
      notes: "Prove historical shaping runs stay silent.",
    }),
    "utf8",
  );
  await writeFile(
    join(shapingWorkItemDirectory, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 2,
        work_item_id: LEGACY_SHAPING_WORK_ITEM_ID,
        phase: "brainstorm",
        status: "active",
        updated_at: "2026-08-01T10:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const connectedMissionDirectory = join(
    founderDirectory,
    "missions",
    LEGACY_CONNECTED_WORK_ITEM_ID,
    "execute-1-1-0",
  );
  await mkdir(connectedMissionDirectory, { recursive: true });
  await writeFile(
    join(connectedMissionDirectory, "mission.json"),
    connectedMissionSource,
    "utf8",
  );

  const workspace = new ProductWorkspace(root);
  const shapingInput = {
    phase: "brainstorm" as const,
    title: "Legacy shaping run",
    notes: "Prove historical shaping runs stay silent.",
  };
  const shapingArtifact = await workspace.writeShapingMissionPackage(
    {
      phase: "brainstorm",
      work_item_id: LEGACY_SHAPING_WORK_ITEM_ID,
      input_sha256: hashShapingInput(shapingInput),
    },
    (paths) =>
      compileBrainstormMission({
        work_item_id: LEGACY_SHAPING_WORK_ITEM_ID,
        shaping_input: shapingInput,
        paths,
      }),
  );
  const shapingMission = shapingArtifact.mission as BrainstormMissionPackage;

  await workspace.createConnectedRun(
    legacyConnectedRun(LEGACY_CONNECTED_RUN_ID),
  );
  await workspace.completeConnectedRun(
    LEGACY_CONNECTED_WORK_ITEM_ID,
    LEGACY_CONNECTED_RUN_ID,
    {
      outcome: "cancelled",
      partial: true,
      reason: "Legacy connected run fixture.",
    },
  );
  await workspace.createShapingRun(
    legacyShapingRun(shapingMission, LEGACY_SHAPING_RUN_ID),
  );
  await workspace.completeShapingRun(
    LEGACY_SHAPING_WORK_ITEM_ID,
    LEGACY_SHAPING_RUN_ID,
    {
      outcome: "cancelled",
      partial: true,
      reason: "Legacy shaping run fixture.",
    },
  );
  await rm(join(founderDirectory, "semantic-events"), {
    recursive: true,
    force: true,
  });

  return { root, shapingMission };
}
