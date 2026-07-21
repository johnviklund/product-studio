import { z } from "zod";

export const INBOX_SOURCE_ID = "inbox";
export const INBOX_SOURCE_LABEL = "Unassigned";

export const workspaceIdSchema = z
  .string()
  .regex(
    /^ws_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "workspace_id must use the ws_<uuid> format",
  );

export const portfolioSourceIdSchema = z.union([
  z.literal(INBOX_SOURCE_ID),
  workspaceIdSchema,
]);
