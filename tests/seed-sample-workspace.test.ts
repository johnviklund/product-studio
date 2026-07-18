import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { seedSampleWorkspace } from "../scripts/seed-sample-workspace";

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("seedSampleWorkspace", () => {
  it("copies once and never overwrites an existing local workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "product-studio-seed-"));
    createdRoots.push(root);
    const fixtureRoot = join(root, "fixture");
    const destination = join(root, "local", "sample-workspace");
    const fixtureState = join(fixtureRoot, ".founder", "state.json");
    const destinationState = join(destination, ".founder", "state.json");
    await mkdir(join(fixtureRoot, ".founder"), { recursive: true });
    await writeFile(fixtureState, '{"source":"fixture"}\n', "utf8");

    expect(await seedSampleWorkspace(fixtureRoot, destination)).toBe("seeded");
    expect(await readFile(destinationState, "utf8")).toBe(
      '{"source":"fixture"}\n',
    );

    await writeFile(destinationState, '{"source":"local"}\n', "utf8");
    await writeFile(fixtureState, '{"source":"changed fixture"}\n', "utf8");

    expect(await seedSampleWorkspace(fixtureRoot, destination)).toBe("preserved");
    expect(await readFile(destinationState, "utf8")).toBe(
      '{"source":"local"}\n',
    );
  });
});
