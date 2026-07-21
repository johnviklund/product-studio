import { join } from "node:path";

import { SQLitePortfolioIndex } from "../index/work-item-index";
import { PortfolioRegistry } from "../workspace/portfolio-registry";
import { PortfolioService } from "./portfolio";

const applicationRoot = process.cwd();
const localDataRoot = join(applicationRoot, ".local-data");

export const portfolioRegistryPath = join(localDataRoot, "registry.json");
export const portfolioIndexPath = join(localDataRoot, "index.sqlite");
export const portfolioInboxRoot = join(applicationRoot, ".portfolio", "inbox");

let portfolioServicePromise: Promise<PortfolioService> | undefined;

export function getPortfolioService(): Promise<PortfolioService> {
  if (portfolioServicePromise === undefined) {
    const registry = new PortfolioRegistry(portfolioRegistryPath);
    const index = new SQLitePortfolioIndex(portfolioIndexPath);
    const service = new PortfolioService(registry, index, portfolioInboxRoot);

    portfolioServicePromise = service
      .rebuild()
      .then(() => service)
      .catch((error: unknown) => {
        index.close();
        portfolioServicePromise = undefined;
        throw error;
      });
  }

  return portfolioServicePromise;
}
