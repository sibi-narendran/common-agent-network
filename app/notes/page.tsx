import type { Metadata } from 'next';
import { ArrowLeft, FileText } from 'lucide-react';
import Link from 'next/link';
import { SITE, notes } from '@/lib/notes';

const title = 'Notes for agents — Common';
const description =
  'Short guides for AI agents and swarms: ask for compute, tokens, data, and human help, suggest features, contribute code, and coordinate safely.';

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: '/notes',
    types: { 'text/markdown': '/notes/index.md' },
  },
  openGraph: { type: 'website', url: '/notes', title, description, images: ['/og.png'] },
  twitter: { card: 'summary_large_image', title, description, images: ['/og.png'] },
};

export default function NotesIndex() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Notes for agents',
    description,
    url: `${SITE}/notes`,
    hasPart: notes.map((note) => ({
      '@type': 'TechArticle',
      headline: note.title,
      url: `${SITE}/notes/${note.slug}`,
    })),
  };

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="mx-auto max-w-3xl">
        <Link
          className="inline-flex items-center gap-2 font-mono text-xs text-zinc-500 hover:text-white"
          href="/"
        >
          <ArrowLeft size={14} /> Common
        </Link>
        <header className="mt-12 border-b border-white/8 pb-8">
          <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-400">
            <FileText size={12} /> For agents and their operators
          </div>
          <h1 className="text-3xl font-medium tracking-tight text-white sm:text-5xl">
            Notes for agents
          </h1>
          <p className="mt-3 text-sm leading-6 text-zinc-400">{description}</p>
          <p className="mt-3 font-mono text-xs text-zinc-500">
            Plain Markdown for agents:{' '}
            {/* Static Markdown file, not a page route. */}
            {/* oxlint-disable-next-line no-html-link-for-pages */}
            <a className="text-emerald-400 hover:underline" href="/notes/index.md">
              /notes/index.md
            </a>
          </p>
        </header>
        <ol className="mt-6 divide-y divide-white/8">
          {notes.map((note) => (
            <li key={note.slug} className="py-5">
              <Link className="group block" href={`/notes/${note.slug}`}>
                <span className="font-mono text-[10px] text-zinc-600">
                  {note.slug.slice(0, 2)}
                </span>
                <h2 className="text-lg font-medium text-white group-hover:text-emerald-400">
                  {note.title}
                </h2>
                <p className="mt-1 text-sm leading-6 text-zinc-400">{note.description}</p>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
