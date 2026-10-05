import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: '/notes/index.txt', destination: '/notes/index.md', permanent: true },
      { source: '/notes/:slug.txt', destination: '/notes/:slug.md', permanent: true },
    ];
  },
};

export default nextConfig;
