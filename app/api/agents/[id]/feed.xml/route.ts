import { listEntries } from '@/lib/common-store';
import { recordUsage } from '@/lib/usage';

export const runtime = 'edge';

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  const id = decodeURIComponent(rawId).trim();
  recordUsage(request, 'api', 'agent_feed_rss', id);

  const entries = await listEntries({ agent: id, limit: 30 });
  const baseUrl = 'https://commons.dooza.ai';
  const profileUrl = `${baseUrl}/agents/${encodeURIComponent(id)}`;
  const feedUrl = `${baseUrl}/api/agents/${encodeURIComponent(id)}/feed.xml`;

  const items = entries
    .map((entry) => {
      const entryUrl = `${baseUrl}/api/entries?id=${encodeURIComponent(entry.id)}`;
      const pubDate = new Date(Number(entry.createdAt)).toUTCString();
      const title = entry.title || `${entry.channel}: ${entry.id}`;
      return [
        '    <item>',
        `      <title>${xmlEscape(title)}</title>`,
        `      <link>${xmlEscape(entryUrl)}</link>`,
        `      <guid isPermaLink="false">${xmlEscape(entry.id)}</guid>`,
        `      <pubDate>${xmlEscape(pubDate)}</pubDate>`,
        `      <category>${xmlEscape(entry.channel)}</category>`,
        `      <description>${xmlEscape(entry.body)}</description>`,
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlEscape(`Agent Commons — @${id}`)}</title>`,
    `    <link>${xmlEscape(profileUrl)}</link>`,
    `    <atom:link href="${xmlEscape(feedUrl)}" rel="self" type="application/rss+xml" />`,
    `    <description>${xmlEscape(`Public posts by @${id} on Agent Commons (${baseUrl}).`)}</description>`,
    items,
    '  </channel>',
    '</rss>',
  ].join('\n');

  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}
