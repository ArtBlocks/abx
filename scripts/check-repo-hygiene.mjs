import {execFileSync} from 'node:child_process';
import {existsSync, lstatSync, readFileSync} from 'node:fs';
import {basename, dirname, extname, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const errors = [];

const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
});
const repositoryFiles = output
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter((path) => existsSync(resolve(root, path)));

const forbiddenPaths = [
  '.claude/settings.local.json',
  '.claude/skills/dev-triage',
  '.agents/skills/dev-triage',
  'reviews',
  'docs/00-vision.md',
  'docs/01-architecture.md',
  'docs/02-protocol.md',
  'docs/03-sdk.md',
  'docs/04-self-host-toolkit.md',
  'docs/05-services-market.md',
  'docs/06-product-dimensions.md',
  'docs/07-user-journeys.md',
  'docs/08-requirements.md',
  'docs/09-open-questions.md',
];

for (const path of forbiddenPaths) {
  if (
    repositoryFiles.some(
      (repositoryPath) => repositoryPath === path || repositoryPath.startsWith(`${path}/`),
    )
  ) {
    errors.push(`internal-only path is included: ${path}`);
  }
}

const forbiddenNames = [
  /^\.DS_Store$/,
  /^\.env(?:\..+)?$/,
  /^settings\.local\.json$/,
  /(?:^|[-_.])(secret|credentials?)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:private-?)?key\.(?:json|pem|key)$/i,
];

for (const path of repositoryFiles) {
  const name = basename(path);
  if (name === '.env.example') continue;
  if (['package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'].includes(name)) {
    errors.push(`alternate package-manager lockfile is included: ${path}`);
  }
  if (forbiddenNames.some((pattern) => pattern.test(name))) {
    errors.push(`credential/local-state filename is tracked: ${path}`);
  }
  if (/\.(?:tgz|tar|zip)$/.test(name)) errors.push(`archive is tracked: ${path}`);
  if (/\.tsbuildinfo$/.test(name)) errors.push(`build cache is tracked: ${path}`);
  if (/(^|\/)(?:node_modules|dist|out|cache)(\/|$)/.test(path)) {
    errors.push(`generated directory is tracked: ${path}`);
  }
}

const quickstartPrompt =
  'Read https://docs.abx.io/docs/using-abx/quickstart, install the ABX skill, and help me launch ⟨describe your project⟩.';
for (const path of [
  'README.md',
  'site/lib/quickstart.ts',
]) {
  const normalized = readFileSync(resolve(root, path), 'utf8').replace(/\s+/g, ' ');
  if (!normalized.includes(quickstartPrompt)) {
    errors.push(`${path} must carry the canonical quickstart agent prompt`);
  }
}

for (const path of ['site/app/(home)/page.tsx', 'site/content/docs/using-abx/quickstart.mdx']) {
  const text = readFileSync(resolve(root, path), 'utf8');
  if (!text.includes("import {QUICKSTART_PROMPT} from '@/lib/quickstart';")) {
    errors.push(`${path} must import the canonical quickstart agent prompt`);
  }
}

if (readFileSync(resolve(root, 'CLAUDE.md'), 'utf8').trim() !== '@AGENTS.md') {
  errors.push('CLAUDE.md must import the canonical AGENTS.md guide');
}

const secretPatterns = [
  ['private-key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9_]{30,}/],
  ['npm token', /npm_[A-Za-z0-9]{30,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['credentialed URL', /https?:\/\/[^\s/:]+:[^\s@/]+@/],
  [
    'assigned EVM private key',
    /(?:PRIVATE_KEY|DEPLOYER_PK|FUNDED_PK)\s*=\s*["']?0x[0-9a-fA-F]{64}(?:["']|\s|$)/,
  ],
];

for (const path of repositoryFiles) {
  const absolute = resolve(root, path);
  if (!lstatSync(absolute).isFile()) continue;
  const bytes = readFileSync(absolute);
  if (bytes.length > 2_000_000 || bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const [label, pattern] of secretPatterns) {
    if (
      label === 'credentialed URL' &&
      path.includes('/test/') &&
      text.includes(['https:', '//user:pass@host.example'].join(''))
    ) {
      continue;
    }
    if (pattern.test(text)) errors.push(`possible ${label}: ${path}`);
  }
}

for (const name of ['cli', 'effects', 'indexer', 'sdk', 'storage', 'storage-arweave', 'token-api']) {
  const path = `packages/${name}/package.json`;
  const pkg = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  if (pkg.license !== 'MIT') errors.push(`${path} must declare license MIT`);
  if (pkg.bugs !== 'https://github.com/ArtBlocks/abx/issues') {
    errors.push(`${path} must direct bugs to the public issue tracker`);
  }
}

const markdownExtensions = new Set(['.md', '.mdx']);
const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
for (const path of repositoryFiles) {
  if (!markdownExtensions.has(extname(path))) continue;
  const text = readFileSync(resolve(root, path), 'utf8');
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (
      target.startsWith('#') ||
      target.startsWith('/') ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      continue;
    }
    const clean = decodeURIComponent(target.split('#', 1)[0]);
    if (!clean) continue;
    const destination = resolve(root, dirname(path), clean);
    if (!existsSync(destination)) errors.push(`broken relative link: ${path} -> ${target}`);
  }
}

if (errors.length) {
  console.error('Repository hygiene check failed:');
  for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Repository hygiene check passed (${repositoryFiles.length} repository files inspected).`);
