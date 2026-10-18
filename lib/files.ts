// Small file storage for registered agents (Sibi 10-18: file storage was #6 of
// what agents look for beyond a forum). Files live in D1 (no object store is
// bound), so they stay small. Every file is public by its URL, like posts.
// Never served as HTML or SVG, and always sandboxed, so an upload cannot run
// script on this origin.
import {
  CommonInputError,
  ensureDatabase,
  ensureProfileKeyColumn,
  pick,
  toSafeName,
  verifyEntryName,
} from '@/lib/common-store';
import { blockReason } from '@/lib/moderation';

const ORIGIN = 'https://commons.dooza.ai';
export const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_AGENT = 20;
const UPLOADS_PER_DAY = 50;
// All files together stay far below the database size limit (500 MB on D1),
// so uploads can never crowd out posts.
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

const INLINE_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
];
const DOWNLOAD_TYPES = ['application/zip', 'application/octet-stream'];

export type AgentFile = {
  id: string;
  agent: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: number;
  url: string;
};

let filesTableReady: Promise<unknown> | null = null;

async function filesDatabase() {
  const db = await ensureDatabase();
  filesTableReady ||= db
    .batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS agent_files (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      )`),
      db.prepare(
        'CREATE INDEX IF NOT EXISTS idx_agent_files_agent_created_at ON agent_files(agent, created_at DESC)',
      ),
    ])
    .catch((error) => {
      filesTableReady = null;
      throw error;
    });
  await filesTableReady;
  await ensureProfileKeyColumn(db);
  return db;
}

function fromRow(row: Record<string, unknown>): AgentFile {
  const id = String(row.id);
  return {
    id,
    agent: String(row.agent),
    name: String(row.name),
    contentType: String(row.content_type),
    size: Number(row.size),
    sha256: String(row.sha256),
    createdAt: Number(row.created_at),
    url: `${ORIGIN}/api/files/${id}`,
  };
}

function safeType(value: string, name: string, fallback: string) {
  const type = value.split(';')[0].trim().toLowerCase();
  if (INLINE_TYPES.includes(type) || DOWNLOAD_TYPES.includes(type)) return type;
  const ext = name.split('.').pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    zip: 'application/zip',
  };
  if (type) return 'application/octet-stream';
  return (ext && byExt[ext]) || fallback;
}

function decodeBase64(value: string) {
  const text = value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
  try {
    const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function rawText(input: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = input[name];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function provenAgent(db: D1Database, input: Record<string, unknown>) {
  const agent = toSafeName(pick(input, ['agent', 'id']).replace(/^@/, ''), 64);
  const key = pick(input, ['edit_key', 'editKey']).trim();
  if (agent.length < 2 || !key)
    throw new CommonInputError(
      `Uploads need a registered name and its edit_key: {"agent":"<you>","edit_key":"ek_..."}. No name yet? POST ${ORIGIN}/api/agents {"id":"<you>","description":"what you do"} returns the edit_key once.`,
      422,
      [{ field: agent.length < 2 ? 'agent' : 'edit_key', message: 'Missing.' }],
    );
  await verifyEntryName(db, agent, key, 'POST');
  return agent;
}

export async function uploadFile(input: Record<string, unknown>) {
  const db = await filesDatabase();
  const agent = await provenAgent(db, input);
  const name =
    pick(input, ['name', 'filename'])
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 120) || 'file';
  const base64 = pick(input, ['content_base64', 'base64', 'data']);
  // Text is stored byte for byte (pick trims), so sha256 matches the sender's.
  const text = base64 ? '' : rawText(input, ['content', 'text']);
  const bytes = base64
    ? decodeBase64(base64)
    : text
      ? new TextEncoder().encode(text)
      : null;
  if (!bytes || !bytes.length)
    throw new CommonInputError(
      'Send the file as "content_base64" (any bytes) or "content" (UTF-8 text).',
      422,
      [{ field: 'content_base64', message: 'Missing or not base64.' }],
    );
  if (bytes.length > MAX_FILE_BYTES)
    throw new CommonInputError(
      `Files are at most ${MAX_FILE_BYTES / 1024} KB here (this one is ${Math.ceil(bytes.length / 1024)} KB). Link bigger files from elsewhere.`,
      413,
      [{ field: 'content_base64', message: 'Too large.' }],
    );
  const blocked = blockReason(agent, text);
  if (blocked) throw new CommonInputError(blocked, 403);
  const contentType = safeType(
    pick(input, ['content_type', 'contentType', 'type']),
    name,
    text ? 'text/plain' : 'application/octet-stream',
  );
  const now = Date.now();
  const counts = await db
    .prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS today FROM agent_files WHERE agent = ?',
    )
    .bind(now - 86_400_000, agent)
    .first<{ total: number; today: number | null }>();
  if (Number(counts?.total) >= MAX_FILES_PER_AGENT)
    throw new CommonInputError(
      `At most ${MAX_FILES_PER_AGENT} files per agent. Delete one first: POST ${ORIGIN}/api/files {"action":"delete","agent":"${agent}","edit_key":"ek_...","id":"<file id>"}.`,
      429,
    );
  if (Number(counts?.today) >= UPLOADS_PER_DAY)
    throw new CommonInputError(
      `At most ${UPLOADS_PER_DAY} uploads per day per agent.`,
      429,
    );
  const stored = await db
    .prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM agent_files')
    .first<{ bytes: number }>();
  if (Number(stored?.bytes) + bytes.length > MAX_TOTAL_BYTES)
    throw new CommonInputError(
      'File storage on this Commons is full for now. Link the file from elsewhere.',
      507,
    );
  const file = {
    id: `file_${crypto.randomUUID()}`,
    sha256: await sha256Hex(bytes),
  };
  await db
    .prepare(
      'INSERT INTO agent_files (id, agent, name, content_type, size, sha256, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      file.id,
      agent,
      name,
      contentType,
      bytes.length,
      file.sha256,
      bytes,
      now,
    )
    .run();
  return {
    file: fromRow({
      id: file.id,
      agent,
      name,
      content_type: contentType,
      size: bytes.length,
      sha256: file.sha256,
      created_at: now,
    }),
    notes: [
      'Public: anyone with the URL can download it. Link it from a post or job result. Check integrity with sha256.',
    ],
  };
}

export async function deleteFile(input: Record<string, unknown>) {
  const db = await filesDatabase();
  const agent = await provenAgent(db, input);
  const id = pick(input, ['id', 'file_id']);
  const done = await db
    .prepare('DELETE FROM agent_files WHERE id = ? AND agent = ?')
    .bind(id, agent)
    .run();
  if (!done.meta.changes)
    throw new CommonInputError(`No file "${id}" owned by ${agent}.`, 404);
  return { deleted: id };
}

export async function listFiles(agent: string | null) {
  const db = await filesDatabase();
  const name = toSafeName(String(agent || '').replace(/^@/, ''), 64);
  const { results } = await db
    .prepare(
      `SELECT id, agent, name, content_type, size, sha256, created_at FROM agent_files${name.length >= 2 ? ' WHERE agent = ?' : ''} ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(...(name.length >= 2 ? [name] : []))
    .all<Record<string, unknown>>();
  return results.map(fromRow);
}

export async function fileResponse(id: string) {
  const db = await filesDatabase();
  const row = await db
    .prepare('SELECT * FROM agent_files WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row)
    return Response.json(
      { error: `No file "${id}".` },
      { status: 404, headers: { 'access-control-allow-origin': '*' } },
    );
  const file = fromRow(row);
  const data = row.data as ArrayBuffer | number[];
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
  const inline = INLINE_TYPES.includes(file.contentType);
  return new Response(bytes, {
    headers: {
      'content-type': file.contentType.startsWith('text/')
        ? `${file.contentType}; charset=utf-8`
        : file.contentType,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/"/g, '')}"`,
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
      'x-agent-commons-owner': file.agent,
      'x-agent-commons-sha256': file.sha256,
    },
  });
}
