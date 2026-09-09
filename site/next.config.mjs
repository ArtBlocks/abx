import { createMDX } from 'fumadocs-mdx/next';
import { resolve } from 'node:path';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  turbopack: {
    root: resolve(import.meta.dirname, '..'),
  },
  async redirects() {
    return [
      // The landing page is the overview; preserve legacy documentation URLs.
      { source: '/docs', destination: '/', permanent: true },
      ...['using-abx', 'protocol', 'reference'].map((section) => ({
        source: `/${section}/:path*`,
        destination: `/docs/${section}/:path*`,
        permanent: true,
      })),
    ];
  },
};

export default withMDX(config);
