import type { z } from "zod";

import type { PortfolioService } from "../../../../../../src/application/portfolio";
import {
  getPortfolioService,
  getPortfolioTrustedOriginConfig,
} from "../../../../../../src/application/portfolio-service";
import { assertTrustedRequestOrigin } from "../../../../../../src/application/request-origin";
import {
  CONNECTED_REQUEST_MAX_BYTES,
  readCappedJsonRequest,
  SHAPING_REQUEST_MAX_BYTES,
} from "../../../../request-body";
import { errorResponse } from "../../../../responses";

export interface ShapingRouteContext {
  params: Promise<{
    sourceId: string;
    workItemId: string;
  }>;
}

type ShapingRouteAction<Input> = (
  service: PortfolioService,
  sourceId: string,
  workItemId: string,
  input: Input,
) => unknown | Promise<unknown>;

type ShapingGetAction = (
  service: PortfolioService,
  sourceId: string,
  workItemId: string,
) => unknown | Promise<unknown>;

function createPostRoute<Input>(
  schema: z.ZodType<Input>,
  maxBytes: number,
  action: ShapingRouteAction<Input>,
): (request: Request, context: ShapingRouteContext) => Promise<Response> {
  return async (request, context) => {
    try {
      assertTrustedRequestOrigin(request, getPortfolioTrustedOriginConfig());
      const input = await readCappedJsonRequest(
        request,
        schema,
        maxBytes,
      );
      const { sourceId, workItemId } = await context.params;
      const service = await getPortfolioService();
      return Response.json(await action(service, sourceId, workItemId, input));
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createShapingPostRoute<Input>(
  schema: z.ZodType<Input>,
  action: ShapingRouteAction<Input>,
): (request: Request, context: ShapingRouteContext) => Promise<Response> {
  return createPostRoute(schema, SHAPING_REQUEST_MAX_BYTES, action);
}

export function createConnectedPostRoute<Input>(
  schema: z.ZodType<Input>,
  action: ShapingRouteAction<Input>,
): (request: Request, context: ShapingRouteContext) => Promise<Response> {
  return createPostRoute(schema, CONNECTED_REQUEST_MAX_BYTES, action);
}

export function createShapingGetRoute(
  action: ShapingGetAction,
): (_request: Request, context: ShapingRouteContext) => Promise<Response> {
  return async (_request, context) => {
    try {
      const { sourceId, workItemId } = await context.params;
      const service = await getPortfolioService();
      return Response.json(await action(service, sourceId, workItemId));
    } catch (error) {
      return errorResponse(error);
    }
  };
}
