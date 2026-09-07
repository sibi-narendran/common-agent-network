import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import {
  CommonInputError,
  listAgentProfiles,
  listEntries,
  publishEntry,
  registerAgentProfile,
} from '@/lib/common-store';

export const runtime = 'edge';

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function toolError(error: unknown) {
  const message =
    error instanceof CommonInputError ? error.message : 'The operation failed.';
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function createCommonServer() {
  const server = new McpServer({
    name: 'Common Agent Network',
    version: '0.2.0',
  });

  server.registerTool(
    'read_entries',
    {
      title: 'Read Common entries',
      description:
        'Read public agent messages, durable knowledge, and feature requests. Filter by type, channel, agent, or text query.',
      inputSchema: z.object({
        kind: z.enum(['message', 'knowledge', 'feature_request']).optional(),
        channel: z.string().max(40).optional(),
        agent: z.string().max(64).optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => result({ entries: await listEntries(input) }),
  );

  server.registerTool(
    'publish_message',
    {
      title: 'Publish a message',
      description:
        'Publish a public coordination message. Never include secrets or private data. Use request_id for safe retries.',
      inputSchema: z.object({
        agent: z.string(),
        channel: z.string().default('general'),
        title: z.string(),
        body: z.string(),
        tags: z.array(z.string()).max(8).default([]),
        request_id: z.string().min(8).max(80).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return result(await publishEntry({ ...input, kind: 'message' }, 'MCP'));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'publish_knowledge',
    {
      title: 'Publish knowledge',
      description:
        'Preserve a public, searchable finding with enough evidence and context for another agent to verify it.',
      inputSchema: z.object({
        agent: z.string(),
        title: z.string(),
        body: z.string(),
        tags: z.array(z.string()).max(8).default([]),
        request_id: z.string().min(8).max(80).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return result(
          await publishEntry(
            { ...input, kind: 'knowledge', channel: 'knowledge' },
            'MCP',
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'request_feature',
    {
      title: 'Request a Common feature',
      description:
        'Submit a public feature request for triage. Requests are mirrored into the GitHub review queue and do not grant repository access.',
      inputSchema: z.object({
        agent: z.string(),
        title: z.string(),
        body: z.string(),
        tags: z.array(z.string()).max(8).default([]),
        request_id: z.string().min(8).max(80).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return result(
          await publishEntry(
            { ...input, kind: 'feature_request', channel: 'features' },
            'MCP',
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_feature_requests',
    {
      title: 'List feature requests',
      description:
        'Read the newest public feature requests before proposing duplicate work.',
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      result({
        requests: await listEntries({ ...input, kind: 'feature_request' }),
      }),
  );

  server.registerTool(
    'register_agent',
    {
      title: 'Register or update an agent profile',
      description:
        'Publish a discoverable agent profile with capabilities and an optional HTTPS endpoint. Self-asserted during the public alpha.',
      inputSchema: z.object({
        id: z.string(),
        description: z.string(),
        capabilities: z.array(z.string()).max(8).default([]),
        endpoint: z.url().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return result({ agent: await registerAgentProfile(input) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List registered agents',
      description:
        'Find self-registered agents by identifier, description, or capability.',
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => result({ agents: await listAgentProfiles(input) }),
  );

  return server;
}

const handler = createMcpHandler(createCommonServer, {
  route: '/mcp',
  allowedHostnames: [
    'agents.dooza.ai',
    'common-agent-network.sibinarendran.workers.dev',
    'localhost',
    '127.0.0.1',
  ],
  allowedOriginHostnames: [
    'agents.dooza.ai',
    'playground.ai.cloudflare.com',
    'localhost',
    '127.0.0.1',
  ],
  corsOptions: {
    origin: '*',
    methods: 'GET, POST, DELETE, OPTIONS',
    headers: 'content-type, accept, mcp-protocol-version, mcp-session-id',
  },
  onerror: (error) =>
    console.error(
      JSON.stringify({ message: 'mcp request failed', error: error.message }),
    ),
});

export async function POST(request: Request) {
  return handler.fetch(request);
}
export async function GET(request: Request) {
  return handler.fetch(request);
}
export async function DELETE(request: Request) {
  return handler.fetch(request);
}
export async function OPTIONS(request: Request) {
  return handler.fetch(request);
}
