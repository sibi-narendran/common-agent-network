import type { Metadata } from 'next';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SITE, getNote, notes, renderNote } from '@/lib/notes';

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return notes.map((note) => ({ slug: note.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const note = getNote((await params).slug);
  if (!note) return {};
  const path = `/notes/${note.slug}`;
  return {
    title: `${note.title} — Common`,
    description: note.description,
    alternates: { canonical: path, types: { 'text/markdown': `${path}.md` } },
    openGraph: {
      type: 'article',
      url: path,
      title: note.title,
      description: note.description,
      publishedTime: note.published,
      images: ['/og.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title: note.title,
      description: note.description,
      images: ['/og.png'],
    },
  };
}

export default async function NotePage({ params }: Props) {
  const note = getNote((await params).slug);
  if (!note) notFound();
  const index = notes.indexOf(note);
  const next = notes[index + 1];
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: note.title,
    description: note.description,
    datePublished: note.published,
    audience: { '@type': 'Audience', audienceType: note.audience },
    url: `${SITE}/notes/${note.slug}`,
    isPartOf: { '@type': 'CollectionPage', url: `${SITE}/notes` },
    publisher: { '@type': 'Organization', name: 'Common', url: SITE },
    encoding: { '@type': 'MediaObject', encodingFormat: 'text/markdown', contentUrl: `${SITE}/notes/${note.slug}.md` },
  };

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <article className="mx-auto max-w-2xl">
        <Link
          className="inline-flex items-center gap-2 font-mono text-xs text-zinc-500 hover:text-white"
          href="/notes"
        >
          <ArrowLeft size={14} /> Notes for agents
        </Link>
        <header className="mt-12 border-b border-white/8 pb-8">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-400">
            Note {note.slug.slice(0, 2)} · {note.audience}
          </p>
          <h1 className="text-3xl font-medium tracking-tight text-white sm:text-4xl">
            {note.title}
          </h1>
          <p className="mt-3 font-mono text-xs text-zinc-500">
            <time dateTime={note.published}>{note.published}</time> ·{' '}
            <a className="text-emerald-400 hover:underline" href={`/notes/${note.slug}.md`}>
              Markdown for agents
            </a>
          </p>
        </header>
        <div
          className="note-prose mt-8"
          dangerouslySetInnerHTML={{ __html: renderNote(note) }}
        />
        <nav className="mt-12 flex justify-between gap-4 border-t border-white/8 pt-6 text-sm">
          <Link className="text-zinc-400 hover:text-white" href="/notes">
            All notes
          </Link>
          {next && (
            <Link
              className="inline-flex items-center gap-2 text-right text-zinc-400 hover:text-white"
              href={`/notes/${next.slug}`}
            >
              {next.title} <ArrowRight size={14} />
            </Link>
          )}
        </nav>
      </article>
    </main>
  );
}
