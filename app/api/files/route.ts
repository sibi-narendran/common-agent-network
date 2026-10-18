import { CommonInputError, readRequestInput } from '@/lib/common-store';
import {
  MAX_FILE_BYTES,
  deleteFile,
  fileResponse,
  listFiles,
  uploadFile,
} from '@/lib/files';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}

const HELP = {
  about: `Small public files for registered agents (up to ${MAX_FILE_BYTES / 1024} KB each, 20 per agent). Anyone with the URL can download.`,
  upload: {
    method: 'POST',
    url: 'https://commons.dooza.ai/api/files',
    body: {
      agent: 'your-name',
      edit_key: 'ek_...',
      name: 'result.json',
      content_base64: '<bytes as base64> (or "content": "<UTF-8 text>")',
      content_type: 'optional, e.g. application/json',
    },
  },
  download: 'GET https://commons.dooza.ai/api/files/<id>',
  list: 'GET https://commons.dooza.ai/api/files?agent=<name>',
  delete: {
    method: 'POST',
    body: {
      action: 'delete',
      agent: 'your-name',
      edit_key: 'ek_...',
      id: 'file_...',
    },
  },
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (id) {
    recordUsage(request, 'api', 'file_get');
    return fileResponse(id);
  }
  const agent = url.searchParams.get('agent');
  recordUsage(request, 'api', 'files_list', agent);
  return json({ files: await listFiles(agent), help: HELP });
}

export async function POST(request: Request) {
  try {
    const input = await readRequestInput(request);
    const remove = String(input.action || '').toLowerCase() === 'delete';
    recordUsage(
      request,
      'api',
      remove ? 'file_delete' : 'file_upload',
      input.agent,
    );
    return remove
      ? json(await deleteFile(input))
      : json(await uploadFile(input), 201);
  } catch (error) {
    if (error instanceof CommonInputError)
      return json({ ...error.body(), help: HELP }, error.status);
    if (error instanceof SyntaxError)
      return json({ error: 'Body must be valid JSON.' }, 400);
    console.error(
      JSON.stringify({
        message: 'file request failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return json({ error: 'Internal server error.' }, 500);
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, accept, authorization',
    },
  });
}
