import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';
// Fumadocs resolves these names through the Phosphor build of lucide-react.
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { QUICKSTART_PATH, QUICKSTART_PROMPT } from './quickstart';
import { docsContentRoute, docsRoute } from './shared';

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

export function getPageMarkdownUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'content.md'];

  return {
    segments,
    url: '/' + [page.locale, ...docsContentRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

export async function getLLMText(page: (typeof source)['$inferPage']) {
  const processed = await page.data.getText('processed');
  // Fumadocs preserves MDX components as markup in text exports. Give the copy card a plain-text
  // rendering using the same prompt as the HTML page.
  const markdown = page.url === QUICKSTART_PATH
    ? processed.replace(/^<PromptCard\s+prompt=\{QUICKSTART_PROMPT\}\s*\/>$/m, () => `\`\`\`text
${QUICKSTART_PROMPT}
\`\`\``)
    : processed;

  return `# ${page.data.title} (${page.url})

${markdown}`;
}
