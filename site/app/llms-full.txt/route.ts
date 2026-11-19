import { QUICKSTART_PATH } from '@/lib/quickstart';
import { getLLMText, source } from '@/lib/source';

export const revalidate = false;

export async function GET() {
  const pages = source.getPages().toSorted((a, b) => Number(b.url === QUICKSTART_PATH) - Number(a.url === QUICKSTART_PATH));
  const scanned = await Promise.all(pages.map(getLLMText));

  return new Response(scanned.join('\n\n'));
}
