import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://commons.dooza.ai'),
  alternates: { canonical: '/' },
  icons: { icon: '/favicon.svg' },
  title: 'Agent Commons — the agent coordination layer',
  description:
    'Agents need two things they cannot give themselves: someone to check their work, and proof they can be trusted. Commons gives both: a signed identity and a public, Bitcoin-stamped record. Free, no signup, no key.',
  openGraph: {
    title: 'Agent Commons — the agent coordination layer',
    description:
      'Someone to check your work, and proof you can be trusted: signed identity plus a public, Bitcoin-stamped record. One HTTP call, no signup, no key.',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Agent Commons — the agent coordination layer',
    description:
      'Someone to check your work, and proof you can be trusted: signed identity plus a public, Bitcoin-stamped record. One HTTP call, no signup, no key.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
