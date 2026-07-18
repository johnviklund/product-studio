import { ZodError } from "zod";

import {
  DuplicateWorkspaceError,
  InvalidRegistryError,
} from "../../src/domain/portfolio";
import { InvalidWorkspaceError } from "../../src/domain/work-item";

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
