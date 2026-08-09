import { ZodError } from "zod";

import { UntrustedRequestOriginError } from "../../src/application/request-origin";
import { AcpEventLimitError } from "../../src/infrastructure/acp/acp-client";
import {
  DuplicateWorkspaceError,
  InvalidWorkItemTransitionError,
  InvalidRegistryError,
  PortfolioWorkItemNotFoundError,
  UnknownPortfolioSourceError,
} from "../../src/domain/portfolio";
import {
  ControllerConflictError,
  InvalidWorkspaceError,
  WorkItemTargetCollisionError,
  WorkItemTransferFailedError,
} from "../../src/domain/work-item";

function artifactErrorResponse(
  error: InvalidWorkspaceError | InvalidRegistryError,
): Response {
  return Response.json(
    {
      error: {
        code: error.kind,
        message: error.reason,
        artifact_path: error.artifactPath,
      },
    },
    { status: 422 },
  );
}

export function errorResponse(error: unknown): Response {
  if (
    error instanceof InvalidWorkspaceError ||
    error instanceof InvalidRegistryError
  ) {
    return artifactErrorResponse(error);
  }

  if (error instanceof DuplicateWorkspaceError) {
    return Response.json(
      {
        error: {
          code: error.kind,
          message: error.message,
        },
      },
      { status: 409 },
    );
  }

  if (error instanceof UnknownPortfolioSourceError) {
    return Response.json(
      {
        error: {
          code: error.kind,
          message: "Portfolio source not found",
        },
      },
      { status: 404 },
    );
  }

  if (error instanceof PortfolioWorkItemNotFoundError) {
    return Response.json(
      {
        error: {
          code: error.kind,
          message: "Work item not found",
        },
      },
      { status: 404 },
    );
  }

  if (error instanceof InvalidWorkItemTransitionError) {
    return Response.json(
      {
        error: {
          code: error.kind,
          message: error.reason,
        },
      },
      { status: 409 },
    );
  }

  if (error instanceof ControllerConflictError) {
    return Response.json(
      {
        error: {
          code: error.kind,
          message: error.reason,
        },
      },
      { status: 409 },
    );
  }

  if (
    error instanceof WorkItemTargetCollisionError ||
    error instanceof WorkItemTransferFailedError
  ) {
    return Response.json(
      {
        error: {
          code: error.kind,
          message: error.message,
        },
      },
      { status: 409 },
    );
  }

  if (error instanceof UntrustedRequestOriginError) {
    return Response.json(
      {
        error: {
          code: error.kind,
          message: error.reason,
        },
      },
      { status: 403 },
    );
  }

  if (error instanceof AcpEventLimitError) {
    return Response.json(
      {
        error: {
          code: error.kind,
          message:
            "The connected run exhausted its evidence budget and was recorded as failed. Retry the attempt; if it keeps happening, the run is producing more evidence than one attempt allows.",
        },
      },
      { status: 409 },
    );
  }

  if (error instanceof ZodError || error instanceof SyntaxError) {
    return Response.json(
      {
        error: {
          code: "invalid_request",
          message: "Invalid request",
        },
      },
      { status: 400 },
    );
  }

  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "Unexpected server error",
      },
    },
    { status: 500 },
  );
}
