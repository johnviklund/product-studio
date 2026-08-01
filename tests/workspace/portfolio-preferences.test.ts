import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidPortfolioPreferencesError,
  portfolioPreferencesV1Schema,
  recommendUnusedModel,
  shapingModelPickerOptions,
  summarizeWorkflowModelUse,
  type PortfolioPreferencesV1,
  type SetSeatModelPreferenceInput,
  type WorkflowModelUse,
  type WorkflowShapingProduction,
} from "../../src/domain/portfolio-preferences";
import type {
  ShapingProductionReceipt,
  ShapingRunRecordV1,
} from "../../src/domain/shaping-run";
import { PortfolioPreferencesStore } from "../../src/workspace/portfolio-preferences";

const createdRoots: string[] = [];
const adapterId = "copilot-acp";
const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const inputSha256 = "a".repeat(64);
const missionSha256 = "b".repeat(64);
const resultSha256 = "c".repeat(64);
const profileSha256 = "d".repeat(64);
const runIds = {
  brainstorm: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1",
  spec: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b2",
  plan: "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b3",
} as const;

async function createStore(): Promise<{
  root: string;
  store: PortfolioPreferencesStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-preferences-"));
  createdRoots.push(root);
  return { root, store: new PortfolioPreferencesStore(root) };
}

function runFor(
  seat: keyof typeof runIds,
  requestedModel: string,
): ShapingRunRecordV1 {
  const shapingRunId = runIds[seat];
  return {
    schema_version: 1,
    shaping_run_id: shapingRunId,
    mission: {
      phase: seat,
      work_item_id: workItemId,
      input_sha256: inputSha256,
      content_sha256: missionSha256,
    },
    provenance: {
      role: { value: "writer", assurance: "controller_observed" },
      seat: { value: seat, assurance: "controller_observed" },
      requested_model: {
        value: requestedModel,
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
        value: { id: "local-agent-cli", version: "1.0.0" },
        assurance: "adapter_attested",
      },
      adapter_profile: {
        value: {
          adapter_id: adapterId,
          adapter_version: "1.0.0",
          profile_id: "artifact-only-shaping-v1",
        },
        assurance: "adapter_attested",
      },
      resolved_profile_sha256: {
        value: profileSha256,
        assurance: "controller_observed",
      },
      resolved_skill_set_sha256: { value: null, assurance: "unknown" },
    },
    write_policy: {
      kind: "single_ingress_file",
      ingress_path: `.founder/shaping-runs/${workItemId}/${shapingRunId}/ingress/result.json`,
      instruction_sha256: "e".repeat(64),
      commands: "forbidden",
      urls: "forbidden",
      mcp: "forbidden",
      credentials: "forbidden",
      outside_workspace_writes: "forbidden",
      reads: "workspace_and_repository_unrestricted",
      execution_mode: "permission_mediated_local",
      result_assurance: "result_scope_validation",
      containment_assurance: "not_independently_enforced",
      machine_authority: "launching_user",
    },
    lifecycle: {
      status: "terminal",
      started_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T10:05:00.000Z",
      completed_at: "2026-08-01T10:05:01.000Z",
      terminal: { outcome: "completed", partial: false, reason: null },
    },
    limits: {
      wall_clock_timeout_ms: 900_000,
      max_event_count: 10_000,
      max_event_bytes: 4_000_000,
      max_output_bytes: 1_000_000,
      termination_grace_ms: 5_000,
      drain_grace_ms: 1_000,
    },
    process: {
      pid: 1234,
      process_group_id: 1234,
      started_at: "2026-08-01T10:00:00.100Z",
    },
    diagnostics: { entries: [], truncated: false },
  };
}

function productionFor(
  run: ShapingRunRecordV1,
  effectiveModel: string | null,
): WorkflowShapingProduction {
  const effectiveIdentity =
    effectiveModel === null
      ? {
          assurance: "unknown" as const,
          model_id: null,
          deployment_id: null,
          observed_event_sha256: null,
        }
      : {
          assurance: "adapter_attested" as const,
          model_id: effectiveModel,
          deployment_id: null,
          observed_event_sha256: "f".repeat(64),
        };
  const receipt: ShapingProductionReceipt = {
    schema_version: 1,
    production_id: run.shaping_run_id,
    origin: "connected_run",
    shaping_run_id: run.shaping_run_id,
    produced_at: "2026-08-01T10:05:00.000Z",
    requested_model: run.provenance.requested_model,
    effective_model: effectiveIdentity,
    ingress_path: run.write_policy.ingress_path,
    result_content_sha256: resultSha256,
  };
  return { seat: run.mission.phase, receipt };
}

interface PreferenceStoreLike {
  read(): Promise<PortfolioPreferencesV1>;
  setPreference(
    input: SetSeatModelPreferenceInput,
  ): Promise<PortfolioPreferencesV1>;
}

