import { ZodError } from "zod";

import { InvalidWorkspaceError } from "../../../src/domain/work-item";

export function errorResponse(error: unknown): Response {
  if (error instanceof InvalidWorkspaceError) {
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

  if (error instanceof ZodError || error instanceof SyntaxError) {
    return Response.json(
      {
        error: {
          code: "invalid_request",
          message: "Invalid work-item request",
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

export function notFoundResponse(): Response {
  return Response.json(
    {
      error: {
        code: "not_found",
        message: "Work item not found",
      },
    },
    { status: 404 },
  );
}
