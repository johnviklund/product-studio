import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { PortfolioService } from "../../src/application/portfolio";
import { WorkItemController } from "../../src/application/work-item-controller";
import type { StoredImportEvidence } from "../../src/domain/result";
import {
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
} from "../../src/domain/portfolio";
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

vi.mock("../../src/application/portfolio-service", () => ({
  getPortfolioService: getService,
}));

import * as workItemsRoute from "../../app/api/work-items/route";
import { POST as createPortfolioWorkItem } from "../../app/api/portfolio/work-items/route";
import { PATCH as savePortfolioWorkItem } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/edit/route";
import * as portfolioMissionRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/route";
import * as portfolioMissionImportRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/import/route";
import * as portfolioMissionRetryRoute from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/mission/retry/route";
import { GET as getPortfolioRunEvidence } from "../../app/api/portfolio/work-items/[sourceId]/[workItemId]/run-evidence/route";
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
const retryPortfolioMission = portfolioMissionRetryRoute.POST;

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
        expected_schema_version: 1,
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

function runEvidenceRequest(): Request {
  return new Request(
    "http://localhost/api/portfolio/work-items/source/item/run-evidence",
    { method: "GET" },
  );
}

function phaseUpdateContext(sourceId: string, workItemId: string) {
  return { params: Promise.resolve({ sourceId, workItemId }) };
}

beforeEach(() => {
  getService.mockReset();
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

  it("updates a source-qualified work item phase", async () => {
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
      phaseUpdateRequest({ target_phase: "spec" }),
      phaseUpdateContext(sourceId, workItemId),
    );
    const updated = await response.json();

    expect(response.status).toBe(200);
    expect(updated).toMatchObject({
      source_id: sourceId,
      project: { workspace_path: workspacePath },
      work_item: {
        goal: { work_item_id: workItemId },
        state: { phase: "spec", status: "active" },
      },
    });
    expect(await (await workItemsRoute.GET()).json()).toEqual({
      items: [updated],
    });
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
        "1-1-0",
        "TASK.md",
      ),
      mission_path: join(
        workspacePath,
        ".founder",
        "missions",
        workItemId,
        "1-1-0",
        "mission.json",
      ),
      mission: {
        identity: { work_item_id: workItemId },
        content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
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
          schema_version: 1,
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
          import_run_id: "f".repeat(64),
          outcome: "rejected",
          evidence_path: `.founder/run-evidence/${workItemId}/1-2-1/${"f".repeat(64)}`,
          reasons: ["Rejected imported result."],
        },
        verification: [],
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
    expect(await success.json()).toEqual(history);
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
        evidence_path: `.founder/run-evidence/${workItemId}/1-1-0/${"a".repeat(64)}`,
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
    getService.mockResolvedValue({ importResult, retryExecuteAttempt });
    const context = phaseUpdateContext("inbox", workItemId);

    const importResponse = await importPortfolioMission(
      missionActionRequest("import"),
      context,
    );
    const retryResponse = await retryPortfolioMission(
      missionActionRequest("retry"),
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