async function runDifferentSeatRace(
  store: PreferenceStoreLike,
): Promise<PortfolioPreferencesV1> {
  await Promise.all([
    store.setPreference({
      adapter_id: adapterId,
      seat: "brainstorm",
      requested_model: "model-brainstorm",
    }),
    store.setPreference({
      adapter_id: adapterId,
      seat: "spec",
      requested_model: "model-spec",
    }),
  ]);
  return store.read();
}

class DeliberatelyUnserializedStore implements PreferenceStoreLike {
  private document: PortfolioPreferencesV1 = {
    schema_version: 1,
    preferences: {},
  };
  private readers = 0;
  private releaseReaders: (() => void) | undefined;
  private readonly bothRead = new Promise<void>((resolve) => {
    this.releaseReaders = resolve;
  });

  async read(): Promise<PortfolioPreferencesV1> {
    return structuredClone(this.document);
  }

  async setPreference(
    input: SetSeatModelPreferenceInput,
  ): Promise<PortfolioPreferencesV1> {
    const snapshot = await this.read();
    this.readers += 1;
    if (this.readers === 2) {
      this.releaseReaders?.();
    }
    await this.bothRead;
    this.document = portfolioPreferencesV1Schema.parse({
      schema_version: 1,
      preferences: {
        ...snapshot.preferences,
        [input.adapter_id]: {
          ...snapshot.preferences[input.adapter_id],
          [input.seat]: input.requested_model,
        },
      },
    });
    return this.read();
  }
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("PortfolioPreferencesStore", () => {
  it("round-trips strict seat preferences and treats a missing file as empty", async () => {
    const { store } = await createStore();

    await expect(store.read()).resolves.toEqual({
      schema_version: 1,
      preferences: {},
    });
    await store.setPreference({
      adapter_id: adapterId,
      seat: "brainstorm",
      requested_model: "model-brainstorm",
    });

    await expect(store.read()).resolves.toEqual({
      schema_version: 1,
      preferences: {
        [adapterId]: { brainstorm: "model-brainstorm" },
      },
    });
    await expect(
      store.getPreference(adapterId, "brainstorm"),
    ).resolves.toBe("model-brainstorm");
    await expect(store.getPreference(adapterId, "plan")).resolves.toBeNull();
  });

  it("rejects unknown document keys and unknown seats without overwriting them", async () => {
    const { store } = await createStore();
    await mkdir(dirname(store.preferencesPath), { recursive: true });

    const unknownKeyDocument = `${JSON.stringify({
      schema_version: 1,
      preferences: {},
      effective_model: "must-not-be-stored",
    })}\n`;
    await writeFile(store.preferencesPath, unknownKeyDocument, "utf8");
    await expect(store.read()).rejects.toBeInstanceOf(
      InvalidPortfolioPreferencesError,
    );
    await expect(
      store.setPreference({
        adapter_id: adapterId,
        seat: "brainstorm",
        requested_model: "model-brainstorm",
      }),
    ).rejects.toBeInstanceOf(InvalidPortfolioPreferencesError);
    await expect(readFile(store.preferencesPath, "utf8")).resolves.toBe(
      unknownKeyDocument,
    );

    await writeFile(
      store.preferencesPath,
      `${JSON.stringify({
        schema_version: 1,
        preferences: { [adapterId]: { review: "model-review" } },
      })}\n`,
      "utf8",
    );
    await expect(store.read()).rejects.toBeInstanceOf(
      InvalidPortfolioPreferencesError,
    );
  });

  it("rejects a symlinked preference document", async () => {
    const { root, store } = await createStore();
    const targetPath = join(root, "target.json");
    await mkdir(dirname(store.preferencesPath), { recursive: true });
    await writeFile(
      targetPath,
      '{"schema_version":1,"preferences":{}}\n',
      "utf8",
    );
    await symlink(targetPath, store.preferencesPath);

    await expect(store.read()).rejects.toMatchObject({
      kind: "invalid_portfolio_preferences",
      artifactPath: store.preferencesPath,
    });
  });

  it("publishes either the old or new complete document and leaves no temp file", async () => {
    const { store } = await createStore();
    await store.setPreference({
      adapter_id: adapterId,
      seat: "brainstorm",
      requested_model: "model-old",
    });

    const update = store.setPreference({
      adapter_id: adapterId,
      seat: "brainstorm",
      requested_model: "model-new",
    });
    const whileUpdating = await readFile(store.preferencesPath, "utf8");
    await update;
    const afterUpdating = await readFile(store.preferencesPath, "utf8");

    for (const source of [whileUpdating, afterUpdating]) {
      const document = portfolioPreferencesV1Schema.parse(JSON.parse(source));
      expect(["model-old", "model-new"]).toContain(
        document.preferences[adapterId]?.brainstorm,
      );
    }
    expect(await readdir(dirname(store.preferencesPath))).toEqual([
      "model-preferences.json",
    ]);
  });

  it("serializes read-merge-write so simultaneous different-seat updates both survive", async () => {
    const { store } = await createStore();
    const serialized = await runDifferentSeatRace(store);
    expect(serialized.preferences[adapterId]).toEqual({
      brainstorm: "model-brainstorm",
      spec: "model-spec",
    });

    const unserialized = await runDifferentSeatRace(
      new DeliberatelyUnserializedStore(),
    );
    expect(unserialized.preferences[adapterId]).not.toEqual({
      brainstorm: "model-brainstorm",
      spec: "model-spec",
    });
  });
});

describe("cross-seat model logic", () => {
  it("recommends the first unused configured model and none when all are used", () => {
    expect(
      recommendUnusedModel(
        ["model-one", "model-two", "model-three"],
        ["model-one"],
      ),
    ).toBe("model-two");
    expect(
      recommendUnusedModel(
        ["model-one", "model-two"],
        ["model-two", "model-one"],
      ),
    ).toBeNull();
  });

  it("summarizes requested and observed models without backfilling unknown effective identity", () => {
    const brainstormRun = runFor("brainstorm", "requested-brainstorm");
    const specRun = runFor("spec", "requested-spec");
    const uses = summarizeWorkflowModelUse(
      [specRun, brainstormRun],
      [
        productionFor(specRun, null),
        productionFor(brainstormRun, "effective-brainstorm"),
      ],
    );

    expect(uses).toEqual([
      {
        seat: "brainstorm",
        production_id: brainstormRun.shaping_run_id,
        shaping_run_id: brainstormRun.shaping_run_id,
        requested_model: "requested-brainstorm",
        effective_model: "effective-brainstorm",
      },
      {
        seat: "spec",
        production_id: specRun.shaping_run_id,
        shaping_run_id: specRun.shaping_run_id,
        requested_model: "requested-spec",
        effective_model: null,
      },
    ]);
  });

  it("uses effective identity first, marks used seats, and sorts unused models first", () => {
    const modelUses: WorkflowModelUse[] = [
      {
        seat: "brainstorm",
        production_id: runIds.brainstorm,
        shaping_run_id: runIds.brainstorm,
        requested_model: "requested-brainstorm",
        effective_model: "effective-brainstorm",
      },
      {
        seat: "spec",
        production_id: runIds.spec,
        shaping_run_id: runIds.spec,
        requested_model: "requested-spec",
        effective_model: null,
      },
    ];
    const options = shapingModelPickerOptions(
      [
        "requested-brainstorm",
        "effective-brainstorm",
        "requested-spec",
        "unused-model",
      ],
      modelUses,
      null,
    );

    expect(options.map((option) => option.model_id)).toEqual([
      "requested-brainstorm",
      "unused-model",
      "effective-brainstorm",
      "requested-spec",
    ]);
    expect(
      options.find((option) => option.model_id === "requested-brainstorm"),
    ).toMatchObject({ used_by_seats: [] });
    expect(
      options.find((option) => option.model_id === "effective-brainstorm"),
    ).toMatchObject({ used_by_seats: ["brainstorm"] });
    expect(
      options.find((option) => option.model_id === "requested-spec"),
    ).toMatchObject({ used_by_seats: ["spec"] });
  });

  it("preselects a recommendation ahead of a saved preference already used", () => {
    const uses: WorkflowModelUse[] = [
      {
        seat: "brainstorm",
        production_id: runIds.brainstorm,
        shaping_run_id: runIds.brainstorm,
        requested_model: "model-used",
        effective_model: null,
      },
    ];
    const options = shapingModelPickerOptions(
      ["model-used", "model-unused"],
      uses,
      "model-used",
    );

    expect(options.find((option) => option.preselected)?.model_id).toBe(
      "model-unused",
    );
    expect(options.find((option) => option.saved_preference)?.model_id).toBe(
      "model-used",
    );
  });

  it("preselects an unused saved preference", () => {
    const options = shapingModelPickerOptions(
      ["first-unused", "saved-unused"],
      [],
      "saved-unused",
    );

    expect(options.find((option) => option.preselected)?.model_id).toBe(
      "saved-unused",
    );
    expect(options.find((option) => option.recommended)?.model_id).toBe(
      "first-unused",
    );
  });

  it("preselects the saved used model with a warning when no recommendation remains", () => {
    const uses: WorkflowModelUse[] = [
      {
        seat: "brainstorm",
        production_id: runIds.brainstorm,
        shaping_run_id: runIds.brainstorm,
        requested_model: "model-one",
        effective_model: null,
      },
      {
        seat: "spec",
        production_id: runIds.spec,
        shaping_run_id: runIds.spec,
        requested_model: "model-two",
        effective_model: null,
      },
    ];
    const options = shapingModelPickerOptions(
      ["model-one", "model-two"],
      uses,
      "model-two",
    );
    const selected = options.find((option) => option.preselected);

    expect(selected).toMatchObject({
      model_id: "model-two",
      used_by_seats: ["spec"],
      saved_preference: true,
    });
    expect(selected?.reuse_warning).toContain("spec");
    expect(options.some((option) => option.recommended)).toBe(false);
  });
});
