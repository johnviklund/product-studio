import { describe, expect, it } from "vitest";

import { errorResponse } from "../../app/api/responses";
import { UntrustedRequestOriginError } from "../../src/application/request-origin";
import {
  InvalidWorkItemTransitionError,
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
} from "../../src/domain/portfolio";
import { ControllerConflictError } from "../../src/domain/work-item";
import { AcpEventLimitError } from "../../src/infrastructure/acp/acp-client";

describe("portfolio API error responses", () => {
  it("maps untrusted request origins to a stable 403", async () => {
    const response = errorResponse(
      new UntrustedRequestOriginError(
        "Request Origin and Host must exactly match PRODUCT_STUDIO_APP_ORIGIN.",
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "untrusted_request_origin",
        message:
          "Request Origin and Host must exactly match PRODUCT_STUDIO_APP_ORIGIN.",
      },
    });
  });

  it("maps unknown sources to a stable non-leaking 404", async () => {
    const response = errorResponse(
      new UnknownPortfolioSourceError("private-source-path"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "unknown_source",
        message: "Portfolio source not found",
      },
    });
  });

  it("maps missing work items to a stable non-leaking 404", async () => {
    const response = errorResponse(
      new PortfolioWorkItemNotFoundError(
        "inbox",
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

  it("maps rejected transitions to a reasoned 409", async () => {
    const reason =
      "Move from Todo to Plan is not allowed; move one column at a time.";
    const response = errorResponse(
      new InvalidWorkItemTransitionError("idea", "plan", reason),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_transition",
        message: reason,
      },
    });
  });

  it("maps controller conflicts to a reasoned 409", async () => {
    const response = errorResponse(
      new ControllerConflictError(
        "contracted_details",
        "wi_123e4567-e89b-12d3-a456-426614174000",
        "Contracted work items require a version-bound goal update.",
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "contracted_details",
        message: "Contracted work items require a version-bound goal update.",
      },
    });
  });
  it("maps an exhausted evidence budget to a legible 409 instead of an unexplained 500", async () => {
    const response = errorResponse(
      new AcpEventLimitError("Connected-run event limit reached."),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("evidence_budget_exhausted");
    expect(body.error.message).toContain("evidence budget");
    expect(body.error.message).not.toBe("Unexpected server error");
  });
});
