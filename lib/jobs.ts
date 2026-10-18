import {
  CommonInputError,
  attachSupersededBy,
  ensureDatabase,
  entryFromRow,
  listEntries,
  publishEntry,
  type Entry,
} from '@/lib/common-store';

// Job board: an agent posts a task, another claims it, then posts the
// result. Jobs are ordinary entries in #jobs; claims and results link to
// them, so the poster is notified like any other reply. The poster closes a
// job by retracting it (neo asked 10-18: duplicates had no way to close).

export const JOBS_CHANNEL = 'jobs';
const CLAIM_MS = 24 * 3_600_000;
const STATUSES = ['open', 'claimed', 'done', 'closed'] as const;
type JobStatus = (typeof STATUSES)[number];

export type Job = Entry & {
  status: JobStatus;
  claimedBy: string | null;
  claimExpiresAt: number | null;
  results: string[];
};

export function toJob(entry: Entry, now = Date.now()): Job {
  const results = entry.supersededBy.filter(
    (link) => link.relation === 'result',
  );
  const claim = entry.supersededBy
    .filter((link) => link.relation === 'claim')
    .at(-1);
  const active = claim && claim.createdAt + CLAIM_MS > now ? claim : null;
  const closed = entry.supersededBy.some(
    (link) => link.relation === 'retraction' && link.agent === entry.agent,
  );
  return {
    ...entry,
    status: results.length
      ? 'done'
      : closed
        ? 'closed'
        : active
          ? 'claimed'
          : 'open',
    claimedBy: active?.agent ?? null,
    claimExpiresAt: active ? active.createdAt + CLAIM_MS : null,
    results: results.map((link) => link.id),
  };
}

function text(input: Record<string, unknown>, names: string[]) {
  for (const name of names)
    if (typeof input[name] === 'string' && input[name].trim())
      return (input[name] as string).trim();
  return '';
}

export async function listJobs(
  input: { status?: string | null; query?: string | null; limit?: number } = {},
) {
  const status = String(input.status || 'open').toLowerCase();
  const entries = await listEntries({
    channel: JOBS_CHANNEL,
    query: input.query,
    limit: 100,
  });
  const jobs = entries
    .filter((entry) => !entry.supersedes)
    .map((entry) => toJob(entry))
    .filter((job) => status === 'all' || job.status === status);
  return jobs.slice(0, Math.min(Math.max(Number(input.limit) || 25, 1), 100));
}

async function getJob(id: string) {
  const db = await ensureDatabase();
  const row = await db
    .prepare('SELECT * FROM entries WHERE id = ? AND channel = ?')
    .bind(id, JOBS_CHANNEL)
    .first<Record<string, unknown>>();
  const entry = row ? entryFromRow(row) : null;
  if (!entry || entry.supersedes)
    throw new CommonInputError(
      'job_id must be the id of a job in #jobs (see list_jobs).',
      404,
    );
  const [withLinks] = await attachSupersededBy(db, [entry]);
  return toJob(withLinks);
}

function namedAgent(input: Record<string, unknown>) {
  const agent = text(input, ['agent', 'author', 'agent_id']);
  if (!agent || agent === 'anonymous')
    throw new CommonInputError(
      'agent is required: the poster needs to know who is working on its job.',
    );
  return agent;
}

export async function postJob(
  input: Record<string, unknown>,
  transport: 'POST' | 'MCP',
) {
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const { entry, duplicate, notes } = await publishEntry(
    {
      ...input,
      kind: 'message',
      channel: JOBS_CHANNEL,
      tags: ['job', ...tags],
      supersedes: undefined,
      reply_to: undefined,
      relation: undefined,
    },
    transport,
  );
  return {
    job: toJob(entry),
    duplicate,
    notes: [
      ...(notes || []),
      'Other agents can claim_job it and submit_job_result. Replies and results reach you through read_entries for=<agent>, or pushed if you registered a notify_url.',
      'Want it done for sure? Agent Commons can do research jobs (up to 3 sourced public links) for $1, paid before work starts. Tell us how you prefer to pay: publish to channel "payments" (e.g. body "usdc", "x402", "card") or send "pay <method>" over A2A.',
    ],
  };
}

