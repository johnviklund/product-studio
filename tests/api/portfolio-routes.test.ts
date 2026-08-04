import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { PortfolioService } from "../../src/application/portfolio";
import { UntrustedRequestOriginError } from "../../src/application/request-origin";
import { WorkItemController } from "../../src/application/work-item-controller";
import type { StoredImportEvidence } from "../../src/domain/result";
import {
  InvalidWorkItemTransitionError,
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
} from "../../src/domain/portfolio";
import {
  CLOSED_IN_SLICE_PHASE_TRANSITIONS,
  CONTROLLER_ONLY_PHASE_TRANSITIONS,
} from "../../src/domain/workflow-policy";
import {
  ControllerConflictError,
  InvalidWorkspaceError,
  WorkItemTargetCollisionError,
  WorkItemTransferFailedError,
  type VerificationCommand,
} from "../../src/domain/work-item";
import type {
  GitVerificationAdapter,
  VerificationRunner,
} from "../../src/domain/verification";
import { SQLitePortfolioIndex } from "../../src/index/work-item-index";
import { ProductWorkspace } from "../../src/workspace/product-workspace";
import { PortfolioRegistry } from "../../src/workspace/portfolio-registry";

const getService = vi.hoisted(() => vi.fn());
const getTrustedOriginConfig = vi.hoisted(() => vi.fn());

vi.mock("../../src/application/portfolio-service", () => ({
  getPortfolioService: getService,
  getPortfolioTrustedOriginConfig: getTrustedOriginConfig,
}));

import * as workItemsRoute from "../../app/api/work-items/route";
import { POST as createPortfolioWorkItem } from "../../app/api/portfolio/work-items/route";
import { PATCH as savePortfolioWorkItem } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/edit/route";
import * as portfolioMissionRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/route";
import * as portfolioMissionImportRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/import/route";
import * as portfolioReviewMissionRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/review/route";
import * as portfolioReviewMissionImportRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/review/import/route";
import * as portfolioPatchMissionRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/patch/route";
import * as portfolioPatchMissionImportRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/patch/import/route";
import * as portfolioPatchPlanRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/patch-plan/route";
import * as portfolioAttentionRoute from "../../app/api/portfolio/attention/route";
import * as portfolioMissionRetryRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/retry/route";
import * as portfolioConnectedLaunchRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/launch/route";
import * as portfolioConnectedRunRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/run/route";
import * as portfolioConnectedCancelRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/cancel/route";
import * as portfolioConnectedPermissionRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/connected/permission/route";
import * as portfolioShapingRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/route";
import * as portfolioBrainstormMissionRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/mission/route";
import * as portfolioBrainstormImportRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/import/route";
import * as portfolioSpecMissionRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/spec/mission/route";
import * as portfolioSpecImportRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/spec/import/route";
import * as brainstormConnectedLaunchRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/connected/launch/route";
import * as brainstormConnectedRunRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/connected/run/route";
import * as brainstormConnectedCancelRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/connected/cancel/route";
import * as brainstormManualIngressRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/manual-ingress/route";
import * as brainstormRequestChangesRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/request-changes/route";
import * as brainstormRetryLaunchRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/retry-launch/route";
import * as brainstormUseResultRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/brainstorm/use-result/route";
import * as specConnectedLaunchRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/spec/connected/launch/route";
import * as specConnectedRunRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/spec/connected/run/route";
import * as specConnectedCancelRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/spec/connected/cancel/route";
import * as specManualIngressRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/spec/manual-ingress/route";
import * as specRequestChangesRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/spec/request-changes/route";
import * as specRetryLaunchRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/spec/retry-launch/route";
import * as specApproveRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/spec/approve/route";
import * as planConnectedLaunchRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/plan/connected/launch/route";
import * as planConnectedRunRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/plan/connected/run/route";
import * as planConnectedCancelRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/plan/connected/cancel/route";
import * as planMissionRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/plan/mission/route";
import * as planManualIngressRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/plan/manual-ingress/route";
import * as planImportRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/plan/import/route";
import * as planRequestChangesRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/plan/request-changes/route";
import * as planRetryLaunchRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/plan/retry-launch/route";
import * as planReplanRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/plan/replan/route";
import * as startBrainstormRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/start-brainstorm/route";
import * as shapingModelsRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/shaping/models/route";
import * as repairControllerLeaseRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/repair-controller-lease/route";
import { GET as getPortfolioRunEvidence } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/run-evidence/route";
import { SHAPING_REQUEST_MAX_BYTES } from "../../app/api/request-body";
import {
  PATCH as updatePortfolioWorkItem,
} from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/route";
import { POST as rebuildWorkItems } from "../../app/api/work-items/rebuild/route";
import {
  GET as getWorkspaces,
  POST as registerWorkspace,
} from "../../app/api/workspaces/route";

const compilePortfolioMission = portfolioMissionRoute.POST;
const importPortfolioMission = portfolioMissionImportRoute.POST;
const compilePortfolioReviewMission = portfolioReviewMissionRoute.POST;
const importPortfolioReviewMission = portfolioReviewMissionImportRoute.POST;
const compilePortfolioPatchMission = portfolioPatchMissionRoute.POST;
const importPortfolioPatchMission = portfolioPatchMissionImportRoute.POST;
const acceptPortfolioPatchPlan = portfolioPatchPlanRoute.POST;
const getPortfolioAttention = portfolioAttentionRoute.GET;
const retryPortfolioMission = portfolioMissionRetryRoute.POST;
const launchPortfolioConnectedMission = portfolioConnectedLaunchRoute.POST;
const getPortfolioConnectedRuns = portfolioConnectedRunRoute.GET;
const cancelPortfolioConnectedRun = portfolioConnectedCancelRoute.POST;
const decidePortfolioConnectedPermission = portfolioConnectedPermissionRoute.POST;
const listPortfolioShaping = portfolioShapingRoute.GET;

const createdRoots: string[] = [];
const openIndexes: SQLitePortfolioIndex[] = [];
const controllerGit: GitVerificationAdapter = {
  async resolveCommit() {
    return "a".repeat(40);
  },
  async isAncestor() {
    return true;
  },
  async readHeadCommit() {
    return "a".repeat(40);
  },
  async isWorktreeCleanExcludingFounder() {
    return true;
  },
  async listChangedFiles() {
    return ["src/application/portfolio.ts"];
  },
};
const controllerRunner: VerificationRunner = {
  async run(command: VerificationCommand) {
    return {
      name: command.name,
      argv: command.argv,
      started_at: "2026-07-22T12:00:00.000Z",
      completed_at: "2026-07-22T12:00:01.000Z",
      duration_ms: 1000,
      status: "passed",
      exit_code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      output_truncated: false,
    };
  },
};

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

async function createWorkspace(): Promise<string> {
  const root = await createRoot("product-studio-api-workspace-");
  const founderDirectory = join(root, ".founder");
  await mkdir(founderDirectory, { recursive: true });
  await writeFile(
    join(founderDirectory, "product.yaml"),
    stringify({
      schema_version: 2,
      product_name: "API Workspace",
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
  await new ProductWorkspace(root).create({
    title: "Expose through HTTP",
    type: "Feature",
  });
  return root;
}

async function createMissionReadyWorkspace(): Promise<{
  workspacePath: string;
  workItemId: string;
}> {
  const workspacePath = await createWorkspace();
  const repository = new ProductWorkspace(workspacePath);
  const item = (await repository.list())[0];
  if (item === undefined) {
    throw new Error("Expected API mission fixture work item");
  }
  const controller = new WorkItemController(
    repository,
    () => new Date("2026-07-22T12:00:00.000Z"),
    controllerGit,
    controllerRunner,
  );
  let current = (
    await controller.saveWorkItem(item.goal.work_item_id, {
      target_source_id: "inbox",
      title: item.goal.title,
      type: item.goal.type ?? null,
      priority: item.goal.priority ?? null,
      tags: item.goal.tags ?? [],
      notes: item.goal.notes ?? null,
      goal_contract: {
        purpose: "Keep the mission package reproducible.",
        acceptance_criteria: ["The mission package is reproducible"],
        non_goals: ["Do not mutate the workspace."],
        allowed_scope: ["src/application", "app/api"],
        review_ready: ["All checks pass"],
      },
    })
  ).work_item;
  for (const targetPhase of ["spec", "plan", "execute"] as const) {
    current = (
      await controller.transition(current.goal.work_item_id, {
        target_phase: targetPhase,
        target_status: "active",
        expected_phase: current.state.phase,
        expected_status: current.state.status,
        expected_schema_version: 2,
        expected_goal_version: current.state.goal_version!,
        expected_input_revision: current.state.input_revision!,
        attempt: current.state.attempt!,
      })
    ).work_item;
  }
  return { workspacePath, workItemId: item.goal.work_item_id };
}

async function createService(): Promise<{
  registry: PortfolioRegistry;
  service: PortfolioService;
}> {
  const applicationRoot = await createRoot("product-studio-api-app-");
  const registry = new PortfolioRegistry(
    join(applicationRoot, ".local-data", "registry.json"),
  );
  const index = new SQLitePortfolioIndex(":memory:");
  const service = new PortfolioService(
    registry,
    index,
    join(applicationRoot, ".portfolio", "inbox"),
    (workspacePath) =>
      new ProductWorkspace(workspacePath, {
        git: controllerGit,
        verificationRunner: controllerRunner,
      }),
  );
  openIndexes.push(index);
  getService.mockResolvedValue(service);
  return { registry, service };
}

function registrationRequest(workspacePath: string): Request {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_path: workspacePath }),
  });
}

