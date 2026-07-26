import { join } from "node:path";

import { z } from "zod";

import { SQLitePortfolioIndex } from "../index/work-item-index";
import { StdioAcpClientAdapter } from "../infrastructure/acp/acp-client";
import { PortfolioRegistry } from "../workspace/portfolio-registry";
import {
  CopilotConnectedExecuteRuntime,
  PortfolioService,
  type ConnectedExecuteRuntime,
} from "./portfolio";

const applicationRoot = process.cwd();
const localDataRoot = join(applicationRoot, ".local-data");

export const portfolioRegistryPath = join(localDataRoot, "registry.json");
export const portfolioIndexPath = join(localDataRoot, "index.sqlite");
export const portfolioInboxRoot = join(applicationRoot, ".portfolio", "inbox");

let portfolioServicePromise: Promise<PortfolioService> | undefined;

const copilotRuntimeProfileSchema = z.strictObject({
  preflight: z.strictObject({
    executable: z.string().min(1),
    version: z.string().min(1),
    authentication: z.literal("noninteractive_authenticated"),
    available_model_ids: z.array(z.string().min(1)).min(1),
  }),
  default_model: z.string().min(1),
  reasoning_effort: z.enum([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]),
  available_tools: z.array(z.string().min(1)).min(1),
  excluded_tools: z.array(z.string().min(1)).min(1),
  environment: z.record(z.string(), z.string()),
});

function configuredConnectedRuntime(): ConnectedExecuteRuntime | undefined {
  const source = process.env.PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON;
  if (source === undefined || source === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("PRODUCT_STUDIO_COPILOT_RUNTIME_PROFILE_JSON must be valid JSON.");
  }
  return new CopilotConnectedExecuteRuntime(new StdioAcpClientAdapter(), {
    profile: copilotRuntimeProfileSchema.parse(parsed),
  });
}

export function getPortfolioService(): Promise<PortfolioService> {
  if (portfolioServicePromise === undefined) {
    const registry = new PortfolioRegistry(portfolioRegistryPath);
    const index = new SQLitePortfolioIndex(portfolioIndexPath);
    const service = new PortfolioService(
      registry,
      index,
      portfolioInboxRoot,
      undefined,
      configuredConnectedRuntime(),
    );

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
