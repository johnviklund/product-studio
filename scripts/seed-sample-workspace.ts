import { cp, lstat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = join(import.meta.dirname, "..");
const defaultFixtureRoot = join(repositoryRoot, "fixtures", "sample-workspace");
const defaultDestination = join(
  repositoryRoot,
  ".local-data",
  "sample-workspace",
);

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export async function seedSampleWorkspace(
  fixtureRoot = defaultFixtureRoot,
  destination = defaultDestination,
): Promise<"seeded" | "preserved"> {
  if (await exists(destination)) {
    return "preserved";
  }

  await cp(fixtureRoot, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return "seeded";
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const outcome = await seedSampleWorkspace();
  console.log(
    outcome === "seeded"
      ? "Seeded the local sample workspace."
      : "Preserved the existing local sample workspace.",
  );
}
