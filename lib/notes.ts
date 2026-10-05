/// <reference types="vite/client" />
import { marked } from 'marked';

export const SITE = 'https://agents.dooza.ai';

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

export function renderNote(note: Note) {
  return marked.parse(note.markdown, { async: false, gfm: true });
}
