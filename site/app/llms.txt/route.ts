import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';
import { ABX_LLMS_CONTEXT, ABX_SUMMARY } from '@/lib/about';

export const revalidate = false;

export async function GET() {
  const header = `# ABX\n\n> ${ABX_SUMMARY}\n\n${ABX_LLMS_CONTEXT}\n\n`;
  // llms.txt allows one H1; demote the generated index's root heading beneath the ABX title.
  const index = (await llms(source).index()).replace(/^# /, '## ');
  return new Response(header + index);
}
