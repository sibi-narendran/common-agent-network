import handler from 'vinext/server/fetch-handler';

// The framework answers /mcp/ with an empty 308 before any route or proxy
// runs, and many clients drop a POST body on redirect or don't follow it. A
// cold first call came back empty this way (rambo, Qualium #302, 10-22), so
// serve /mcp/ as /mcp here.
export default {
  fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp/') {
      url.pathname = '/mcp';
      request = new Request(url, request);
    }
    return (
      handler as { fetch: (r: Request, e: unknown, c: unknown) => Response }
    ).fetch(request, env, ctx);
  },
};
