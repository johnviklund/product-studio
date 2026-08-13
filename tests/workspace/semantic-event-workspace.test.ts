import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import {
  canonicalSerializeSemanticEvent,
  deriveSemanticEventId,
  deriveSemanticIntentId,
  semanticEventSchema,
  type SemanticEventIntentV1,
  type SemanticEventV1,
} from "../../src/domain/semantic-event";
import {
  ControllerConflictError,
  InvalidWorkspaceError,
} from "../../src/domain/work-item";
import { ProductWorkspace } from "../../src/workspace/product-workspace";

const createdRoots: string[] = [];

interface SemanticFixture {
  root: string;
  workItemId: string;
  controllerRunId: string;
  sourcePath: string;
  sourceSha256: string;
}

function hash(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

function semanticDirectory(root: string, workItemId: string): string {
  return join(root, ".founder", "semantic-events", workItemId);
}

function eventPath(
  root: string,
  workItemId: string,
  sequence: number,
): string {
  return join(
    semanticDirectory(root, workItemId),
    "events",
    `${String(sequence).padStart(16, "0")}.json`,
  );
}

async function addWorkItem(root: string, workItemId: string): Promise<void> {
  const workItemDirectory = join(
    root,
    ".founder",
    "work-items",
    workItemId,
  );
  await mkdir(join(workItemDirectory, "runs"), { recursive: true });
  await writeFile(
    join(workItemDirectory, "goal.yaml"),
    stringify({
      schema_version: 2,
      work_item_id: workItemId,
      title: "Semantic history",
      type: "Feature",
      goal_contract: {
        schema_version: 1,
        goal_version: 1,
        purpose: "Publish a truthful semantic history.",
        acceptance_criteria: ["Events bind durable evidence."],
        non_goals: ["Do not make the log authoritative."],
        allowed_scope: ["src", "tests"],
        review_ready: ["Required checks pass."],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(workItemDirectory, "state.json"),
    `${JSON.stringify(
      {
        schema_version: 2,
        work_item_id: workItemId,
        phase: "execute",
        status: "active",
        updated_at: "2026-08-12T07:00:00.000Z",
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
}

async function writeAppliedControllerSource(
  root: string,
  workItemId: string,
): Promise<Omit<SemanticFixture, "root" | "workItemId">> {
  const controllerRunId = randomUUID();
  const sourcePath = `.founder/work-items/${workItemId}/runs/${controllerRunId}.json`;
  const source = `${JSON.stringify(
    {
      schema_version: 1,
      run_id: controllerRunId,
      work_item_id: workItemId,
      idempotency_key: `semantic-${controllerRunId}`,
      phase: "execute",
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      started_at: "2026-08-12T07:00:00.000Z",
      completed_at: "2026-08-12T07:00:01.000Z",
      outcome: "applied",
    },
    null,
    2,
  )}\n`;
  await writeFile(join(root, ...sourcePath.split("/")), source, "utf8");
  return {
    controllerRunId,
    sourcePath,
    sourceSha256: hash(source),
  };
}

async function createFixture(): Promise<SemanticFixture> {
  const root = await mkdtemp(join(tmpdir(), "product-studio-semantic-"));
  createdRoots.push(root);
  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: "Semantic Event Test",
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
  const workItemId = `wi_${randomUUID()}`;
  await addWorkItem(root, workItemId);
  return {
    root,
    workItemId,
    ...(await writeAppliedControllerSource(root, workItemId)),
  };
}

function workflowIntent(
  fixture: SemanticFixture,
  slot: string,
  options: {
    outcome?: string;
    evidencePath?: string;
    evidenceSha256?: string;
  } = {},
): SemanticEventIntentV1 {
  const source = {
    kind: "controller_run" as const,
    controller_run_id: fixture.controllerRunId,
    expected_outcome: "applied" as const,
  };
  const kind = "workflow_transitioned" as const;
  const binding = {
    kind: "governed" as const,
    governed_tuple: {
      goal_version: 1,
      input_revision: 1,
      attempt: 0,
      patch_cycle: 0,
    },
    phase: "execute" as const,
    status: "active" as const,
  };
  return {
    schema_version: 1,
    intent_id: deriveSemanticIntentId({ source, kind, slot }),
    source,
    slot,
    kind,
    work_item_id: fixture.workItemId,
    binding,
    run: null,
    actor: { kind: "controller" },
    outcome: options.outcome ?? `Applied semantic occurrence ${slot}.`,
    occurred_at: "2026-08-12T07:00:01.000Z",
    evidence: [
      {
        kind: "controller_run",
        path: options.evidencePath ?? fixture.sourcePath,
        expected_content_sha256:
          options.evidenceSha256 ?? fixture.sourceSha256,
      },
    ],
    action: null,
    details: {
      kind,
      before: {
        ...binding,
        phase: "plan",
      },
      after: binding,
    },
  };
}

async function readEvent(
  fixture: SemanticFixture,
  sequence: number,
): Promise<SemanticEventV1> {
  return semanticEventSchema.parse(
    JSON.parse(
      await readFile(
        eventPath(fixture.root, fixture.workItemId, sequence),
        "utf8",
      ),
    ),
  );
}

function appendLockOwnerSource(ownerHostname: string): string {
  return `${JSON.stringify({
    token: randomUUID(),
    pid: process.pid,
    hostname: ownerHostname,
    acquired_at: new Date().toISOString(),
  })}\n`;
}

async function expectRepairRequired(
  publication: Promise<unknown>,
): Promise<ControllerConflictError> {
  try {
    await publication;
  } catch (error) {
    expect(error).toBeInstanceOf(ControllerConflictError);
    expect(error).toMatchObject({ kind: "repair_required" });
    return error as ControllerConflictError;
  }
  throw new Error("Expected semantic event publication to require repair.");
}

class SuccessorAppendLockWorkspace extends ProductWorkspace {
  private replaced = false;

  constructor(
    root: string,
    private readonly lockPath: string,
    private readonly successorSource: string,
  ) {
    super(root, {
      connectedProcessProbe: async () => true,
      exclusiveWaitMs: 500,
      exclusivePollMs: 25,
    });
  }

  protected override async beforeSemanticAppendLockReclaimed(): Promise<void> {
    if (this.replaced) {
      return;
    }
    this.replaced = true;
    const successorPath = `${this.lockPath}.${randomUUID()}`;
    await writeFile(successorPath, this.successorSource, "utf8");
    await rename(successorPath, this.lockPath);
  }
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("semantic event workspace", () => {
  it("creates the exact stream lazily and replays immutable records", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root);
    const intent = workflowIntent(fixture, "transition-1");
    const itemDirectory = semanticDirectory(
      fixture.root,
      fixture.workItemId,
    );

    await expect(
      readdir(join(fixture.root, ".founder", "semantic-events")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(await workspace.writeSemanticEventIntents(fixture.workItemId, [intent]))
      .toEqual([intent]);
    expect(await readdir(itemDirectory)).toEqual([
      "events",
      "intents",
      "stream.json",
    ]);
    expect(await readdir(join(itemDirectory, "events"))).toEqual([]);
    expect(await readdir(join(itemDirectory, "intents"))).toEqual([
      `${intent.intent_id}.json`,
    ]);
    expect(await readFile(join(itemDirectory, "stream.json"), "utf8")).toBe(
      `${JSON.stringify(
        { schema_version: 1, work_item_id: fixture.workItemId },
        null,
        2,
      )}\n`,
    );

    expect(await workspace.writeSemanticEventIntents(fixture.workItemId, [intent]))
      .toEqual([intent]);
    const first = await workspace.publishSemanticEventIntent(
      fixture.workItemId,
      intent.intent_id,
    );
    const replay = await workspace.publishSemanticEventIntent(
      fixture.workItemId,
      intent.intent_id,
    );
    expect(replay).toEqual(first);
    expect(await readdir(join(itemDirectory, "events"))).toEqual([
      "0000000000000001.json",
    ]);
    expect(await readdir(itemDirectory)).toEqual([
      "events",
      "intents",
      "stream.json",
    ]);
  });

  it("rejects a different rewrite of an immutable intent", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root);
    const intent = workflowIntent(fixture, "immutable-intent");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [intent]);

    await expect(
      workspace.writeSemanticEventIntents(fixture.workItemId, [
        { ...intent, outcome: "A different semantic claim." },
      ]),
    ).rejects.toMatchObject({ kind: "idempotency_conflict" });
  });

  it("rejects changed immutable stream and event content", async () => {
    const headerFixture = await createFixture();
    const headerWorkspace = new ProductWorkspace(headerFixture.root);
    const first = workflowIntent(headerFixture, "header-first");
    await headerWorkspace.writeSemanticEventIntents(headerFixture.workItemId, [
      first,
    ]);
    await writeFile(
      join(
        semanticDirectory(headerFixture.root, headerFixture.workItemId),
        "stream.json",
      ),
      `${JSON.stringify(
        { schema_version: 1, work_item_id: `wi_${randomUUID()}` },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      headerWorkspace.writeSemanticEventIntents(headerFixture.workItemId, [
        workflowIntent(headerFixture, "header-second"),
      ]),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);

    const eventFixture = await createFixture();
    const eventWorkspace = new ProductWorkspace(eventFixture.root);
    const intent = workflowIntent(eventFixture, "event-first");
    await eventWorkspace.writeSemanticEventIntents(eventFixture.workItemId, [
      intent,
    ]);
    const event = await eventWorkspace.publishSemanticEventIntent(
      eventFixture.workItemId,
      intent.intent_id,
    );
    await writeFile(
      eventPath(eventFixture.root, eventFixture.workItemId, 1),
      canonicalSerializeSemanticEvent({
        ...event,
        outcome: "A substituted semantic claim.",
      }),
      "utf8",
    );
    await expect(
      eventWorkspace.publishSemanticEventIntent(
        eventFixture.workItemId,
        intent.intent_id,
      ),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
  });

  it("allocates monotonic unique sequences under concurrent append", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root);
    const intents = Array.from({ length: 12 }, (_, index) =>
      workflowIntent(fixture, `concurrent-${index + 1}`),
    );
    await workspace.writeSemanticEventIntents(fixture.workItemId, intents);

    const published = await Promise.all(
      intents.map((intent) =>
        workspace.publishSemanticEventIntent(
          fixture.workItemId,
          intent.intent_id,
        ),
      ),
    );
    expect(
      published
        .map((event) => event.stream_sequence)
        .sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(new Set(published.map((event) => event.event_id))).toHaveLength(12);
    expect(await readdir(join(
      semanticDirectory(fixture.root, fixture.workItemId),
      "events",
    ))).toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `${String(index + 1).padStart(16, "0")}.json`,
      ),
    );
  });

  it("takes over an abandoned append lock within the shared wait budget", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root);
    const intent = workflowIntent(fixture, "stale-append-lock");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [intent]);
    const lockPath = join(
      semanticDirectory(fixture.root, fixture.workItemId),
      ".append.lock",
    );
    await writeFile(lockPath, "abandoned-owner\n", "utf8");
    const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    await utimes(lockPath, staleTime, staleTime);
    const startedAt = Date.now();

    const published = await workspace.publishSemanticEventIntent(
      fixture.workItemId,
      intent.intent_id,
    );

    expect(published.stream_sequence).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("takes over an ownerless zero-byte append lock", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root);
    const intent = workflowIntent(fixture, "ownerless-append-lock");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [intent]);
    const lockPath = join(
      semanticDirectory(fixture.root, fixture.workItemId),
      ".append.lock",
    );
    await writeFile(lockPath, "", "utf8");

    await expect(
      workspace.publishSemanticEventIntent(
        fixture.workItemId,
        intent.intent_id,
      ),
    ).resolves.toMatchObject({ stream_sequence: 1 });
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never reclaims an aged append lock owned by a live local process", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root, {
      connectedProcessProbe: async () => true,
      exclusiveWaitMs: 500,
      exclusivePollMs: 25,
    });
    const intent = workflowIntent(fixture, "live-append-lock-owner");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [intent]);
    const lockPath = join(
      semanticDirectory(fixture.root, fixture.workItemId),
      ".append.lock",
    );
    const ownerSource = appendLockOwnerSource(hostname());
    await writeFile(lockPath, ownerSource, "utf8");
    const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    await utimes(lockPath, staleTime, staleTime);

    await expectRepairRequired(
      workspace.publishSemanticEventIntent(
        fixture.workItemId,
        intent.intent_id,
      ),
    );
    expect(await readFile(lockPath, "utf8")).toBe(ownerSource);
  });

  it("reclaims an append lock owned by a dead local process immediately", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root, {
      connectedProcessProbe: async () => false,
      exclusiveWaitMs: 500,
      exclusivePollMs: 25,
    });
    const intent = workflowIntent(fixture, "dead-append-lock-owner");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [intent]);
    const lockPath = join(
      semanticDirectory(fixture.root, fixture.workItemId),
      ".append.lock",
    );
    await writeFile(lockPath, appendLockOwnerSource(hostname()), "utf8");
    const startedAt = Date.now();

    const published = await workspace.publishSemanticEventIntent(
      fixture.workItemId,
      intent.intent_id,
    );

    expect(published.stream_sequence).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(250);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never reclaims an aged append lock owned on a foreign host", async () => {
    const fixture = await createFixture();
    let probeCalls = 0;
    const workspace = new ProductWorkspace(fixture.root, {
      connectedProcessProbe: async () => {
        probeCalls += 1;
        return false;
      },
      exclusiveWaitMs: 500,
      exclusivePollMs: 25,
    });
    const intent = workflowIntent(fixture, "foreign-append-lock-owner");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [intent]);
    const lockPath = join(
      semanticDirectory(fixture.root, fixture.workItemId),
      ".append.lock",
    );
    const foreignHostname = `${hostname()}-foreign`;
    const ownerSource = appendLockOwnerSource(foreignHostname);
    await writeFile(lockPath, ownerSource, "utf8");
    const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    await utimes(lockPath, staleTime, staleTime);

    const error = await expectRepairRequired(
      workspace.publishSemanticEventIntent(
        fixture.workItemId,
        intent.intent_id,
      ),
    );
    expect(error.message).toContain(foreignHostname);
    expect(probeCalls).toBe(0);
    expect(await readFile(lockPath, "utf8")).toBe(ownerSource);
  });

  it("does not delete a successor append lock during reclamation", async () => {
    const fixture = await createFixture();
    const lockPath = join(
      semanticDirectory(fixture.root, fixture.workItemId),
      ".append.lock",
    );
    const successorSource = appendLockOwnerSource(hostname());
    const workspace = new SuccessorAppendLockWorkspace(
      fixture.root,
      lockPath,
      successorSource,
    );
    const intent = workflowIntent(fixture, "successor-append-lock-owner");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [intent]);
    await writeFile(lockPath, "abandoned-owner\n", "utf8");
    const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    await utimes(lockPath, staleTime, staleTime);

    await expectRepairRequired(
      workspace.publishSemanticEventIntent(
        fixture.workItemId,
        intent.intent_id,
      ),
    );
    expect(await readFile(lockPath, "utf8")).toBe(successorSource);
  });

  it("keeps independent sequences for different work items", async () => {
    const fixture = await createFixture();
    const secondWorkItemId = `wi_${randomUUID()}`;
    await addWorkItem(fixture.root, secondWorkItemId);
    const secondFixture: SemanticFixture = {
      root: fixture.root,
      workItemId: secondWorkItemId,
      ...(await writeAppliedControllerSource(
        fixture.root,
        secondWorkItemId,
      )),
    };
    const workspace = new ProductWorkspace(fixture.root);
    const firstIntent = workflowIntent(fixture, "first-stream");
    const secondIntent = workflowIntent(secondFixture, "second-stream");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [firstIntent]);
    await workspace.writeSemanticEventIntents(secondWorkItemId, [secondIntent]);

    const [firstEvent, secondEvent] = await Promise.all([
      workspace.publishSemanticEventIntent(
        fixture.workItemId,
        firstIntent.intent_id,
      ),
      workspace.publishSemanticEventIntent(
        secondWorkItemId,
        secondIntent.intent_id,
      ),
    ]);
    expect(firstEvent.stream_sequence).toBe(1);
    expect(secondEvent.stream_sequence).toBe(1);
  });

  it("fails closed on malformed, symlinked, and identity-mismatched events", async () => {
    const malformed = await createFixture();
    const malformedWorkspace = new ProductWorkspace(malformed.root);
    const malformedIntent = workflowIntent(malformed, "malformed");
    await malformedWorkspace.writeSemanticEventIntents(malformed.workItemId, [
      malformedIntent,
    ]);
    await writeFile(eventPath(malformed.root, malformed.workItemId, 1), "{}\n");
    await expect(
      malformedWorkspace.publishSemanticEventIntent(
        malformed.workItemId,
        malformedIntent.intent_id,
      ),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);

    const linked = await createFixture();
    const linkedWorkspace = new ProductWorkspace(linked.root);
    const linkedIntent = workflowIntent(linked, "linked");
    await linkedWorkspace.writeSemanticEventIntents(linked.workItemId, [
      linkedIntent,
    ]);
    const outside = join(linked.root, "outside.json");
    await writeFile(outside, "{}\n");
    await symlink(outside, eventPath(linked.root, linked.workItemId, 1));
    await expect(
      linkedWorkspace.publishSemanticEventIntent(
        linked.workItemId,
        linkedIntent.intent_id,
      ),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);

    const mismatched = await createFixture();
    const mismatchedWorkspace = new ProductWorkspace(mismatched.root);
    const mismatchedIntent = workflowIntent(mismatched, "identity-mismatch");
    await mismatchedWorkspace.writeSemanticEventIntents(
      mismatched.workItemId,
      [mismatchedIntent],
    );
    const wrongSequenceEvent = semanticEventSchema.parse({
      schema_version: 1,
      event_id: deriveSemanticEventId({
        schema_version: 1,
        work_item_id: mismatched.workItemId,
        binding: mismatchedIntent.binding,
        kind: mismatchedIntent.kind,
        stream_sequence: 2,
      }),
      stream_sequence: 2,
      kind: mismatchedIntent.kind,
      work_item_id: mismatched.workItemId,
      binding: mismatchedIntent.binding,
      run: null,
      actor: mismatchedIntent.actor,
      outcome: mismatchedIntent.outcome,
      occurred_at: mismatchedIntent.occurred_at,
      recorded_at: "2026-08-12T07:00:02.000Z",
      evidence: mismatchedIntent.evidence.map((selector) => ({
        kind: selector.kind,
        path: selector.path,
        content_sha256: selector.expected_content_sha256,
      })) as SemanticEventV1["evidence"],
      action: null,
      details: mismatchedIntent.details,
      intent_id: mismatchedIntent.intent_id,
    });
    await writeFile(
      eventPath(mismatched.root, mismatched.workItemId, 1),
      canonicalSerializeSemanticEvent(wrongSequenceEvent),
    );
    await expect(
      mismatchedWorkspace.publishSemanticEventIntent(
        mismatched.workItemId,
        mismatchedIntent.intent_id,
      ),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
  });

  it("fails closed when one intent is published more than once", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root);
    const firstIntent = workflowIntent(fixture, "duplicate-first");
    const secondIntent = workflowIntent(fixture, "duplicate-second");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [
      firstIntent,
      secondIntent,
    ]);
    const firstEvent = await workspace.publishSemanticEventIntent(
      fixture.workItemId,
      firstIntent.intent_id,
    );
    await workspace.publishSemanticEventIntent(
      fixture.workItemId,
      secondIntent.intent_id,
    );
    const duplicate = semanticEventSchema.parse({
      ...firstEvent,
      stream_sequence: 2,
      event_id: deriveSemanticEventId({
        schema_version: 1,
        work_item_id: fixture.workItemId,
        binding: firstEvent.binding,
        kind: firstEvent.kind,
        stream_sequence: 2,
      }),
    });
    await writeFile(
      eventPath(fixture.root, fixture.workItemId, 2),
      canonicalSerializeSemanticEvent(duplicate),
    );

    await expect(
      workspace.publishSemanticEventIntent(
        fixture.workItemId,
        firstIntent.intent_id,
      ),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
  });

  it("refuses publication after referenced evidence is mutated or substituted", async () => {
    const mutated = await createFixture();
    const mutatedEvidencePath = ".founder/evidence.txt";
    const originalEvidence = "authoritative evidence\n";
    await writeFile(
      join(mutated.root, ...mutatedEvidencePath.split("/")),
      originalEvidence,
    );
    const mutatedIntent = workflowIntent(mutated, "mutated-evidence", {
      evidencePath: mutatedEvidencePath,
      evidenceSha256: hash(originalEvidence),
    });
    const mutatedWorkspace = new ProductWorkspace(mutated.root);
    await mutatedWorkspace.writeSemanticEventIntents(mutated.workItemId, [
      mutatedIntent,
    ]);
    await writeFile(
      join(mutated.root, ...mutatedEvidencePath.split("/")),
      "changed evidence\n",
    );
    await expect(
      mutatedWorkspace.publishSemanticEventIntent(
        mutated.workItemId,
        mutatedIntent.intent_id,
      ),
    ).rejects.toBeInstanceOf(ControllerConflictError);
    expect(
      await readdir(
        join(
          semanticDirectory(mutated.root, mutated.workItemId),
          "events",
        ),
      ),
    ).toEqual([]);

    const substituted = await createFixture();
    const substitutedEvidencePath = ".founder/substituted.txt";
    const substitutionTarget = join(substituted.root, "same-bytes.txt");
    await writeFile(substitutionTarget, originalEvidence);
    await symlink(
      substitutionTarget,
      join(substituted.root, ...substitutedEvidencePath.split("/")),
    );
    const substitutedIntent = workflowIntent(
      substituted,
      "substituted-evidence",
      {
        evidencePath: substitutedEvidencePath,
        evidenceSha256: hash(originalEvidence),
      },
    );
    const substitutedWorkspace = new ProductWorkspace(substituted.root);
    await substitutedWorkspace.writeSemanticEventIntents(
      substituted.workItemId,
      [substitutedIntent],
    );
    await expect(
      substitutedWorkspace.publishSemanticEventIntent(
        substituted.workItemId,
        substitutedIntent.intent_id,
      ),
    ).rejects.toBeInstanceOf(InvalidWorkspaceError);
  });

  it("returns the same exact event when replayed after later appends", async () => {
    const fixture = await createFixture();
    const workspace = new ProductWorkspace(fixture.root);
    const firstIntent = workflowIntent(fixture, "stable-replay-first");
    const secondIntent = workflowIntent(fixture, "stable-replay-second");
    await workspace.writeSemanticEventIntents(fixture.workItemId, [
      firstIntent,
      secondIntent,
    ]);
    const first = await workspace.publishSemanticEventIntent(
      fixture.workItemId,
      firstIntent.intent_id,
    );
    await workspace.publishSemanticEventIntent(
      fixture.workItemId,
      secondIntent.intent_id,
    );

    expect(
      await workspace.publishSemanticEventIntent(
        fixture.workItemId,
        firstIntent.intent_id,
      ),
    ).toEqual(first);
    expect(await readEvent(fixture, 1)).toEqual(first);
  });
});
