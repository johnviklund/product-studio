import { describe, expect, it } from "vitest";

import { errorResponse } from "../../app/api/responses";
import {
  InvalidWorkItemTransitionError,
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
} from "../../src/domain/portfolio";

describe("portfolio API error responses", () => {
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
});
