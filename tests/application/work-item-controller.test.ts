import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import {
  WorkItemController,
  deriveControllerIdempotencyKey,
} from "../../src/application/work-item-controller";
import { ControllerConflictError } from "../../src/domain/work-item";
import { ProductWorkspace } from "../../src/workspace/product-workspace";

const createdRoots: string[] = [];
const fixedClock = () => new Date("2026-07-21T21:00:00.000Z");

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
    stringify({ schema_version: 1, product_name: "Controller Test" }),
    "utf8",
  );
  return { root, repository: new ProductWorkspace(root) };
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
    const controller = new WorkItemController(repository, fixedClock);

    const activated = await controller.updateGoalContract(
      created.goal.work_item_id,
      firstContract,
    );
    expect(activated.work_item.goal).toMatchObject({
      ...firstContract,
      goal_version: 1,
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
    expect(updated.work_item.goal.goal_version).toBe(2);
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

  it("applies and replays an exact transition without changing durable state twice", async () => {
    const { root, repository } = await createWorkspace();
    const created = await createUncontractedItem(repository);
    const controller = new WorkItemController(repository, fixedClock);
    await controller.updateGoalContract(created.goal.work_item_id, firstContract);
    const input = {
      target_phase: "spec" as const,
      target_status: "active" as const,
      expected_phase: "idea" as const,
      expected_status: "active" as const,
      expected_schema_version: 1 as const,
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
    const controller = new WorkItemController(repository, fixedClock);

    await expect(
      controller.transition(created.goal.work_item_id, {
        target_phase: "spec",
        target_status: "active",
        expected_phase: "idea",
        expected_status: "active",
        expected_schema_version: 1,
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
          expected_schema_version: 1 as const,
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
          expected_schema_version: 1 as const,
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
          expected_schema_version: 1 as const,
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
