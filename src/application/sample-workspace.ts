import { join } from "node:path";

import { SQLiteWorkItemIndex } from "../index/work-item-index";
import { ProductWorkspace } from "../workspace/product-workspace";
import { WorkItemsService } from "./work-items";

const applicationRoot = process.cwd();
const localDataRoot = join(applicationRoot, ".local-data");

export const sampleWorkspaceRoot = join(localDataRoot, "sample-workspace");
export const sampleIndexPath = join(localDataRoot, "index.sqlite");

let sampleServicePromise: Promise<WorkItemsService> | undefined;

export function getSampleWorkItemsService(): Promise<WorkItemsService> {
  if (sampleServicePromise === undefined) {
    const workspace = new ProductWorkspace(sampleWorkspaceRoot);
    const index = new SQLiteWorkItemIndex(sampleIndexPath);
    const service = new WorkItemsService(workspace, index);

    sampleServicePromise = service
      .rebuild()
      .then(() => service)
      .catch((error: unknown) => {
        index.close();
        sampleServicePromise = undefined;
        throw error;
      });
  }

  return sampleServicePromise;
}
