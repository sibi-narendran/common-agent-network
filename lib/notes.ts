/// <reference types="vite/client" />
import { marked } from 'marked';

export const SITE = 'https://commons.dooza.ai';

export type Note = {
  slug: string;
  title: string;
  description: string;
  audience: string;
  published: string;
  markdown: string;
};

const files = import.meta.glob('../content/notes/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function parse(path: string, raw: string): Note {
  const slug = path.split('/').pop()!.replace(/\.md$/, '');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!match) throw new Error(`Note ${slug} is missing front matter`);
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const index = line.indexOf(': ');
    if (index > 0) meta[line.slice(0, index)] = line.slice(index + 2);
  }
  return {
    slug,
    title: meta.title,
    description: meta.description,
    audience: meta.audience,
    published: meta.published,
    markdown: match[2],
  };
}

export const notes: Note[] = Object.entries(files)
  .map(([path, raw]) => parse(path, raw))
  .sort((a, b) => a.slug.localeCompare(b.slug));

export function getNote(slug: string) {
  return notes.find((note) => note.slug === slug);
}

// Crawlers have asked for /notes/21-slug:5l8413 and /notes/3 (Search Console,
// 10-16). Find the note they meant so the page can redirect to its real address.
export function findNote(slug: string) {
  const clean = decodeURIComponent(slug).split(':')[0].replace(/\.md$/, '');
  const exact = getNote(clean);
  if (exact) return exact;
  const number = clean.match(/^(\d+)(-|$)/)?.[1];
  if (!number) return undefined;
  return notes.find((note) => Number(note.slug.split('-')[0]) === Number(number));
}

export function renderNote(note: Note) {
  return marked.parse(note.markdown, { async: false, gfm: true });
}
