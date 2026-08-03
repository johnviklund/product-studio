import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import {
  compileBrainstormMission,
  hashShapingInput,
  type BrainstormMissionPackage,
  type BrainstormResultSubmission,
} from "../../src/domain/shaping";
import type { ConnectedRunProcessIdentity } from "../../src/domain/connected-run";
import { InvalidWorkspaceError } from "../../src/domain/work-item";
import {
  ProductWorkspace,
  type ProductWorkspaceOptions,
  type ShapingRunCreateInput,
} from "../../src/workspace/product-workspace";

const createdRoots: string[] = [];
const workItemId = "wi_550e8400-e29b-41d4-a716-446655440000";
const firstRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
const secondRunId = "123e4567-e89b-42d3-a456-426614174000";
const thirdRunId = "550e8400-e29b-41d4-a716-446655440000";
const processIdentity: ConnectedRunProcessIdentity = {
  pid: 4321,
  process_group_id: 4321,
  started_at: "2026-08-01T10:00:02.000Z",
};

interface Fixture {
  root: string;
  mission: BrainstormMissionPackage;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-shaping-run-"));
  createdRoots.push(root);
  const founderDirectory = join(root, ".founder");
  const workItemDirectory = join(
    founderDirectory,
    "work-items",
    workItemId,
  );
  await mkdir(workItemDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: "Shaping Run Test",
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
  const goal = {
    schema_version: 2 as const,
    work_item_id: workItemId,
    title: "Connected Brainstorm",
    type: "Feature" as const,
    notes: "Publish one artifact-only result.",
  };
  await writeFile(join(workItemDirectory, "goal.yaml"), stringify(goal));
  await writeFile(
    join(workItemDirectory, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 2,
        work_item_id: workItemId,
        phase: "brainstorm",
        status: "active",
        updated_at: "2026-08-01T10:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );

  const shapingInput = {
    phase: "brainstorm" as const,
    title: goal.title,
    notes: goal.notes,
  };
  const identity = {
    phase: "brainstorm" as const,
    work_item_id: workItemId,
    input_sha256: hashShapingInput(shapingInput),
  };
  const workspace = new ProductWorkspace(root);
  const artifact = await workspace.writeShapingMissionPackage(
    identity,
    (paths) =>
      compileBrainstormMission({
        work_item_id: workItemId,
        shaping_input: shapingInput,
        paths,
      }),
  );
  return { root, mission: artifact.mission as BrainstormMissionPackage };
}

function shapingRunInput(
  mission: BrainstormMissionPackage,
  shapingRunId = firstRunId,
  requestedModel = "model-a",
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
            adapter_id: "local-acp-adapter",
            adapter_version: "1.0.0",
            profile_id: "artifact-only-shaping-v1",
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

function shapingRunDirectory(root: string, shapingRunId = firstRunId): string {
  return join(
    root,
    ".founder",
    "shaping-runs",
    workItemId,
    shapingRunId,
  );
}

function validResult(mission: BrainstormMissionPackage): string {
  const result: BrainstormResultSubmission = {
    result_schema_version: 1,
    brainstorm_mission_content_sha256: mission.content_sha256,
    identity: mission.identity,
    problem_statement: "The shaping run needs durable result publication.",
    approach: "Validate one ingress file and publish one atomic bundle.",
    non_goals: ["Do not mutate the accepted mission."],
    open_questions: ["Which founder decision follows this result?"],
  };
  return `${JSON.stringify(result, null, 2)}\n`;
}

async function writeIngress(
  root: string,
  ingressPath: string,
  source: string,
): Promise<void> {
  await writeFile(join(root, ...ingressPath.split("/")), source, "utf8");
}

async function createRun(
  fixture: Fixture,
  options: ProductWorkspaceOptions = {},
): Promise<{
  workspace: ProductWorkspace;
  created: Awaited<ReturnType<ProductWorkspace["createShapingRun"]>>;
}> {
  const workspace = new ProductWorkspace(fixture.root, options);
  const created = await workspace.createShapingRun(
    shapingRunInput(fixture.mission),
  );
  return { workspace, created };
}

class FailAfterBundleRenameWorkspace extends ProductWorkspace {
  private failAfterRename = true;

  protected override async afterShapingAppliedBundleRenamed(): Promise<void> {
    if (this.failAfterRename) {
      this.failAfterRename = false;
      throw new Error("injected failure after applied bundle rename");
    }
  }
}

class FailBeforeBundleRenameWorkspace extends ProductWorkspace {
  private failBeforeRename = true;

  protected override async afterShapingAppliedComponentWritten(
    component: "result" | "import" | "production" | "applied",
  ): Promise<void> {
    if (component === "applied" && this.failBeforeRename) {
      this.failBeforeRename = false;
      throw new Error("injected failure before applied bundle rename");
    }
  }
}

class AbortAfterAcpIngressStagedWorkspace extends ProductWorkspace {
  constructor(
    root: string,
    private readonly controller: AbortController,
  ) {
    super(root);
  }

  protected override async afterShapingAcpIngressStaged(): Promise<void> {
    this.controller.abort();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("shaping-run workspace storage", () => {
  it("persists separately, replays a matching launch, and rejects a conflicting active launch", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root);
    const [first, replay] = await Promise.all([
      workspace.createShapingRun(
        shapingRunInput(fixture.mission, firstRunId),
      ),
      workspace.createShapingRun(
        shapingRunInput(fixture.mission, secondRunId),
      ),
    ]);
    const winner = first.created ? first : replay;
    const duplicate = first.created ? replay : first;

    expect(winner.created).toBe(true);
    expect(duplicate).toEqual({
      record: winner.record,
      instruction: winner.instruction,
      created: false,
    });
    expect(
      (
        await readdir(
          shapingRunDirectory(
            fixture.root,
            winner.record.shaping_run_id,
          ),
        )
      ).sort(),
    ).toEqual([
      "events.ndjson",
      "ingress",
      "instruction.json",
      "process.json",
      "run.json",
    ]);
    expect(winner.record.write_policy.ingress_path).toBe(
      winner.instruction.ingress_path,
    );
    expect(winner.record.write_policy.instruction_sha256).toBe(
      winner.instruction.instruction_sha256,
    );
    expect(await workspace.listConnectedRuns(workItemId)).toEqual([]);
    expect(await workspace.listShapingRuns(workItemId)).toEqual([
      winner.record,
    ]);

    const event = await workspace.appendShapingRunEvent(
      workItemId,
      winner.record.shaping_run_id,
      { safe: "retained", token: "must-not-be-retained" },
    );
    expect(event).toMatchObject({ appended: true, event_count: 1 });
    const eventsSource = await readFile(
      join(
        shapingRunDirectory(fixture.root, winner.record.shaping_run_id),
        "events.ndjson",
      ),
      "utf8",
    );
    expect(eventsSource).toContain("retained");
    expect(eventsSource).not.toContain("must-not-be-retained");

    await expect(
      workspace.createShapingRun(
        shapingRunInput(fixture.mission, thirdRunId, "model-b"),
      ),
    ).rejects.toMatchObject({ kind: "lease_held", workItemId });
  });

  it("creates the instruction and ingress before start and supports cancellation", async () => {
    const fixture = await createFixture();
    const { workspace, created } = await createRun(fixture);
    await expect(
      readFile(
        join(shapingRunDirectory(fixture.root), "instruction.json"),
        "utf8",
      ),
    ).resolves.toContain(created.instruction.instruction_sha256);
    await expect(
      readdir(join(shapingRunDirectory(fixture.root), "ingress")),
    ).resolves.toEqual([]);

    const running = await workspace.startShapingRun(
      workItemId,
      firstRunId,
      processIdentity,
    );
    expect(running).toMatchObject({
      lifecycle: { status: "running" },
      process: processIdentity,
    });
    const cancelled = await workspace.completeShapingRun(
      workItemId,
      firstRunId,
      {
        outcome: "cancelled",
        partial: true,
        reason: "The founder cancelled this shaping run.",
      },
    );
    expect(cancelled.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "cancelled" },
    });
    await expect(
      workspace.createShapingRun(
        shapingRunInput(fixture.mission, secondRunId),
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it("owns bounded exact-path ACP ingress writes with immutable replay semantics", async () => {
    const fixture = await createFixture();
    const { workspace, created } = await createRun(fixture);
    await workspace.startShapingRun(workItemId, firstRunId, processIdentity);
    const ingressPath = join(
      fixture.root,
      ...created.instruction.ingress_path.split("/"),
    );
    const source = `${JSON.stringify(validResult(fixture.mission), null, 2)}\n`;

    await expect(
      workspace.writeShapingAcpTextFile(
        created.instruction,
        ingressPath,
        source,
      ),
    ).resolves.toEqual({ written: true });
    await expect(
      workspace.writeShapingAcpTextFile(
        created.instruction,
        ingressPath,
        source,
      ),
    ).resolves.toEqual({ written: false });
    await expect(
      workspace.writeShapingAcpTextFile(
        created.instruction,
        ingressPath,
        '{"different":true}\n',
      ),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
    await expect(
      workspace.writeShapingAcpTextFile(
        created.instruction,
        join(fixture.root, "sibling.json"),
        source,
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      workspace.writeShapingAcpTextFile(
        created.instruction,
        ingressPath,
        "",
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(
      workspace.writeShapingAcpTextFile(
        created.instruction,
        ingressPath,
        "x".repeat(created.instruction.max_result_bytes + 1),
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    await expect(readFile(ingressPath, "utf8")).resolves.toBe(source);
  });

  it("removes staged ACP ingress bytes when the write is aborted before publication", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const workspace = new AbortAfterAcpIngressStagedWorkspace(
      fixture.root,
      controller,
    );
    const created = await workspace.createShapingRun(
      shapingRunInput(fixture.mission),
    );
    await workspace.startShapingRun(workItemId, firstRunId, processIdentity);
    const ingressPath = join(
      fixture.root,
      ...created.instruction.ingress_path.split("/"),
    );
    await expect(
      workspace.writeShapingAcpTextFile(
        created.instruction,
        ingressPath,
        `${JSON.stringify(validResult(fixture.mission), null, 2)}\n`,
        controller.signal,
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
    expect(controller.signal.aborted).toBe(true);
    await expect(readdir(join(ingressPath, ".."))).resolves.toEqual([]);
  });

  it("publishes concurrent identical ACP ingress writes without exposing partial final bytes", async () => {
    const fixture = await createFixture();
    const { workspace, created } = await createRun(fixture);
    await workspace.startShapingRun(workItemId, firstRunId, processIdentity);
    const ingressPath = join(
      fixture.root,
      ...created.instruction.ingress_path.split("/"),
    );
    const source = `${JSON.stringify(validResult(fixture.mission), null, 2)}\n`;

    const outcomes = await Promise.all([
      workspace.writeShapingAcpTextFile(
        created.instruction,
        ingressPath,
        source,
      ),
      workspace.writeShapingAcpTextFile(
        created.instruction,
        ingressPath,
        source,
      ),
    ]);

    expect(outcomes).toEqual(
      expect.arrayContaining([{ written: true }, { written: false }]),
    );
    await expect(readFile(ingressPath, "utf8")).resolves.toBe(source);
    await expect(readdir(join(ingressPath, ".."))).resolves.toEqual([
      "result.json",
    ]);
  });

  it("rejects a symlink at the ACP ingress file", async () => {
    const fixture = await createFixture();
    const { workspace, created } = await createRun(fixture);
    await workspace.startShapingRun(workItemId, firstRunId, processIdentity);
    const ingressPath = join(
      fixture.root,
      ...created.instruction.ingress_path.split("/"),
    );
    const outsidePath = join(fixture.root, "outside-result.json");
    await writeFile(outsidePath, '{"outside":true}\n', "utf8");
    await symlink(outsidePath, ingressPath, "file");

    await expect(
      workspace.writeShapingAcpTextFile(
        created.instruction,
        ingressPath,
        '{"outside":true}\n',
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
  });

  it("fails closed on a tampered instruction and on a symlinked ingress directory", async () => {
    const tamperedFixture = await createFixture();
    const { workspace } = await createRun(tamperedFixture);
    const instructionPath = join(
      shapingRunDirectory(tamperedFixture.root),
      "instruction.json",
    );
    const instruction = JSON.parse(await readFile(instructionPath, "utf8"));
    await writeFile(
      instructionPath,
      `${JSON.stringify({
        ...instruction,
        mission_content_sha256: "f".repeat(64),
      })}\n`,
    );
    await expect(
      workspace.startShapingRun(workItemId, firstRunId, processIdentity),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);

    const linkedFixture = await createFixture();
    const linkedWorkspace = new ProductWorkspace(linkedFixture.root);
    await linkedWorkspace.createShapingRun(
      shapingRunInput(linkedFixture.mission),
    );
    const ingressDirectory = join(
      shapingRunDirectory(linkedFixture.root),
      "ingress",
    );
    const outsideDirectory = join(linkedFixture.root, "outside-ingress");
    await rm(ingressDirectory, { recursive: true });
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, ingressDirectory, "dir");
    await expect(
      linkedWorkspace.listShapingRuns(workItemId),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
  });

  it("publishes a completed ingress as the sole applied production and blocks another launch", async () => {
    const fixture = await createFixture();
    const { workspace, created } = await createRun(fixture);
    await workspace.startShapingRun(workItemId, firstRunId, processIdentity);
    const modelA = {
      assurance: "adapter_attested" as const,
      model_id: "model-a",
      deployment_id: "deployment-a",
      observed_event_sha256: "1".repeat(64),
    };
    const modelB = {
      assurance: "adapter_attested" as const,
      model_id: "model-b",
      deployment_id: "deployment-b",
      observed_event_sha256: "2".repeat(64),
    };
    await workspace.updateShapingRunEffectiveModel(
      workItemId,
      firstRunId,
      modelA,
    );
    await workspace.updateShapingRunEffectiveModel(
      workItemId,
      firstRunId,
      modelB,
    );
    await expect(
      workspace.updateShapingRunEffectiveModel(
        workItemId,
        firstRunId,
        modelB,
      ),
    ).resolves.toMatchObject({
      provenance: { effective_model: modelB },
    });
    await writeIngress(
      fixture.root,
      created.instruction.ingress_path,
      validResult(fixture.mission),
    );
    const completed = await workspace.completeShapingRun(
      workItemId,
      firstRunId,
      { outcome: "completed", partial: false, reason: null },
    );
    expect(completed.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "completed", partial: false, reason: null },
    });
    const production = JSON.parse(
      await readFile(
        join(
          fixture.root,
          ".founder",
          "shaping",
          workItemId,
          `brainstorm-${fixture.mission.identity.input_sha256}`,
          "applied",
          "production.json",
        ),
        "utf8",
      ),
    );
    expect(production).toMatchObject({
      origin: "connected_run",
      production_id: firstRunId,
      shaping_run_id: firstRunId,
      effective_model: modelB,
    });
    await expect(
      workspace.updateShapingRunEffectiveModel(workItemId, firstRunId, {
        ...modelB,
        model_id: "model-c",
      }),
    ).rejects.toMatchObject({ kind: "idempotency_conflict", workItemId });
    await expect(
      workspace.createShapingRun(
        shapingRunInput(fixture.mission, secondRunId),
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready", workItemId });
  });

  it("marks invalid output failed without a bundle and permits a retry", async () => {
    const fixture = await createFixture();
    const { workspace, created } = await createRun(fixture);
    await writeIngress(
      fixture.root,
      created.instruction.ingress_path,
      "{}\n",
    );
    await expect(
      workspace.completeShapingRun(workItemId, firstRunId, {
        outcome: "completed",
        partial: false,
        reason: null,
      }),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
    const failed = await workspace.readShapingRun(workItemId, firstRunId);
    expect(failed?.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "failed", partial: true },
    });
    await expect(
      workspace.readAppliedShapingResult(fixture.mission.identity),
    ).resolves.toBeNull();
    await expect(
      workspace.createShapingRun(
        shapingRunInput(fixture.mission, secondRunId),
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it("finishes a run after a crash between bundle rename and terminalization without republishing", async () => {
    const fixture = await createFixture();
    let probeCalls = 0;
    const workspace = new FailAfterBundleRenameWorkspace(fixture.root, {
      connectedProcessProbe: async () => {
        probeCalls += 1;
        return false;
      },
    });
    const created = await workspace.createShapingRun(
      shapingRunInput(fixture.mission),
    );
    await workspace.startShapingRun(workItemId, firstRunId, processIdentity);
    const observedModel = {
      assurance: "adapter_attested" as const,
      model_id: "model-b",
      deployment_id: "deployment-b",
      observed_event_sha256: "3".repeat(64),
    };
    await workspace.updateShapingRunEffectiveModel(
      workItemId,
      firstRunId,
      observedModel,
    );
    await writeIngress(
      fixture.root,
      created.instruction.ingress_path,
      validResult(fixture.mission),
    );
    await expect(
      workspace.completeShapingRun(workItemId, firstRunId, {
        outcome: "completed",
        partial: false,
        reason: null,
      }),
    ).rejects.toThrow("injected failure after applied bundle rename");
    expect(
      (await workspace.readShapingRun(workItemId, firstRunId))?.lifecycle
        .status,
    ).toBe("running");
    const appliedDirectory = join(
      fixture.root,
      ".founder",
      "shaping",
      workItemId,
      `brainstorm-${fixture.mission.identity.input_sha256}`,
      "applied",
    );
    const markerBefore = await readFile(
      join(appliedDirectory, "applied.json"),
      "utf8",
    );
    const [reconciled] = await workspace.reconcileShapingRuns();
    expect(reconciled.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "completed" },
    });
    expect(reconciled.provenance.effective_model).toEqual(observedModel);
    expect(
      JSON.parse(
        await readFile(join(appliedDirectory, "production.json"), "utf8"),
      ).effective_model,
    ).toEqual(observedModel);
    expect(probeCalls).toBe(0);
    expect(await readFile(join(appliedDirectory, "applied.json"), "utf8")).toBe(
      markerBefore,
    );
    expect(await readdir(appliedDirectory)).toHaveLength(4);
    expect(await workspace.listShapingRuns(workItemId)).toHaveLength(1);
    await expect(
      workspace.createShapingRun(
        shapingRunInput(fixture.mission, secondRunId),
      ),
    ).rejects.toMatchObject({ kind: "mission_not_ready" });
  });
  it("interrupts a crash before bundle rename and leaves the revision retryable", async () => {
    const fixture = await createFixture();
    const workspace = new FailBeforeBundleRenameWorkspace(fixture.root, {
      connectedProcessProbe: async () => false,
    });
    const created = await workspace.createShapingRun(
      shapingRunInput(fixture.mission),
    );
    await writeIngress(
      fixture.root,
      created.instruction.ingress_path,
      validResult(fixture.mission),
    );
    await expect(
      workspace.completeShapingRun(workItemId, firstRunId, {
        outcome: "completed",
        partial: false,
        reason: null,
      }),
    ).rejects.toThrow("injected failure before applied bundle rename");
    await expect(
      workspace.readAppliedShapingResult(fixture.mission.identity),
    ).resolves.toBeNull();
    const [interrupted] = await workspace.reconcileShapingRuns();
    expect(interrupted.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "interrupted" },
    });
    await expect(
      workspace.createShapingRun(
        shapingRunInput(fixture.mission, secondRunId),
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it("reconciles a dead process and a never-published run as interrupted", async () => {
    const deadFixture = await createFixture();
    const deadWorkspace = new ProductWorkspace(deadFixture.root, {
      connectedProcessProbe: async () => false,
    });
    await deadWorkspace.createShapingRun(shapingRunInput(deadFixture.mission));
    await deadWorkspace.startShapingRun(
      workItemId,
      firstRunId,
      processIdentity,
    );
    const [dead] = await deadWorkspace.reconcileShapingRuns();
    expect(dead.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "interrupted" },
    });

    const unpublishedFixture = await createFixture();
    const unpublishedWorkspace = new ProductWorkspace(
      unpublishedFixture.root,
      { connectedProcessProbe: async () => false },
    );
    await unpublishedWorkspace.createShapingRun(
      shapingRunInput(unpublishedFixture.mission),
    );
    await rm(shapingRunDirectory(unpublishedFixture.root), {
      recursive: true,
    });
    const [unpublished] = await unpublishedWorkspace.reconcileShapingRuns();
    expect(unpublished.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "interrupted" },
    });
    expect(
      (await readdir(shapingRunDirectory(unpublishedFixture.root))).sort(),
    ).toEqual([
      "events.ndjson",
      "ingress",
      "instruction.json",
      "process.json",
      "run.json",
    ]);
  });

  it("uses only a signal-0 probe and keeps responding or EPERM processes nonterminal", async () => {
    const liveFixture = await createFixture();
    const probeArguments: Array<[number, number]> = [];
    const liveWorkspace = new ProductWorkspace(liveFixture.root, {
      connectedProcessProbe: async (pid, signal) => {
        probeArguments.push([pid, signal]);
        return true;
      },
    });
    await liveWorkspace.createShapingRun(shapingRunInput(liveFixture.mission));
    await liveWorkspace.startShapingRun(
      workItemId,
      firstRunId,
      processIdentity,
    );
    const [live] = await liveWorkspace.reconcileShapingRuns();
    expect(live.lifecycle.status).toBe("running");
    expect(probeArguments).toEqual([[processIdentity.pid, 0]]);

    const epermFixture = await createFixture();
    const epermWorkspace = new ProductWorkspace(epermFixture.root);
    await epermWorkspace.createShapingRun(
      shapingRunInput(epermFixture.mission),
    );
    await epermWorkspace.startShapingRun(
      workItemId,
      firstRunId,
      processIdentity,
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), {
        code: "EPERM",
      });
    });
    const [eperm] = await epermWorkspace.reconcileShapingRuns();
    expect(eperm.lifecycle.status).toBe("running");
  });

  it("maps an ESRCH signal-0 probe to interrupted", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root);
    await workspace.createShapingRun(shapingRunInput(fixture.mission));
    await workspace.startShapingRun(
      workItemId,
      firstRunId,
      processIdentity,
    );
    const signals: Array<[number, NodeJS.Signals | number | undefined]> = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      signals.push([pid, signal]);
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const [interrupted] = await workspace.reconcileShapingRuns();
    expect(interrupted.lifecycle).toMatchObject({
      status: "terminal",
      terminal: { outcome: "interrupted" },
    });
    expect(signals).toEqual([[processIdentity.pid, 0]]);
  });
});
