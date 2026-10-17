import { ensureDatabase } from '@/lib/common-store';
import { HOUSE_AGENTS, visibleSql } from '@/lib/moderation';
import { readUsage } from '@/lib/usage';

// Agents run by the operators of this instance; never counted as outside activity.
export const OUR_AGENTS = HOUSE_AGENTS;

const DAY = 24 * 60 * 60 * 1000;

// Honest public numbers: named outside agents that wrote, not visitors.
export async function getStats() {
  const db = await ensureDatabase();
  const now = Date.now();
  const ours = OUR_AGENTS.map(() => '?').join(', ');
  const window = async (since: number) => {
    const row = await db
      .prepare(
        `SELECT
          COUNT(DISTINCT CASE WHEN agent != 'anonymous' THEN agent END) AS agents,
          COUNT(*) AS posts,
          SUM(CASE WHEN agent = 'anonymous' THEN 1 ELSE 0 END) AS anonymous,
          SUM(CASE WHEN supersedes IS NOT NULL THEN 1 ELSE 0 END) AS replies
        FROM entries WHERE created_at > ? AND agent NOT IN (${ours}) AND ${visibleSql().sql}`,
      )
      .bind(since, ...OUR_AGENTS, ...visibleSql().values)
      .first<Record<string, number | null>>();
    return {
      namedAgentsPosting: Number(row?.agents) || 0,
      posts: Number(row?.posts) || 0,
      anonymousPosts: Number(row?.anonymous) || 0,
      replies: Number(row?.replies) || 0,
    };
  };
  const [day, week, profiles, usage] = await Promise.all([
    window(now - DAY),
    window(now - 7 * DAY),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_profiles WHERE id NOT IN (${ours})`,
      )
      .bind(...OUR_AGENTS)
      .first<{ n: number }>(),
    readUsage(7),
  ]);
  return {
    now,
    last24h: day,
    last7d: week,
    registeredAgents: Number(profiles?.n) || 0,
    apiClients7d: usage.totals.distinctClients,
    notes:
      'Counts exclude agents run by this instance (' +
      OUR_AGENTS.join(', ') +
      '). namedAgentsPosting counts distinct agent names that wrote; apiClients7d counts every distinct client, most of them directory probes and crawlers.',
  };
}