function registrationRequestBody(body: unknown): Request {
  return new Request("http://localhost/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function phaseUpdateRequest(body: unknown): Request {
  return new Request("http://localhost/api/portfolio/work-items/source/item", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function captureRequest(body: unknown): Request {
  return new Request("http://localhost/api/portfolio/work-items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function saveWorkItemRequest(body: unknown): Request {
  return new Request(
    "http://localhost/api/portfolio/work-items/source/item/edit",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function missionRequest(): Request {
  return new Request(
    "http://localhost/api/portfolio/work-items/source/item/mission",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ignored-no-body-contract",
    },
  );
}

function guardedWorkItemPostRequest(
  relativePath: string,
  body: unknown,
  options: {
    origin?: string | null;
    host?: string | null;
    raw_body?: boolean;
  } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const origin =
    "origin" in options ? options.origin : "http://127.0.0.1:3000";
  const host = "host" in options ? options.host : "127.0.0.1:3000";
  if (origin !== null && origin !== undefined) {
    headers.set("origin", origin);
  }
  if (host !== null && host !== undefined) {
    headers.set("host", host);
  }
  return new Request(
    `http://localhost/api/portfolio/work-items/source/item/${relativePath}`,
    {
      method: "POST",
      headers,
      body: options.raw_body ? String(body) : JSON.stringify(body),
    },
  );
}

function shapingGetRequest(path: string): Request {
  return new Request(
    `http://localhost/api/portfolio/work-items/source/item/shaping${path}`,
    { method: "GET" },
  );
}

function missionActionRequest(action: "import" | "retry"): Request {
  return new Request(
    `http://localhost/api/portfolio/work-items/source/item/mission/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ignored-no-body-contract",
    },
  );
}

function reviewMissionRequest(body: unknown): Request {
  return new Request(
    "http://localhost/api/portfolio/work-items/source/item/mission/review",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function reviewMissionImportRequest(): Request {
  return new Request(
    "http://localhost/api/portfolio/work-items/source/item/mission/review/import",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ignored-no-body-contract",
    },
  );
}

function runEvidenceRequest(): Request {
  return new Request(
    "http://localhost/api/portfolio/work-items/source/item/run-evidence",
    { method: "GET" },
  );
}

function connectedRequest(
  action: "launch" | "cancel" | "permission",
  body: unknown,
): Request {
  return new Request(
    `http://localhost/api/portfolio/work-items/source/item/mission/connected/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function connectedRunRequest(): Request {
  return new Request(
    "http://localhost/api/portfolio/work-items/source/item/mission/connected/run",
    { method: "GET" },
  );
}

function phaseUpdateContext(sourceId: string, workItemId: string) {
  return { params: Promise.resolve({ sourceId, workItemId }) };
}

type ApiRouteHandler = (
  request: Request,
  context: ReturnType<typeof phaseUpdateContext>,
) => Promise<Response>;

interface ShapingPostCase {
  name: string;
  relativePath: string;
  handler: ApiRouteHandler;
  body: Record<string, unknown>;
  serviceMethod: string;
  expectedArgs: (sourceId: string, workItemId: string) => unknown[];
}

interface ShapingGetCase {
  name: string;
  path: string;
  handler: ApiRouteHandler;
  serviceMethod: string;
  expectedArgs: (sourceId: string, workItemId: string) => unknown[];
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHAPING_RUN_ID = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
const bindingBody = {
  expected_mission_content_sha256: SHA_A,
  expected_shaping_state_sha256: SHA_C,
};
const decisionBody = {
  launch_mode: "connected" as const,
  requested_model: "model-next",
  expected_mission_content_sha256: SHA_A,
  expected_result_content_sha256: SHA_B,
  expected_shaping_state_sha256: SHA_C,
};
const controllerDecisionBody = {
  launch_mode: "connected" as const,
  next_requested_model: "model-next",
  expected_mission_content_sha256: SHA_A,
  expected_result_content_sha256: SHA_B,
  expected_shaping_state_sha256: SHA_C,
};

const SHAPING_POST_CASES: ShapingPostCase[] = [
  ...([
    {
      phase: "brainstorm" as const,
      launch: brainstormConnectedLaunchRoute.POST,
      runCancel: brainstormConnectedCancelRoute.POST,
      mission: portfolioBrainstormMissionRoute.POST,
      manualIngress: brainstormManualIngressRoute.POST,
      importResult: portfolioBrainstormImportRoute.POST,
      requestChanges: brainstormRequestChangesRoute.POST,
      retry: brainstormRetryLaunchRoute.POST,
      compileMethod: "compileBrainstormMission",
      importMethod: "importBrainstormResult",
    },
    {
      phase: "spec" as const,
      launch: specConnectedLaunchRoute.POST,
      runCancel: specConnectedCancelRoute.POST,
      mission: portfolioSpecMissionRoute.POST,
      manualIngress: specManualIngressRoute.POST,
      importResult: portfolioSpecImportRoute.POST,
      requestChanges: specRequestChangesRoute.POST,
      retry: specRetryLaunchRoute.POST,
      compileMethod: "compileSpecMission",
      importMethod: "importSpecResult",
    },
    {
      phase: "plan" as const,
      launch: planConnectedLaunchRoute.POST,
      runCancel: planConnectedCancelRoute.POST,
      mission: planMissionRoute.POST,
      manualIngress: planManualIngressRoute.POST,
      importResult: planImportRoute.POST,
      requestChanges: planRequestChangesRoute.POST,
      retry: planRetryLaunchRoute.POST,
      compileMethod: "compilePlanMission",
      importMethod: "importPlanResult",
    },
  ] as const).flatMap((routes): ShapingPostCase[] => [
    {
      name: `${routes.phase} connected launch`,
      relativePath: `shaping/${routes.phase}/connected/launch`,
      handler: routes.launch,
      body: { requested_model: "model-current" },
      serviceMethod: "launchShapingRun",
      expectedArgs: (sourceId, workItemId) => [
        sourceId,
        workItemId,
        routes.phase,
        { requested_model: "model-current" },
      ],
    },
    {
      name: `${routes.phase} connected cancel`,
      relativePath: `shaping/${routes.phase}/connected/cancel`,
      handler: routes.runCancel,
      body: { shaping_run_id: SHAPING_RUN_ID },
      serviceMethod: "cancelShapingRun",
      expectedArgs: (sourceId, workItemId) => [
        sourceId,
        workItemId,
        SHAPING_RUN_ID,
        routes.phase,
      ],
    },
    {
      name: `${routes.phase} mission`,
      relativePath: `shaping/${routes.phase}/mission`,
      handler: routes.mission,
      body: {},
      serviceMethod: routes.compileMethod,
      expectedArgs: (sourceId, workItemId) => [sourceId, workItemId],
    },
    {
      name: `${routes.phase} manual ingress`,
      relativePath: `shaping/${routes.phase}/manual-ingress`,
      handler: routes.manualIngress,
      body: bindingBody,
      serviceMethod: "openManualIngress",
      expectedArgs: (sourceId, workItemId) => [
        sourceId,
        workItemId,
        routes.phase,
        bindingBody,
      ],
    },
    {
      name: `${routes.phase} import`,
      relativePath: `shaping/${routes.phase}/import`,
      handler: routes.importResult,
      body: bindingBody,
      serviceMethod: routes.importMethod,
      expectedArgs: (sourceId, workItemId) => [
        sourceId,
        workItemId,
        bindingBody,
      ],
    },
    {
      name: `${routes.phase} request changes`,
      relativePath: `shaping/${routes.phase}/request-changes`,
      handler: routes.requestChanges,
      body: { ...decisionBody, feedback: "Address the open question." },
      serviceMethod: "requestShapingChanges",
      expectedArgs: (sourceId, workItemId) => [
        sourceId,
        workItemId,
        { ...controllerDecisionBody, feedback: "Address the open question." },
        routes.phase,
      ],
    },
    {
      name: `${routes.phase} retry launch`,
      relativePath: `shaping/${routes.phase}/retry-launch`,
      handler: routes.retry,
      body: {
        decision_id: SHA_A,
        expected_shaping_state_sha256: SHA_C,
      },
      serviceMethod: "retryShapingLaunch",
      expectedArgs: (sourceId, workItemId) => [
        sourceId,
        workItemId,
        routes.phase,
        { decision_id: SHA_A, expected_shaping_state_sha256: SHA_C },
      ],
    },
  ]),
  {
    name: "start brainstorm",
    relativePath: "shaping/start-brainstorm",
    handler: startBrainstormRoute.POST,
    body: {
      launch_mode: "connected",
      requested_model: "model-next",
      expected_mission_content_sha256: null,
      expected_result_content_sha256: null,
      expected_shaping_state_sha256: SHA_C,
    },
    serviceMethod: "startBrainstorm",
    expectedArgs: (sourceId, workItemId) => [
      sourceId,
      workItemId,
      {
        launch_mode: "connected",
        next_requested_model: "model-next",
        expected_mission_content_sha256: null,
        expected_result_content_sha256: null,
        expected_shaping_state_sha256: SHA_C,
      },
    ],
  },
  {
    name: "use brainstorm result",
    relativePath: "shaping/brainstorm/use-result",
    handler: brainstormUseResultRoute.POST,
    body: decisionBody,
    serviceMethod: "useBrainstormResult",
    expectedArgs: (sourceId, workItemId) => [
      sourceId,
      workItemId,
      controllerDecisionBody,
    ],
  },
  {
    name: "approve spec result",
    relativePath: "shaping/spec/approve",
    handler: specApproveRoute.POST,
    body: { ...decisionBody, goal_contract_sha256: SHA_C },
    serviceMethod: "approveSpecResult",
    expectedArgs: (sourceId, workItemId) => [
      sourceId,
      workItemId,
      { ...controllerDecisionBody, goal_contract_sha256: SHA_C },
    ],
  },
  {
    name: "replan with updated contract",
    relativePath: "shaping/plan/replan",
    handler: planReplanRoute.POST,
    body: { ...decisionBody, goal_contract_sha256: SHA_C },
    serviceMethod: "replanWithUpdatedContract",
    expectedArgs: (sourceId, workItemId) => [
      sourceId,
      workItemId,
      { ...controllerDecisionBody, goal_contract_sha256: SHA_C },
    ],
  },
  {
    name: "repair retained controller lease",
    relativePath: "repair-controller-lease",
    handler: repairControllerLeaseRoute.POST,
    body: { acknowledged_run_id: SHAPING_RUN_ID },
    serviceMethod: "repairRetainedControllerLease",
    expectedArgs: (sourceId, workItemId) => [
      sourceId,
      workItemId,
      { acknowledged_run_id: SHAPING_RUN_ID },
    ],
  },
];

const SHAPING_GET_CASES: ShapingGetCase[] = [
  {
    name: "shaping artifact listing",
    path: "",
    handler: listPortfolioShaping,
    serviceMethod: "listShapingArtifacts",
    expectedArgs: (sourceId, workItemId) => [sourceId, workItemId],
  },
  {
    name: "brainstorm connected runs",
    path: "/brainstorm/connected/run",
    handler: brainstormConnectedRunRoute.GET,
    serviceMethod: "listShapingRuns",
    expectedArgs: (sourceId, workItemId) => [sourceId, workItemId, "brainstorm"],
  },
  {
    name: "spec connected runs",
    path: "/spec/connected/run",
    handler: specConnectedRunRoute.GET,
    serviceMethod: "listShapingRuns",
    expectedArgs: (sourceId, workItemId) => [sourceId, workItemId, "spec"],
  },
  {
    name: "plan connected runs",
    path: "/plan/connected/run",
    handler: planConnectedRunRoute.GET,
    serviceMethod: "listShapingRuns",
    expectedArgs: (sourceId, workItemId) => [sourceId, workItemId, "plan"],
  },
  {
    name: "shaping models",
    path: "/models",
    handler: shapingModelsRoute.GET,
    serviceMethod: "getShapingModelAvailability",
    expectedArgs: () => [],
  },
];

beforeEach(() => {
  getService.mockReset();
  getTrustedOriginConfig.mockReset();
  getTrustedOriginConfig.mockReturnValue({
    origin: "http://127.0.0.1:3000",
    host: "127.0.0.1:3000",
  });
});

afterEach(async () => {
  for (const index of openIndexes.splice(0)) {
    index.close();
  }
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("portfolio API routes", () => {
  it("registers and lists workspaces and their projected work items", async () => {
    await createService();
    const workspacePath = await createWorkspace();

    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();

    expect(registrationResponse.status).toBe(201);
    expect(registration).toMatchObject({
      workspace: {
        workspace_path: workspacePath,
        product_name: "API Workspace",
      },
      rebuild: { items: [expect.any(Object)], failures: [] },
    });

    const workspacesResponse = await getWorkspaces();
    expect(workspacesResponse.status).toBe(200);
    expect(await workspacesResponse.json()).toEqual({
      workspaces: [registration.workspace],
    });

    const workItemsResponse = await workItemsRoute.GET();
    expect(workItemsResponse.status).toBe(200);
    expect(await workItemsResponse.json()).toEqual({
      items: registration.rebuild.items,
    });
  });

  it("returns the full rebuild result envelope", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    await registerWorkspace(registrationRequest(workspacePath));

    const response = await rebuildWorkItems();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.failures).toEqual([]);
  });

  it("keeps a generic post-Execute phase update available", async () => {
    await createService();
    const { workspacePath, workItemId } = await createMissionReadyWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();
    const sourceId = registration.workspace.workspace_id as string;

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "review" }),
      phaseUpdateContext(sourceId, workItemId),
    );
    const updated = await response.json();

    expect(response.status).toBe(200);
    expect(updated).toMatchObject({
      source_id: sourceId,
      project: { workspace_path: workspacePath },
      work_item: {
        goal: { work_item_id: workItemId },
        state: { phase: "review", status: "active" },
      },
    });
    expect(await (await workItemsRoute.GET()).json()).toEqual({
      items: [updated],
    });
  });

  it("returns the documented 409 for every non-generic shaping arrow", async () => {
    const context = phaseUpdateContext("source", "item");
    const transitions = [
      ...CONTROLLER_ONLY_PHASE_TRANSITIONS.map((transition) => ({
        ...transition,
        reason: `${transition.action_label} — ${transition.explanation}`,
      })),
      ...CLOSED_IN_SLICE_PHASE_TRANSITIONS.map((transition) => ({
        ...transition,
        reason: transition.explanation,
      })),
    ];
    expect(transitions).toHaveLength(7);

    for (const transition of transitions) {
      const updateWorkItemPhase = vi.fn().mockRejectedValue(
        new InvalidWorkItemTransitionError(
          transition.from,
          transition.to,
          transition.reason,
        ),
      );
      getService.mockReset();
      getService.mockResolvedValue({ updateWorkItemPhase });

      const response = await updatePortfolioWorkItem(
        phaseUpdateRequest({ target_phase: transition.to }),
        context,
      );

      expect(response.status, `${transition.from} -> ${transition.to}`).toBe(409);
      expect(await response.json()).toEqual({
        error: { code: "invalid_transition", message: transition.reason },
      });
      expect(updateWorkItemPhase).toHaveBeenCalledWith(
        "source",
        "item",
        { target_phase: transition.to },
      );
    }
  });

  it("saves and assigns a source-qualified capture through the unified route", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();
    const targetSourceId = registration.workspace.workspace_id as string;

    const createResponse = await createPortfolioWorkItem(
      captureRequest({
        title: "Capture through HTTP",
        capture_kind: "idea",
      }),
    );
    const created = await createResponse.json();
    const workItemId = created.work_item.goal.work_item_id as string;
    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      source_id: "inbox",
      project: null,
      work_item: {
        goal: {
          title: "Capture through HTTP",
          capture: { kind: "idea", original_title: "Capture through HTTP" },
        },
        state: { phase: "idea", status: "active" },
      },
    });
    expect(created.work_item.goal).not.toHaveProperty("type");

    const saveResponse = await savePortfolioWorkItem(
      saveWorkItemRequest({
        target_source_id: targetSourceId,
        title: "Capture through HTTP",
        type: "Feature",
        priority: "high",
        tags: [],
        notes: null,
      }),
      phaseUpdateContext("inbox", workItemId),
    );
    const saved = await saveResponse.json();
    expect(saveResponse.status).toBe(200);
    expect(saved).toMatchObject({
      source_id: targetSourceId,
      project: { workspace_path: workspacePath },
      work_item: {
        goal: {
          work_item_id: workItemId,
          type: "Feature",
          priority: "high",
          capture: { original_title: "Capture through HTTP" },
        },
      },
    });
  });

  it("activates and revises a goal contract through the source-qualified PATCH route", async () => {
    await createService();
    const createResponse = await createPortfolioWorkItem(
      captureRequest({ title: "Contract through HTTP", capture_kind: "idea" }),
    );
    const created = await createResponse.json();
    const workItemId = created.work_item.goal.work_item_id as string;
    const goalContract = {
      purpose: "Prove the unified route reaches the controller.",
      acceptance_criteria: ["The form reaches the controller"],
      non_goals: ["Do not bypass the controller."],
      allowed_scope: ["src/application"],
      review_ready: ["API checks pass"],
    };

    const activatedResponse = await savePortfolioWorkItem(
      saveWorkItemRequest({
        target_source_id: "inbox",
        title: "Contract through HTTP",
        type: null,
        priority: null,
        tags: [],
        notes: null,
        goal_contract: goalContract,
      }),
      phaseUpdateContext("inbox", workItemId),
    );
    const activated = await activatedResponse.json();
    expect(activatedResponse.status).toBe(200);
    expect(activated).toMatchObject({
      source_id: "inbox",
      work_item: {
        goal: { goal_contract: { ...goalContract, goal_version: 1 } },
        state: { goal_version: 1, input_revision: 1, attempt: 0 },
      },
    });

    const revisedResponse = await savePortfolioWorkItem(
      saveWorkItemRequest({
        target_source_id: "inbox",
        title: "Contract through HTTP",
        type: null,
        priority: null,
        tags: [],
        notes: null,
        goal_contract: {
          ...goalContract,
          acceptance_criteria: ["The form revises the controller contract"],
        },
        expected_goal_version: 1,
        expected_input_revision: 1,
      }),
      phaseUpdateContext("inbox", workItemId),
    );
    expect(revisedResponse.status).toBe(200);
    expect(await revisedResponse.json()).toMatchObject({
      work_item: {
        goal: { goal_contract: { goal_version: 2 } },
        state: { goal_version: 2, input_revision: 2, attempt: 0 },
      },
    });
  });

  it("compiles and idempotently replays a source-qualified mission", async () => {
    await createService();
    const { workspacePath, workItemId } = await createMissionReadyWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();
    const context = phaseUpdateContext(
      registration.workspace.workspace_id,
      workItemId,
    );

    const firstResponse = await compilePortfolioMission(
      missionRequest(),
      context,
    );
    const first = await firstResponse.json();
    const secondResponse = await compilePortfolioMission(
      missionRequest(),
      context,
    );
    const second = await secondResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      workspace_path: workspacePath,
      task_path: join(
        workspacePath,
        ".founder",
        "missions",
        workItemId,
        "execute-1-1-0",
        "TASK.md",
      ),
      mission_path: join(
        workspacePath,
        ".founder",
        "missions",
        workItemId,
        "execute-1-1-0",
        "mission.json",
      ),
      mission: {
        identity: { work_item_id: workItemId },
        content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it("requires attestation for review compile and keeps review import bodyless", async () => {
    const sourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const mission = {
      mission: {
        identity: { phase: "review", work_item_id: workItemId },
        independence_attested: true,
      },
    };
    const imported = {
      source_id: sourceId,
      project: null,
      work_item: { state: { phase: "review", status: "active" } },
      evidence: { phase: "review", outcome: "applied" },
      result: { verdict: "clean", findings: [] },
    };
    const compileReviewMission = vi.fn().mockResolvedValue(mission);
    const importReviewResult = vi.fn().mockResolvedValue(imported);
    getService.mockResolvedValue({
      compileReviewMission,
      importReviewResult,
    });
    const context = phaseUpdateContext(sourceId, workItemId);

    const invalid = await compilePortfolioReviewMission(
      reviewMissionRequest({ independence_attested: false }),
      context,
    );
    const extended = await compilePortfolioReviewMission(
      reviewMissionRequest({
        independence_attested: true,
        model: "must-not-enter-the-contract",
      }),
      context,
    );
    const compiled = await compilePortfolioReviewMission(
      reviewMissionRequest({ independence_attested: true }),
      context,
    );
    const importedResponse = await importPortfolioReviewMission(
      reviewMissionImportRequest(),
      context,
    );

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expect(extended.status).toBe(400);
    expect(await extended.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expect(compiled.status).toBe(200);
    expect(await compiled.json()).toEqual(mission);
    expect(importedResponse.status).toBe(200);
    expect(await importedResponse.json()).toEqual(imported);
    expect(compileReviewMission).toHaveBeenCalledOnce();
    expect(compileReviewMission).toHaveBeenCalledWith(sourceId, workItemId, {
      independence_attested: true,
    });
    expect(importReviewResult).toHaveBeenCalledWith(sourceId, workItemId);
  });

  it("exposes bodyless patch actions and a read-only attention projection", async () => {
    const sourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const mission = {
      mission: { identity: { phase: "patch", work_item_id: workItemId } },
    };
    const imported = {
      source_id: sourceId,
      project: null,
      work_item: { state: { phase: "review", status: "active" } },
      evidence: { phase: "patch", outcome: "applied" },
    };
    const accepted = {
      source_id: sourceId,
      project: null,
      work_item: { state: { phase: "patch", status: "active" } },
      controller_run: { phase: "patch", outcome: "applied" },
    };
    const attention = [
      {
        kind: "governed",
        entry: {
          item: { source_id: sourceId, project: null },
          attention: { kind: "patch_plan_approval" },
          acceptance_criteria: [],
          verification: { status: "unknown", commands: [] },
          findings: [],
          patch_cycle_limit: 3,
          cost_capacity: "unknown",
        },
      },
    ];
    const compilePatchMission = vi.fn().mockResolvedValue(mission);
    const importPatchResult = vi.fn().mockResolvedValue(imported);
    const acceptPatchPlan = vi.fn().mockResolvedValue(accepted);
    const listAttention = vi.fn().mockResolvedValue(attention);
    getService.mockResolvedValue({
      compilePatchMission,
      importPatchResult,
      acceptPatchPlan,
      listAttention,
    });
    const context = phaseUpdateContext(sourceId, workItemId);

    const compiledResponse = await compilePortfolioPatchMission(
      missionRequest(),
      context,
    );
    const importedResponse = await importPortfolioPatchMission(
      missionActionRequest("import"),
      context,
    );
    const acceptedResponse = await acceptPortfolioPatchPlan(
      missionActionRequest("retry"),
      context,
    );
    const attentionResponse = await getPortfolioAttention();

    expect(compiledResponse.status).toBe(200);
    expect(await compiledResponse.json()).toEqual(mission);
    expect(importedResponse.status).toBe(200);
    expect(await importedResponse.json()).toEqual(imported);
    expect(acceptedResponse.status).toBe(200);
    expect(await acceptedResponse.json()).toEqual(accepted);
    expect(attentionResponse.status).toBe(200);
    expect(await attentionResponse.json()).toEqual({ items: attention });
    expect(compilePatchMission).toHaveBeenCalledWith(sourceId, workItemId);
    expect(importPatchResult).toHaveBeenCalledWith(sourceId, workItemId);
    expect(acceptPatchPlan).toHaveBeenCalledWith(sourceId, workItemId);
    expect(listAttention).toHaveBeenCalledOnce();
    expect(Object.keys(portfolioPatchMissionRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(Object.keys(portfolioPatchMissionImportRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(Object.keys(portfolioPatchPlanRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(Object.keys(portfolioAttentionRoute).sort()).toEqual([
      "GET",
      "runtime",
    ]);
    expect(portfolioPatchMissionRoute.runtime).toBe("nodejs");
    expect(portfolioPatchMissionImportRoute.runtime).toBe("nodejs");
    expect(portfolioPatchPlanRoute.runtime).toBe("nodejs");
    expect(portfolioAttentionRoute.runtime).toBe("nodejs");
  });

  it("exposes source-qualified connected summaries and exact permission decisions", async () => {
    const sourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const connectedRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
    const summary = {
      schema_version: 1,
      connected_run_id: connectedRunId,
      mission: {
        identity: {
          phase: "execute",
          work_item_id: workItemId,
          goal_version: 1,
          input_revision: 1,
          attempt: 0,
        },
        content_sha256: "a".repeat(64),
        source_commit: "b".repeat(40),
      },
      governed_tuple: {
        goal_version: 1,
        input_revision: 1,
        attempt: 0,
        patch_cycle: 0,
      },
      lifecycle: {
        status: "running",
        started_at: "2026-07-26T18:00:00.000Z",
        updated_at: "2026-07-26T18:00:01.000Z",
        completed_at: null,
        terminal_outcome: null,
        partial: false,
      },
    };
    const launchConnectedExecute = vi.fn().mockResolvedValue({
      source_id: sourceId,
      work_item: { state: { phase: "execute", status: "active" } },
      connected_run: summary,
      raw_runtime_token: "must-not-cross-http",
    });
    const listConnectedRuns = vi.fn().mockResolvedValue([summary]);
    const cancelConnectedRun = vi.fn().mockResolvedValue({
      source_id: sourceId,
      work_item: { state: { phase: "execute", status: "active" } },
      connected_run: summary,
      process: { pid: 9999 },
    });
    const decideConnectedPermission = vi.fn().mockResolvedValue({
      source_id: sourceId,
      work_item: { state: { phase: "execute", status: "active", attempt: 1 } },
      controller_run: { phase: "execute", outcome: "applied", attempt: 1 },
    });
    getService.mockResolvedValue({
      launchConnectedExecute,
      listConnectedRuns,
      cancelConnectedRun,
      decideConnectedPermission,
    });
    const context = phaseUpdateContext(sourceId, workItemId);
    const operationSha256 = "c".repeat(64);

    const launched = await launchPortfolioConnectedMission(
      connectedRequest("launch", { model_override: "one-run-model" }),
      context,
    );
    const replay = await launchPortfolioConnectedMission(
      connectedRequest("launch", { model_override: "one-run-model" }),
      context,
    );
    const listed = await getPortfolioConnectedRuns(connectedRunRequest(), context);
    const cancelled = await cancelPortfolioConnectedRun(
      connectedRequest("cancel", { connected_run_id: connectedRunId }),
      context,
    );
    const decided = await decidePortfolioConnectedPermission(
      connectedRequest("permission", {
        connected_run_id: connectedRunId,
        operation_sha256: operationSha256,
        decision: "allow_once",
      }),
      context,
    );

    expect(launched.status).toBe(200);
    expect(await launched.json()).toEqual(summary);
    expect(await replay.json()).toEqual(summary);
    expect(await listed.json()).toEqual([summary]);
    expect(await cancelled.json()).toEqual(summary);
    expect(await decided.json()).toEqual({
      source_id: sourceId,
      work_item: { state: { phase: "execute", status: "active", attempt: 1 } },
      controller_run: { phase: "execute", outcome: "applied", attempt: 1 },
    });
    expect(launchConnectedExecute).toHaveBeenCalledTimes(2);
    expect(launchConnectedExecute).toHaveBeenCalledWith(sourceId, workItemId, {
      model_override: "one-run-model",
    });
    expect(listConnectedRuns).toHaveBeenCalledWith(sourceId, workItemId);
    expect(cancelConnectedRun).toHaveBeenCalledWith(
      sourceId,
      workItemId,
      connectedRunId,
    );
    expect(decideConnectedPermission).toHaveBeenCalledWith(sourceId, workItemId, {
      connected_run_id: connectedRunId,
      operation_sha256: operationSha256,
      decision: "allow_once",
    });
    expect(Object.keys(portfolioConnectedLaunchRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(Object.keys(portfolioConnectedRunRoute).sort()).toEqual([
      "GET",
      "runtime",
    ]);
    expect(Object.keys(portfolioConnectedCancelRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(Object.keys(portfolioConnectedPermissionRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(portfolioConnectedLaunchRoute.runtime).toBe("nodejs");
    expect(portfolioConnectedRunRoute.runtime).toBe("nodejs");
    expect(portfolioConnectedCancelRoute.runtime).toBe("nodejs");
    expect(portfolioConnectedPermissionRoute.runtime).toBe("nodejs");
  });

  it("rejects malformed, oversized, and foreign connected-route payloads", async () => {
    const sourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const connectedRunId = "018f1f72-6d7f-7c38-a2d2-c45f3a3dc7b1";
    const launchConnectedExecute = vi.fn();
    const cancelConnectedRun = vi.fn();
    const decideConnectedPermission = vi.fn();
    getService.mockResolvedValue({
      launchConnectedExecute,
      cancelConnectedRun,
      decideConnectedPermission,
    });
    const context = phaseUpdateContext(sourceId, workItemId);

    const responses = await Promise.all([
      launchPortfolioConnectedMission(
        connectedRequest("launch", { capability_envelope: {} }),
        context,
      ),
      launchPortfolioConnectedMission(
        connectedRequest("launch", { model_override: "x".repeat(5_000) }),
        context,
      ),
      cancelPortfolioConnectedRun(
        connectedRequest("cancel", {
          connected_run_id: connectedRunId,
          pid: 1234,
        }),
        context,
      ),
      decidePortfolioConnectedPermission(
        connectedRequest("permission", {
          connected_run_id: connectedRunId,
          operation_sha256: "d".repeat(64),
          decision: "keep_denied",
          authorization: "must-not-cross-http",
        }),
        context,
      ),
      launchPortfolioConnectedMission(
        new Request("http://localhost/connected/launch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{invalid",
        }),
        context,
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400, 400, 400]);
    for (const response of responses) {
      expect(await response.json()).toEqual({
        error: { code: "invalid_request", message: "Invalid request" },
      });
    }
    expect(launchConnectedExecute).not.toHaveBeenCalled();
    expect(cancelConnectedRun).not.toHaveBeenCalled();
    expect(decideConnectedPermission).not.toHaveBeenCalled();
  });

  it("routes the complete static shaping matrix through one source-qualified service call", async () => {
    const sourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const context = phaseUpdateContext(sourceId, workItemId);

    for (const route of SHAPING_POST_CASES) {
      getService.mockReset();
      const payload = { route: route.name };
      const action = vi.fn().mockResolvedValue(payload);
      getService.mockResolvedValue({ [route.serviceMethod]: action });

      const response = await route.handler(
        guardedWorkItemPostRequest(route.relativePath, route.body),
        context,
      );

      expect(response.status, route.name).toBe(200);
      expect(await response.json()).toEqual(payload);
      expect(action).toHaveBeenCalledOnce();
      expect(action).toHaveBeenCalledWith(
        ...route.expectedArgs(sourceId, workItemId),
      );
    }

    for (const route of SHAPING_GET_CASES) {
      getService.mockReset();
      const payload = { route: route.name };
      const action = vi.fn().mockResolvedValue(payload);
      getService.mockResolvedValue({ [route.serviceMethod]: action });

      const response = await route.handler(shapingGetRequest(route.path), context);

      expect(response.status, route.name).toBe(200);
      expect(await response.json()).toEqual(payload);
      expect(action).toHaveBeenCalledWith(
        ...route.expectedArgs(sourceId, workItemId),
      );
    }
  });

  it("rejects every shaping POST before body or state access when origin trust fails", async () => {
    const context = phaseUpdateContext("source", "item");

    for (const route of SHAPING_POST_CASES) {
      const variants = [
        {
          request: () =>
            guardedWorkItemPostRequest(route.relativePath, "{malformed", {
              origin: null,
              raw_body: true,
            }),
        },
        {
          request: () =>
            guardedWorkItemPostRequest(route.relativePath, route.body, {
              origin: "http://127.0.0.1:4000",
            }),
        },
        {
          request: () =>
            guardedWorkItemPostRequest(route.relativePath, route.body, {
              host: "127.0.0.1:4000",
            }),
        },
        {
          configurationError:
            "PRODUCT_STUDIO_APP_ORIGIN must be configured as exactly one loopback origin.",
          request: () =>
            guardedWorkItemPostRequest(route.relativePath, route.body),
        },
        {
          configurationError:
            "PRODUCT_STUDIO_APP_ORIGIN must be configured as a loopback origin.",
          request: () =>
            guardedWorkItemPostRequest(route.relativePath, route.body),
        },
      ];

      for (const variant of variants) {
        getService.mockReset();
        getTrustedOriginConfig.mockReset();
        if (variant.configurationError === undefined) {
          getTrustedOriginConfig.mockReturnValue({
            origin: "http://127.0.0.1:3000",
            host: "127.0.0.1:3000",
          });
        } else {
          getTrustedOriginConfig.mockImplementation(() => {
            throw new UntrustedRequestOriginError(variant.configurationError!);
          });
        }

        const response = await route.handler(variant.request(), context);

        expect(response.status, route.name).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: "untrusted_request_origin" },
        });
        expect(getService).not.toHaveBeenCalled();
      }
    }
  });

  it("does not pull a shaping request body before rejecting its origin", async () => {
    const context = phaseUpdateContext("source", "item");

    for (const route of SHAPING_POST_CASES) {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            pulls += 1;
            throw new Error("untrusted request body must not be read");
          },
        },
        { highWaterMark: 0 },
      );
      const request = new Request(
        `http://localhost/api/portfolio/work-items/source/item/${route.relativePath}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            host: "127.0.0.1:3000",
          },
          body,
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      );

      getService.mockReset();
      const response = await route.handler(request, context);

      expect(response.status, route.name).toBe(403);
      expect(pulls, route.name).toBe(0);
      expect(getService).not.toHaveBeenCalled();
    }
  });

  it("rejects oversized, malformed, and foreign shaping bodies before service construction", async () => {
    const context = phaseUpdateContext("source", "item");
    const forbiddenFields = [
      "capability_envelope",
      "narrowed_capability_envelope",
      "ingress_path",
      "output_path",
      "result",
      "executable",
      "phase",
    ];
    const invalidRequestBody = {
      error: { code: "invalid_request", message: "Invalid request" },
    };

    getTrustedOriginConfig.mockReturnValue({
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
    });
    for (const route of SHAPING_POST_CASES) {
      for (const field of forbiddenFields) {
        getService.mockReset();
        const response = await route.handler(
          guardedWorkItemPostRequest(route.relativePath, {
            ...route.body,
            [field]: field === "result" ? { raw: true } : "forbidden",
          }),
          context,
        );
        expect(response.status, `${route.name}: ${field}`).toBe(400);
        expect(await response.json()).toEqual(invalidRequestBody);
        expect(getService).not.toHaveBeenCalled();
      }

      getService.mockReset();
      const oversized = await route.handler(
        guardedWorkItemPostRequest(
          route.relativePath,
          `${JSON.stringify(route.body)}${" ".repeat(
            SHAPING_REQUEST_MAX_BYTES + 1,
          )}`,
          { raw_body: true },
        ),
        context,
      );
      expect(oversized.status, `${route.name}: oversized`).toBe(400);
      expect(await oversized.json()).toEqual(invalidRequestBody);
      expect(getService).not.toHaveBeenCalled();

      getService.mockReset();
      const malformed = await route.handler(
        guardedWorkItemPostRequest(route.relativePath, "{malformed", {
          raw_body: true,
        }),
        context,
      );
      expect(malformed.status, `${route.name}: malformed`).toBe(400);
      expect(await malformed.json()).toEqual(invalidRequestBody);
      expect(getService).not.toHaveBeenCalled();
    }
  });

  it("keeps retry-launch and retained-lease repair bodies exact", async () => {
    const context = phaseUpdateContext("source", "item");
    const invalidRequestBody = {
      error: { code: "invalid_request", message: "Invalid request" },
    };
    const retryRoutes = SHAPING_POST_CASES.filter(
      (route) => route.serviceMethod === "retryShapingLaunch",
    );
    expect(retryRoutes).toHaveLength(3);
    for (const route of retryRoutes) {
      for (const extra of [
        { requested_model: "must-come-from-intent" },
        { launch_mode: "connected" },
      ]) {
        getService.mockReset();
        const response = await route.handler(
          guardedWorkItemPostRequest(route.relativePath, {
            ...route.body,
            ...extra,
          }),
          context,
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual(invalidRequestBody);
        expect(getService).not.toHaveBeenCalled();
      }
    }

    const repair = SHAPING_POST_CASES.find(
      (route) => route.serviceMethod === "repairRetainedControllerLease",
    )!;
    getService.mockReset();
    const repairWithExtra = await repair.handler(
      guardedWorkItemPostRequest(repair.relativePath, {
        ...repair.body,
        launch_mode: "manual",
      }),
      context,
    );
    expect(repairWithExtra.status).toBe(400);
    expect(await repairWithExtra.json()).toEqual(invalidRequestBody);
    expect(getService).not.toHaveBeenCalled();
  });

  it("enforces connected-versus-manual model presence on every decision route", async () => {
    const context = phaseUpdateContext("source", "item");
    const decisionRoutes = SHAPING_POST_CASES.filter((route) =>
      [
        "startBrainstorm",
        "useBrainstormResult",
        "approveSpecResult",
        "requestShapingChanges",
        "replanWithUpdatedContract",
      ].includes(route.serviceMethod),
    );

    for (const route of decisionRoutes) {
      const action = vi.fn().mockResolvedValue({ ok: true });
      getService.mockReset();
      getService.mockResolvedValue({ [route.serviceMethod]: action });
      const withoutModel = { ...route.body };
      delete withoutModel.requested_model;
      const manualBody = { ...withoutModel, launch_mode: "manual" };

      const responses = await Promise.all([
        route.handler(
          guardedWorkItemPostRequest(route.relativePath, route.body),
          context,
        ),
        route.handler(
          guardedWorkItemPostRequest(route.relativePath, manualBody),
          context,
        ),
        route.handler(
          guardedWorkItemPostRequest(route.relativePath, {
            ...route.body,
            launch_mode: "manual",
          }),
          context,
        ),
        route.handler(
          guardedWorkItemPostRequest(route.relativePath, withoutModel),
          context,
        ),
      ]);

      expect(responses.map(({ status }) => status), route.name).toEqual([
        200, 200, 400, 400,
      ]);
      expect(action).toHaveBeenCalledTimes(2);
      expect(action.mock.calls[1]?.[2]).toMatchObject({
        launch_mode: "manual",
        next_requested_model: null,
      });
    }
  });

  it("encodes action-specific binding nullability in route-local schemas", async () => {
    const context = phaseUpdateContext("source", "item");
    const start = SHAPING_POST_CASES.find(
      (route) => route.serviceMethod === "startBrainstorm",
    )!;
    const useResult = SHAPING_POST_CASES.find(
      (route) => route.serviceMethod === "useBrainstormResult",
    )!;
    const approve = SHAPING_POST_CASES.find(
      (route) => route.serviceMethod === "approveSpecResult",
    )!;
    const replan = SHAPING_POST_CASES.find(
      (route) => route.serviceMethod === "replanWithUpdatedContract",
    )!;
    const requestChanges = SHAPING_POST_CASES.find(
      (route) => route.serviceMethod === "requestShapingChanges",
    )!;
    const invalidCases = [
      [start, { ...start.body, expected_mission_content_sha256: SHA_A }],
      [start, { ...start.body, expected_result_content_sha256: SHA_B }],
      [useResult, { ...useResult.body, expected_mission_content_sha256: null }],
      [useResult, { ...useResult.body, expected_result_content_sha256: null }],
      [approve, { ...approve.body, goal_contract_sha256: undefined }],
      [replan, { ...replan.body, goal_contract_sha256: undefined }],
      [useResult, { ...useResult.body, goal_contract_sha256: SHA_C }],
      [requestChanges, { ...requestChanges.body, goal_contract_sha256: SHA_C }],
    ] as const;

    for (const [route, body] of invalidCases) {
      getService.mockReset();
      const response = await route.handler(
        guardedWorkItemPostRequest(route.relativePath, body),
        context,
      );
      expect(response.status, route.name).toBe(400);
      expect(getService).not.toHaveBeenCalled();
    }
  });

  it("maps every shaping controller conflict and retained-lease mismatch to 409", async () => {
    const context = phaseUpdateContext("source", "item");
    const route = SHAPING_POST_CASES.find(
      (candidate) => candidate.serviceMethod === "startBrainstorm",
    )!;
    for (const kind of [
      "stale_expectation",
      "mission_not_ready",
      "idempotency_conflict",
      "lease_held",
      "repair_required",
    ] as const) {
      getService.mockReset();
      getService.mockResolvedValue({
        startBrainstorm: vi.fn().mockRejectedValue(
          new ControllerConflictError(kind, "item", `${kind} from shaping`),
        ),
      });
      const response = await route.handler(
        guardedWorkItemPostRequest(route.relativePath, route.body),
        context,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { code: kind, message: `${kind} from shaping` },
      });
    }

    const repair = SHAPING_POST_CASES.find(
      (candidate) => candidate.serviceMethod === "repairRetainedControllerLease",
    )!;
    getService.mockReset();
    getService.mockResolvedValue({
      repairRetainedControllerLease: vi.fn().mockRejectedValue(
        new ControllerConflictError(
          "stale_expectation",
          "item",
          "Acknowledged run does not match the retained run.",
        ),
      ),
    });
    const mismatch = await repair.handler(
      guardedWorkItemPostRequest(repair.relativePath, repair.body),
      context,
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      error: { code: "stale_expectation" },
    });
  });

  it("keeps shaping GETs available without trusted-origin configuration", async () => {
    const context = phaseUpdateContext("source", "item");
    getTrustedOriginConfig.mockImplementation(() => {
      throw new UntrustedRequestOriginError("configuration unavailable");
    });
    for (const route of SHAPING_GET_CASES) {
      getService.mockReset();
      const action = vi.fn().mockResolvedValue({ route: route.name });
      getService.mockResolvedValue({ [route.serviceMethod]: action });
      const response = await route.handler(shapingGetRequest(route.path), context);
      expect(response.status, route.name).toBe(200);
      expect(action).toHaveBeenCalledOnce();
      expect(getTrustedOriginConfig).not.toHaveBeenCalled();
    }
  });

  it("mounts only the allowed static shaping action topology", () => {
    const routeRoot = join(
      process.cwd(),
      "app/api/portfolio/work-items/[sourceId]/[workItemId]",
    );
    const present = [
      "shaping/brainstorm/retry-launch/route.ts",
      "shaping/spec/retry-launch/route.ts",
      "shaping/plan/retry-launch/route.ts",
      "shaping/brainstorm/connected/launch/route.ts",
      "shaping/brainstorm/connected/run/route.ts",
      "shaping/brainstorm/connected/cancel/route.ts",
      "shaping/spec/connected/launch/route.ts",
      "shaping/spec/connected/run/route.ts",
      "shaping/spec/connected/cancel/route.ts",
      "shaping/plan/connected/launch/route.ts",
      "shaping/plan/connected/run/route.ts",
      "shaping/plan/connected/cancel/route.ts",
      "shaping/brainstorm/use-result/route.ts",
      "shaping/spec/approve/route.ts",
      "shaping/plan/replan/route.ts",
      "shaping/models/route.ts",
      "repair-controller-lease/route.ts",
    ];
    const absent = [
      "shaping/[phase]",
      "shaping/brainstorm/accept/route.ts",
      "shaping/brainstorm/approve/route.ts",
      "shaping/plan/approve/route.ts",
      "shaping/spec/use-result/route.ts",
      "shaping/plan/use-result/route.ts",
      "shaping/brainstorm/replan/route.ts",
      "shaping/spec/replan/route.ts",
      "shaping/permission/route.ts",
      "shaping/brainstorm/permission/route.ts",
      "shaping/spec/permission/route.ts",
      "shaping/plan/permission/route.ts",
      "shaping/brainstorm/connected/permission/route.ts",
      "shaping/spec/connected/permission/route.ts",
      "shaping/plan/connected/permission/route.ts",
    ];
    expect(present.every((path) => existsSync(join(routeRoot, path)))).toBe(true);
    expect(absent.every((path) => !existsSync(join(routeRoot, path)))).toBe(true);
    const postModules = [
      brainstormConnectedLaunchRoute,
      brainstormConnectedCancelRoute,
      portfolioBrainstormMissionRoute,
      brainstormManualIngressRoute,
      portfolioBrainstormImportRoute,
      brainstormRequestChangesRoute,
      brainstormRetryLaunchRoute,
      brainstormUseResultRoute,
      specConnectedLaunchRoute,
      specConnectedCancelRoute,
      portfolioSpecMissionRoute,
      specManualIngressRoute,
      portfolioSpecImportRoute,
      specRequestChangesRoute,
      specRetryLaunchRoute,
      specApproveRoute,
      planConnectedLaunchRoute,
      planConnectedCancelRoute,
      planMissionRoute,
      planManualIngressRoute,
      planImportRoute,
      planRequestChangesRoute,
      planRetryLaunchRoute,
      planReplanRoute,
      startBrainstormRoute,
      repairControllerLeaseRoute,
    ];
    const getModules = [
      brainstormConnectedRunRoute,
      specConnectedRunRoute,
      planConnectedRunRoute,
      shapingModelsRoute,
    ];
    expect(postModules).toHaveLength(26);
    expect(getModules).toHaveLength(4);
    for (const routeModule of postModules) {
      expect(Object.keys(routeModule).sort()).toEqual(["POST", "runtime"]);
      expect(routeModule.runtime).toBe("nodejs");
    }
    for (const routeModule of getModules) {
      expect(Object.keys(routeModule).sort()).toEqual(["GET", "runtime"]);
      expect(routeModule.runtime).toBe("nodejs");
    }
  });

  it("maps patch and attention conflicts through the established response contract", async () => {
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const conflict = () =>
      new ControllerConflictError(
        "mission_not_ready",
        workItemId,
        "The governed patch operation is not ready.",
      );
    const compilePatchMission = vi.fn().mockRejectedValue(conflict());
    const importPatchResult = vi.fn().mockRejectedValue(conflict());
    const acceptPatchPlan = vi.fn().mockRejectedValue(conflict());
    const listAttention = vi.fn().mockRejectedValue(conflict());
    getService.mockResolvedValue({
      compilePatchMission,
      importPatchResult,
      acceptPatchPlan,
      listAttention,
    });
    const context = phaseUpdateContext("inbox", workItemId);

    const responses = await Promise.all([
      compilePortfolioPatchMission(missionRequest(), context),
      importPortfolioPatchMission(missionActionRequest("import"), context),
      acceptPortfolioPatchPlan(missionActionRequest("retry"), context),
      getPortfolioAttention(),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([409, 409, 409, 409]);
    for (const response of responses) {
      expect(await response.json()).toEqual({
        error: {
          code: "mission_not_ready",
          message: "The governed patch operation is not ready.",
        },
      });
    }
  });

  it("maps mission compile failures through the established response contract", async () => {
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const compileMission = vi
      .fn()
      .mockRejectedValueOnce(
        new UnknownPortfolioSourceError(
          "ws_00000000-0000-4000-8000-000000000000",
        ),
      )
      .mockRejectedValueOnce(
        new PortfolioWorkItemNotFoundError("inbox", workItemId),
      )
      .mockRejectedValueOnce(
        new ControllerConflictError(
          "mission_not_ready",
          workItemId,
          "No applied execute manifest matches the governed tuple.",
        ),
      )
      .mockRejectedValueOnce(
        new InvalidWorkspaceError(
          `.founder/work-items/${workItemId}/runs/bad.json`,
          "invalid JSON",
        ),
      )
      .mockRejectedValueOnce(new Error("injected failure"));
    getService.mockResolvedValue({ compileMission });
    const context = phaseUpdateContext("inbox", workItemId);

    const responses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      responses.push(await compilePortfolioMission(missionRequest(), context));
    }

    expect(responses.map(({ status }) => status)).toEqual([
      404, 404, 409, 422, 500,
    ]);
    expect(await responses[0].json()).toMatchObject({
      error: { code: "unknown_source" },
    });
    expect(await responses[1].json()).toMatchObject({
      error: { code: "work_item_not_found" },
    });
    expect(await responses[2].json()).toEqual({
      error: {
        code: "mission_not_ready",
        message: "No applied execute manifest matches the governed tuple.",
      },
    });
    expect(await responses[3].json()).toMatchObject({
      error: { code: "invalid_workspace" },
    });
    expect(await responses[4].json()).toEqual({
      error: { code: "internal_error", message: "Unexpected server error" },
    });
  });

  it("returns run evidence and maps missing or invalid durable history", async () => {
    const sourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const history: StoredImportEvidence[] = [
      {
        evidence: {
          schema_version: 2,
          phase: "execute",
          import_run_id: "f".repeat(64),
          result_content_sha256: "c".repeat(64),
          mission_content_sha256: "d".repeat(64),
          identity: {
            phase: "execute",
            work_item_id: workItemId,
            goal_version: 1,
            input_revision: 2,
            attempt: 1,
          },
          git_base_commit: "a".repeat(40),
          result_commit: null,
          controller_run_id: "550e8400-e29b-41d4-a716-446655440000",
          started_at: "2026-07-22T14:00:00.000Z",
          completed_at: "2026-07-22T14:00:01.000Z",
          outcome: "rejected",
          reasons: ["Rejected imported result."],
        },
        summary: {
          phase: "execute",
          import_run_id: "f".repeat(64),
          outcome: "rejected",
          evidence_path: `.founder/run-evidence/${workItemId}/execute-1-2-1/${"f".repeat(64)}`,
          reasons: ["Rejected imported result."],
        },
        verification: [],
      },
      {
        evidence: {
          schema_version: 2,
          phase: "review",
          import_run_id: "e".repeat(64),
          result_content_sha256: "b".repeat(64),
          mission_content_sha256: "a".repeat(64),
          identity: {
            phase: "review",
            work_item_id: workItemId,
            goal_version: 1,
            input_revision: 2,
            attempt: 1,
          },
          git_base_commit: "a".repeat(40),
          result_commit: "a".repeat(40),
          controller_run_id: "650e8400-e29b-41d4-a716-446655440000",
          started_at: "2026-07-22T15:00:00.000Z",
          completed_at: "2026-07-22T15:00:01.000Z",
          outcome: "applied",
          reasons: [],
        },
        summary: {
          phase: "review",
          import_run_id: "e".repeat(64),
          outcome: "applied",
          evidence_path: `.founder/run-evidence/${workItemId}/review-1-2-1/${"e".repeat(64)}`,
          reasons: [],
        },
        verification: [],
        submission: {
          result_schema_version: 2,
          review_mission_content_sha256: "a".repeat(64),
          identity: {
            phase: "review",
            work_item_id: workItemId,
            goal_version: 1,
            input_revision: 2,
            attempt: 1,
          },
          execute_mission_content_sha256: "d".repeat(64),
          execute_result_content_sha256: "c".repeat(64),
          git_base_commit: "a".repeat(40),
          accepted_result_commit: "a".repeat(40),
          summary: "No findings.",
          verdict: "clean",
          findings: [],
        },
      },
    ];
    const listImportEvidence = vi
      .fn()
      .mockResolvedValueOnce(history)
      .mockRejectedValueOnce(
        new PortfolioWorkItemNotFoundError(sourceId, workItemId),
      )
      .mockRejectedValueOnce(
        new InvalidWorkspaceError(
          `.founder/run-evidence/${workItemId}/bad-run`,
          "invalid durable evidence",
        ),
      );
    getService.mockResolvedValue({ listImportEvidence });
    const context = phaseUpdateContext(sourceId, workItemId);

    const success = await getPortfolioRunEvidence(
      runEvidenceRequest(),
      context,
    );
    const missing = await getPortfolioRunEvidence(
      runEvidenceRequest(),
      context,
    );
    const invalid = await getPortfolioRunEvidence(
      runEvidenceRequest(),
      context,
    );

    expect(success.status).toBe(200);
    const successBody = (await success.json()) as StoredImportEvidence[];
    expect(successBody).toEqual(history);
    expect(successBody.map((stored) => stored.evidence.phase)).toEqual([
      "execute",
      "review",
    ]);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "work_item_not_found" },
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      error: { code: "invalid_workspace" },
    });
    expect(listImportEvidence).toHaveBeenCalledTimes(3);
    expect(listImportEvidence).toHaveBeenCalledWith(sourceId, workItemId);
  });

  it("returns bodyless import verdicts and explicit retry results with source qualification", async () => {
    const sourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const applied = {
      source_id: sourceId,
      project: null,
      work_item: { state: { phase: "review", status: "active" } },
      evidence: {
        import_run_id: "a".repeat(64),
        outcome: "applied",
        evidence_path: `.founder/run-evidence/${workItemId}/execute-1-1-0/${"a".repeat(64)}`,
        reasons: [],
      },
    };
    const rejected = {
      ...applied,
      work_item: { state: { phase: "execute", status: "blocked" } },
      evidence: {
        ...applied.evidence,
        outcome: "rejected",
        reasons: ["result.json is not valid JSON."],
      },
    };
    const retried = {
      source_id: sourceId,
      project: null,
      work_item: { state: { phase: "execute", status: "active", attempt: 1 } },
      controller_run: { phase: "execute", outcome: "applied", attempt: 1 },
    };
    const importResult = vi
      .fn()
      .mockResolvedValueOnce(applied)
      .mockResolvedValueOnce(rejected);
    const retryExecuteAttempt = vi.fn().mockResolvedValue(retried);
    getService.mockResolvedValue({ importResult, retryExecuteAttempt });
    const context = phaseUpdateContext(sourceId, workItemId);

    const appliedResponse = await importPortfolioMission(
      missionActionRequest("import"),
      context,
    );
    const rejectedResponse = await importPortfolioMission(
      missionActionRequest("import"),
      context,
    );
    const retryResponse = await retryPortfolioMission(
      missionActionRequest("retry"),
      context,
    );

    expect(appliedResponse.status).toBe(200);
    expect(await appliedResponse.json()).toEqual(applied);
    expect(rejectedResponse.status).toBe(200);
    expect(await rejectedResponse.json()).toEqual(rejected);
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toEqual(retried);
    expect(importResult).toHaveBeenNthCalledWith(1, sourceId, workItemId);
    expect(importResult).toHaveBeenNthCalledWith(2, sourceId, workItemId);
    expect(retryExecuteAttempt).toHaveBeenCalledWith(sourceId, workItemId);
    expect(Object.keys(portfolioMissionRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(Object.keys(portfolioMissionImportRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(Object.keys(portfolioMissionRetryRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(Object.keys(portfolioReviewMissionRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
    expect(Object.keys(portfolioReviewMissionImportRoute).sort()).toEqual([
      "POST",
      "runtime",
    ]);
  });

  it("maps import and retry eligibility failures to 409 instead of verdict responses", async () => {
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const importResult = vi.fn().mockRejectedValue(
      new ControllerConflictError(
        "mission_not_ready",
        workItemId,
        "Result import requires an assigned, governed item in active execute.",
      ),
    );
    const retryExecuteAttempt = vi.fn().mockRejectedValue(
      new ControllerConflictError(
        "mission_not_ready",
        workItemId,
        "Repair requires an assigned, governed item in blocked execute.",
      ),
    );
    const compileReviewMission = vi.fn().mockRejectedValue(
      new ControllerConflictError(
        "mission_not_ready",
        workItemId,
        "Review mission compilation requires active review.",
      ),
    );
    const importReviewResult = vi.fn().mockRejectedValue(
      new InvalidWorkspaceError(
        `.founder/missions/${workItemId}/review-1-1-0/result.json`,
        "invalid review result",
      ),
    );
    getService.mockResolvedValue({
      importResult,
      retryExecuteAttempt,
      compileReviewMission,
      importReviewResult,
    });
    const context = phaseUpdateContext("inbox", workItemId);

    const importResponse = await importPortfolioMission(
      missionActionRequest("import"),
      context,
    );
    const retryResponse = await retryPortfolioMission(
      missionActionRequest("retry"),
      context,
    );
    const reviewCompileResponse = await compilePortfolioReviewMission(
      reviewMissionRequest({ independence_attested: true }),
      context,
    );
    const reviewImportResponse = await importPortfolioReviewMission(
      reviewMissionImportRequest(),
      context,
    );

    expect(importResponse.status).toBe(409);
    expect(await importResponse.json()).toMatchObject({
      error: { code: "mission_not_ready" },
    });
    expect(retryResponse.status).toBe(409);
    expect(await retryResponse.json()).toMatchObject({
      error: { code: "mission_not_ready" },
    });
    expect(reviewCompileResponse.status).toBe(409);
    expect(await reviewCompileResponse.json()).toMatchObject({
      error: { code: "mission_not_ready" },
    });
    expect(reviewImportResponse.status).toBe(422);
    expect(await reviewImportResponse.json()).toMatchObject({
      error: { code: "invalid_workspace" },
    });
  });

  it("returns 400 for invalid capture and unified-save bodies", async () => {
    await createService();

    const captureResponse = await createPortfolioWorkItem(
      captureRequest({ title: "Missing kind" }),
    );
    const saveResponse = await savePortfolioWorkItem(
      saveWorkItemRequest({ acceptance_criteria: ["Missing required fields"] }),
      phaseUpdateContext("inbox", "wi_123e4567-e89b-12d3-a456-426614174000"),
    );

    expect(captureResponse.status).toBe(400);
    expect(await captureResponse.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expect(saveResponse.status).toBe(400);
    expect(await saveResponse.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("returns 404 for unknown sources and missing items on the unified route", async () => {
    await createService();
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const input = {
      target_source_id: "inbox",
      title: "Still missing",
      type: null,
      priority: null,
      tags: [],
      notes: null,
    };

    const unknownResponse = await savePortfolioWorkItem(
      saveWorkItemRequest(input),
      phaseUpdateContext(
        "ws_00000000-0000-4000-8000-000000000000",
        workItemId,
      ),
    );
    const missingResponse = await savePortfolioWorkItem(
      saveWorkItemRequest(input),
      phaseUpdateContext("inbox", workItemId),
    );

    expect(unknownResponse.status).toBe(404);
    expect(await unknownResponse.json()).toMatchObject({
      error: { code: "unknown_source" },
    });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      error: { code: "work_item_not_found" },
    });
  });

  it("maps locked unified saves to the established 409 response", async () => {
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const saveWorkItem = vi.fn().mockRejectedValue(
      new ControllerConflictError(
        "goal_contract_locked",
        workItemId,
        "Goal contracts are locked after entering execute.",
      ),
    );
    getService.mockResolvedValue({ saveWorkItem });

    const response = await savePortfolioWorkItem(
      saveWorkItemRequest({
        target_source_id: "inbox",
        title: "Locked work item",
        type: null,
        priority: null,
        tags: [],
        notes: null,
        goal_contract: {
          purpose: "Prove lock behavior.",
          acceptance_criteria: ["Valid"],
          non_goals: ["Do not change phases."],
          allowed_scope: ["src"],
          review_ready: ["Tests pass"],
        },
      }),
      phaseUpdateContext("inbox", workItemId),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "goal_contract_locked" },
    });
  });

  it("maps transfer collisions and incomplete transfers to 409, never 500", async () => {
    const workItemId = "wi_123e4567-e89b-12d3-a456-426614174000";
    const targetSourceId = "ws_550e8400-e29b-41d4-a716-446655440000";
    const saveWorkItem = vi
      .fn()
      .mockRejectedValueOnce(
        new WorkItemTargetCollisionError(
          "inbox",
          workItemId,
          targetSourceId,
        ),
      )
      .mockRejectedValueOnce(
        new WorkItemTransferFailedError(
          "inbox",
          workItemId,
          targetSourceId,
          "source removal denied",
        ),
      );
    getService.mockResolvedValue({ saveWorkItem });

    const input = {
      target_source_id: targetSourceId,
      title: "Transfer through unified save",
      type: null,
      priority: null,
      tags: [],
      notes: null,
    };
    const collisionResponse = await savePortfolioWorkItem(
      saveWorkItemRequest(input),
      phaseUpdateContext("inbox", workItemId),
    );
    const failedResponse = await savePortfolioWorkItem(
      saveWorkItemRequest(input),
      phaseUpdateContext("inbox", workItemId),
    );

    expect(collisionResponse.status).toBe(409);
    expect(await collisionResponse.json()).toMatchObject({
      error: { code: "target_collision" },
    });
    expect(failedResponse.status).toBe(409);
    expect(await failedResponse.json()).toMatchObject({
      error: { code: "transfer_failed" },
    });
  });

  it("returns 400 for a malformed phase-update body", async () => {
    await createService();

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "operate" }),
      phaseUpdateContext(
        "inbox",
        "wi_123e4567-e89b-12d3-a456-426614174000",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("returns 404 for an unknown portfolio source", async () => {
    await createService();

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "spec" }),
      phaseUpdateContext(
        "ws_00000000-0000-4000-8000-000000000000",
        "wi_123e4567-e89b-12d3-a456-426614174000",
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "unknown_source",
        message: "Portfolio source not found",
      },
    });
  });

  it("returns 404 for a missing source-qualified work item", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "spec" }),
      phaseUpdateContext(
        registration.workspace.workspace_id,
        "wi_123e4567-e89b-12d3-a456-426614174000",
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "work_item_not_found",
        message: "Work item not found",
      },
    });
  });

  it("returns 409 with a reason for an invalid move", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();
    const sourceId = registration.workspace.workspace_id as string;
    const workItemId = registration.rebuild.items[0].work_item.goal
      .work_item_id as string;

    const response = await updatePortfolioWorkItem(
      phaseUpdateRequest({ target_phase: "plan" }),
      phaseUpdateContext(sourceId, workItemId),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_transition",
        message: "Phase transition from idea to plan is not allowed.",
      },
    });
  });

  it("keeps a missing registration visible while rebuild reports its failure", async () => {
    await createService();
    const workspacePath = await createWorkspace();
    const registrationResponse = await registerWorkspace(
      registrationRequest(workspacePath),
    );
    const registration = await registrationResponse.json();
    await rm(workspacePath, { recursive: true, force: true });

    const rebuildResponse = await rebuildWorkItems();
    const rebuild = await rebuildResponse.json();
    const workspacesResponse = await getWorkspaces();

    expect(rebuild.items).toEqual([]);
    expect(rebuild.failures).toMatchObject([
      {
        source_id: expect.stringMatching(/^ws_/),
        project: { workspace_path: workspacePath },
        reason: expect.any(String),
      },
    ]);
    expect(await workspacesResponse.json()).toEqual({
      workspaces: [registration.workspace],
    });
  });

  it("does not expose ambiguous single-workspace route handlers", () => {
    expect("POST" in workItemsRoute).toBe(false);
    expect(
      existsSync(
        join(
          process.cwd(),
          "app",
          "api",
          "work-items",
          "[workItemId]",
          "route.ts",
        ),
      ),
    ).toBe(false);
  });

  it("returns 400 invalid_request for malformed registration input", async () => {
    await createService();

    const response = await registerWorkspace(
      registrationRequestBody({ workspace_path: "relative/workspace" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("returns 422 invalid_workspace before writing a registration", async () => {
    const { registry } = await createService();
    const workspacePath = await createRoot("product-studio-api-invalid-");
    await mkdir(join(workspacePath, ".founder"));

    const response = await registerWorkspace(
      registrationRequest(workspacePath),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_workspace",
        message: "required file is missing",
        artifact_path: ".founder/product.yaml",
      },
    });
    await expect(registry.read()).resolves.toEqual([]);
  });

  it("returns 422 invalid_registry with the durable artifact path", async () => {
    const { registry } = await createService();
    await mkdir(dirname(registry.registryPath), { recursive: true });
    await writeFile(registry.registryPath, "{invalid", "utf8");

    const response = await getWorkspaces();

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "invalid_registry",
        artifact_path: registry.registryPath,
      },
    });
    expect(body.error.message).toContain("invalid JSON");
  });

  it("returns 409 duplicate_workspace and preserves one registration", async () => {
    const { registry } = await createService();
    const workspacePath = await createWorkspace();
    await registerWorkspace(registrationRequest(workspacePath));

    const response = await registerWorkspace(
      registrationRequest(workspacePath),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "duplicate_workspace",
        message: `Workspace is already registered: ${workspacePath}`,
      },
    });
    await expect(registry.read()).resolves.toHaveLength(1);
  });
});
