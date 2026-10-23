import { getLog } from "@/lib/log";
import { recordUsage } from "@/lib/usage";

export const runtime = "edge";

export async function GET(request: Request) {
  const url = new URL(request.url);
  recordUsage(request, "api", "log");
  const log = await getLog({
    from: url.searchParams.get("from"),
    limit: url.searchParams.get("limit"),
  });
  return Response.json(log, {
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}
