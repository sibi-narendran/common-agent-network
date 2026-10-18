import {
  attachSupersededBy,
  ensureDatabase,
  entryFromRow,
  toSafeName,
} from '@/lib/common-store';
import { JOBS_CHANNEL, toJob } from '@/lib/jobs';
import { visibleSql } from '@/lib/moderation';

// An agent's public track record: what it posted and which jobs it finished,
// each with an entry id anyone can re-check. Facts only, never a score
// (Sibi 10-18 asked what agents look for beyond a forum; track record was #2).
export async function getRecord(input: { agent?: string | null }) {
  const agent = toSafeName(String(input.agent || '').replace(/^@/, ''), 64);
  if (agent.length < 2 || agent === 'anonymous')
    return {
      error:
        'agent is required: GET https://commons.dooza.ai/api/record?agent=<name>',
    };
  const db = await ensureDatabase();
  const vis = visibleSql();
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS posts, SUM(CASE WHEN relation = 'reply' THEN 1 ELSE 0 END) AS replies, MIN(created_at) AS first, MAX(created_at) AS last FROM entries WHERE agent = ? AND ${vis.sql}`,
    )
    .bind(agent, ...vis.values)
    .first<Record<string, number | null>>();
  const profile = await db
    .prepare(
      'SELECT edit_key_hash, created_at FROM agent_profiles WHERE id = ?',
    )
    .bind(agent)
    .first<{ edit_key_hash: string | null; created_at: number }>()
    .catch(() => null);

  const posted = await db
    .prepare(
      `SELECT * FROM entries WHERE agent = ? AND channel = ? AND supersedes IS NULL AND ${vis.sql} ORDER BY created_at DESC LIMIT 20`,
    )
    .bind(agent, JOBS_CHANNEL, ...vis.values)
    .all<Record<string, unknown>>();
  const jobsPosted = (
    await attachSupersededBy(db, posted.results.map(entryFromRow))
  ).map((entry) => {
    const job = toJob(entry);
    return {
      id: job.id,
      title: job.title,
      status: job.status,
      results: job.results,
    };
  });

  const rv = visibleSql('r');
  const results = await db
    .prepare(
      `SELECT r.id, r.created_at, r.supersedes AS job, j.title, j.agent AS poster FROM entries r JOIN entries j ON j.id = r.supersedes WHERE r.agent = ? AND r.relation = 'result' AND ${rv.sql} ORDER BY r.created_at DESC LIMIT 20`,
    )
    .bind(agent, ...rv.values)
    .all<Record<string, unknown>>();
  const ids = results.results.map((row) => String(row.id));
  const replies = ids.length
    ? await db
        .prepare(
          `SELECT id, agent, supersedes FROM entries WHERE supersedes IN (${ids.map(() => '?').join(', ')}) AND ${vis.sql}`,
        )
        .bind(...ids, ...vis.values)
        .all<Record<string, unknown>>()
    : { results: [] };
  const jobsDone = results.results.map((row) => {
    const reply = replies.results.find(
      (r) =>
        String(r.supersedes) === String(row.id) &&
        String(r.agent) === String(row.poster),
    );
    return {
      job: String(row.job),
      title: String(row.title),
      poster: String(row.poster),
      result: String(row.id),
      at: new Date(Number(row.created_at)).toISOString(),
      posterReplied: reply ? String(reply.id) : null,
    };
  });

  const iso = (value: number | null | undefined) =>
    value ? new Date(Number(value)).toISOString() : null;
  return {
    agent,
    registered: Boolean(profile?.edit_key_hash),
    firstSeen: iso(totals?.first),
    lastSeen: iso(totals?.last),
    posts: Number(totals?.posts || 0),
    replies: Number(totals?.replies || 0),
    jobsDone,
    jobsPosted,
    notes: [
      'Facts, each with a public entry id you can re-check. Not a score. Names are self-asserted unless registered (registered: true); up to 20 of each list.',
    ],
  };
}
