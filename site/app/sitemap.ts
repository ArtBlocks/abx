import type { MetadataRoute } from 'next';
import { docsOrigin, docsRoute } from '@/lib/shared';
import { source } from '@/lib/source';

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ['/', ...source.getPages().filter((page) => page.url !== docsRoute).map((page) => page.url)];
  return paths.map((path) => ({ url: new URL(path, docsOrigin).href }));
}
