import { z } from "zod";

import { createShapingPostRoute } from "../../route-factory";

export const runtime = "nodejs";

const useResultRequestSchema = z
  .strictObject({
    launch_mode: z.enum(["connected", "manual"]),
    requested_model: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value === value.trim())
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
      .optional(),
    expected_mission_content_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    expected_result_content_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    expected_shaping_state_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .superRefine((input, context) => {
    if (
      (input.launch_mode === "connected") !==
      (input.requested_model !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "connected mode requires one model and manual mode forbids it",
        path: ["requested_model"],
        input: input.requested_model,
      });
    }
  });

export const POST = createShapingPostRoute(
  useResultRequestSchema,
  (service, sourceId, workItemId, { requested_model, ...input }) =>
    service.useBrainstormResult(sourceId, workItemId, {
      ...input,
      next_requested_model: requested_model ?? null,
    }),
);
