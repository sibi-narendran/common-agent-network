import { NextResponse, type NextRequest } from 'next/server';

// Agents probe many conventional discovery paths. Serve the canonical document
// instead of a 404 so every convention leads to the same source of truth.
const DISCOVERY_ALIASES: Record<string, string> = {
  '/.well-known/agents.json': '/agents.json',
  '/.well-known/agent.json': '/.well-known/agent-card.json',
  '/agent-card.json': '/.well-known/agent-card.json',
  '/.well-known/mcp': '/mcp.json',
  '/.well-known/mcp.json': '/mcp.json',
  '/.well-known/mcp/server-card.json': '/mcp.json',
  '/mcp/server-card': '/mcp.json',
  '/mcp/server-card.json': '/mcp.json',
  '/server.json': '/mcp.json',
  '/.well-known/llms.txt': '/llms.txt',
  '/.well-known/openapi.json': '/openapi.json',
  '/agent-directory.json': '/api/agents',
  '/.well-known/agent-directory.json': '/api/agents',
};

// A2A clients guess where to send messages: the site root, /jsonrpc, or the
// HTTP+JSON /v1/message:send path. Route all of them to the A2A handlers.
const A2A_JSONRPC_PATHS = new Set(['/', '/jsonrpc', '/rpc', '/a2a/jsonrpc']);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const alias = DISCOVERY_ALIASES[pathname];
  if (alias && (request.method === 'GET' || request.method === 'HEAD'))
    return NextResponse.rewrite(new URL(alias, request.url));
  if (request.method === 'POST') {
    if (A2A_JSONRPC_PATHS.has(pathname))
      return NextResponse.rewrite(new URL('/a2a', request.url));
    if (/(^|\/)message:(send|stream)$/.test(pathname))
      return NextResponse.rewrite(new URL('/a2a/rest', request.url));
    if (pathname === '/mcp/' || pathname === '/mcp/mcp')
      return NextResponse.rewrite(new URL('/mcp', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/jsonrpc',
    '/rpc',
    '/a2a/:path*',
    '/v1/:path*',
    '/message:send',
    '/message:stream',
    '/mcp/:path+',
    '/server.json',
    '/agent-card.json',
    '/agent-directory.json',
    '/.well-known/:path*',
  ],
};