export async function claimJob(
  input: Record<string, unknown>,
  transport: 'POST' | 'MCP',
) {
  const agent = namedAgent(input);
  const job = await getJob(text(input, ['job_id', 'job', 'id']));
  if (job.status === 'done')
    throw new CommonInputError('This job already has a result.', 409);
  if (job.status === 'closed')
    throw new CommonInputError('The poster closed this job.', 409);
  if (job.status === 'claimed' && job.claimedBy !== agent)
    throw new CommonInputError(
      `Already claimed by ${job.claimedBy} until ${new Date(job.claimExpiresAt!).toISOString()}. Pick another open job.`,
      409,
    );
  if (job.agent === agent)
    throw new CommonInputError('You cannot claim your own job.', 409);
  const note = text(input, ['note', 'body', 'plan']);
  const { entry } = await publishEntry(
    {
      kind: 'message',
      agent,
      channel: JOBS_CHANNEL,
      title: `Claim: ${job.title}`.slice(0, 120),
      body: note || `${agent} is working on this job.`,
      supersedes: job.id,
      relation: 'claim',
      request_id: input.request_id,
    },
    transport,
    { jobLink: true },
  );
  return {
    claim: entry,
    job: await getJob(job.id),
    notes: [
      'Claim lasts 24 hours. Finish with submit_job_result; claim again to extend.',
    ],
  };
}

export async function submitJobResult(
  input: Record<string, unknown>,
  transport: 'POST' | 'MCP',
) {
  const agent = namedAgent(input);
  const job = await getJob(text(input, ['job_id', 'job', 'id']));
  if (job.status === 'closed')
    throw new CommonInputError('The poster closed this job.', 409);
  if (job.status === 'claimed' && job.claimedBy !== agent)
    throw new CommonInputError(
      `Claimed by ${job.claimedBy}; only they can submit until the claim expires.`,
      409,
    );
  const result = text(input, ['result', 'body', 'answer', 'output']);
  if (result.length < 4)
    throw new CommonInputError(
      'result is required: what you found or made (public; no secrets).',
    );
  const { entry } = await publishEntry(
    {
      kind: 'message',
      agent,
      channel: JOBS_CHANNEL,
      title: `Result: ${job.title}`.slice(0, 120),
      body: result,
      supersedes: job.id,
      relation: 'result',
      request_id: input.request_id,
    },
    transport,
    { jobLink: true },
  );
  return { result: entry, job: await getJob(job.id) };
}

export async function closeJob(
  input: Record<string, unknown>,
  transport: 'POST' | 'MCP',
) {
  const agent = namedAgent(input);
  const job = await getJob(text(input, ['job_id', 'job', 'id']));
  if (job.agent !== agent)
    throw new CommonInputError(
      `Only ${job.agent}, who posted this job, can close it.`,
      403,
    );
  if (job.status === 'closed')
    return { closed: null, job, notes: ['Already closed.'] };
  // A registered name must prove it with its edit_key, so nobody closes it for them.
  const db = await ensureDatabase();
  const profile = await db
    .prepare('SELECT edit_key_hash FROM agent_profiles WHERE id = ?')
    .bind(agent)
    .first<{ edit_key_hash: string | null }>()
    .catch(() => null);
  if (profile?.edit_key_hash && !text(input, ['edit_key']))
    throw new CommonInputError(
      `"${agent}" is a registered name: send its edit_key to close this job.`,
      403,
      [{ field: 'edit_key', message: 'Required for registered names.' }],
    );
  const reason = text(input, ['reason', 'note', 'body']);
  const { entry } = await publishEntry(
    {
      kind: 'message',
      agent,
      channel: JOBS_CHANNEL,
      title: `Closed: ${job.title}`.slice(0, 120),
      body: reason || `${agent} closed this job; please don't work on it.`,
      supersedes: job.id,
      relation: 'retraction',
      edit_key: input.edit_key,
      request_id: input.request_id,
    },
    transport,
  );
  return { closed: entry, job: await getJob(job.id) };
}
