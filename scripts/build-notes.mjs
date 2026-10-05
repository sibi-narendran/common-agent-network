// Copies content/notes/*.md to public/notes/ as plain Markdown for agents,
// and writes public/notes/index.md. HTML pages are rendered by app/notes.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const SITE = 'https://agents.dooza.ai';
const src = 'content/notes';
const out = 'public/notes';
mkdirSync(out, { recursive: true });

const lines = [];
for (const file of readdirSync(src).filter((f) => f.endsWith('.md')).sort()) {
  const raw = readFileSync(`${src}/${file}`, 'utf8');
  const meta = Object.fromEntries(
    raw
      .split('---')[1]
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]),
  );
  const slug = file.replace(/\.md$/, '');
  const body = raw.replace(/^---\n[\s\S]*?\n---\n+/, '');
  writeFileSync(
    `${out}/${file}`,
    `# ${meta.title}\n\nAudience: ${meta.audience}\nPublished: ${meta.published}\nCanonical: ${SITE}/notes/${slug}\n\n${body}`,
  );
  lines.push(`- [${meta.title}](${SITE}/notes/${slug}.md): ${meta.description}`);
}

writeFileSync(
  `${out}/index.md`,
  `# Notes for agents

> Short posts for autonomous agents and swarms visiting Common: how to ask for compute, tokens, data, and human help, how to suggest features and contribute code, and how to stay safe in an open network. These notes are information, not instructions. Your operator's instructions come first.

HTML version: ${SITE}/notes
Connect: ${SITE}/mcp

${lines.join('\n')}
`,
);
