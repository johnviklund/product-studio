import { join } from "node:path";

const applicationRoot = process.cwd();
const localDataRoot = join(applicationRoot, ".local-data");

export const sampleWorkspaceRoot = join(localDataRoot, "sample-workspace");
export const sampleIndexPath = join(localDataRoot, "index.sqlite");
