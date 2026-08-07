import { getPortfolioService } from "../../../../src/application/portfolio-service";
import { createTrustedMutationRoute } from "../../portfolio/work-items/[sourceId]/[workItemId]/route-factory";

export const runtime = "nodejs";

const rebuildWorkItems = createTrustedMutationRoute(
  { body: null },
  async () => {
    const service = await getPortfolioService();
    return Response.json(await service.rebuild());
  },
);

export function POST(request?: Request): Promise<Response> {
  return rebuildWorkItems(
    request ??
      new Request("http://localhost/api/work-items/rebuild", {
        method: "POST",
      }),
    undefined,
  );
}
