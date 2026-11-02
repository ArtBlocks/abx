import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {CHAIN_SUPPORT, isChainSelectable} from '../../sdk/src/chain-support.js';

// The shipped agent skill is prose, so nothing type-checks it — but it is the product membrane, and
// its dispatch metadata, progressive-disclosure budget, routing, and known drift phrases are
// mechanical enough to pin here.
//
// (1) An orphaned reference file. References must be reachable from SKILL.md, directly or through
//     a task-specific router; a file nobody links to is a file no agent ever reads. capabilities.md —
//     added after three sessions in one week where an agent told a creator ABX could not do something
//     it does — matters most, because it is consulted when an agent is about to say no.
// (2) A dead relative link. Renaming a reference file silently breaks every pointer into it, and the
//     agent's fallback when a link fails is to answer from its own priors. That is the exact failure
//     this skill exists to prevent.

const SKILL = resolve(import.meta.dirname, '../../../.claude/skills/abx');
const skillMd = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');

function referenceFiles(directory = 'reference'): string[] {
  return readdirSync(join(SKILL, directory), {withFileTypes: true}).flatMap((entry) => {
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? referenceFiles(name) : entry.name.endsWith('.md') ? [name] : [];
  });
}

const referenceDocs = referenceFiles().map((name) => [name, readFileSync(join(SKILL, name), 'utf8')] as const);
const skillDocs = [['SKILL.md', skillMd], ...referenceDocs] as const;

function markdownTargets(name: string, body: string): string[] {
  return [...body.matchAll(/\]\((?!https?:)([^)#\s]+\.md)(?:#[^)\s]*)?\)/g)]
    .map(([, target]) => resolve(dirname(join(SKILL, name)), target));
}

test('skill metadata satisfies the Agent Skills dispatch contract', () => {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1] ?? '';
  const name = /(?:^|\n)name:\s*([^\n]+)/.exec(front)?.[1].trim();
  const description = /(?:^|\n)description:\s*([^\n]+)/.exec(front)?.[1].trim() ?? '';
  assert.equal(name, 'abx', 'folder and frontmatter name must match');
  assert.ok(description.length > 0, 'description drives skill selection');
  assert.ok(description.length <= 1024, `description is ${description.length} characters; Agent Skills allows at most 1024`);
});

test('the always-loaded router stays lean', () => {
  const lines = skillMd.split('\n').length;
  const words = skillMd.trim().split(/\s+/).length;
  assert.ok(lines <= 300, `SKILL.md grew to ${lines} lines; move detail into a routed reference`);
  assert.ok(words <= 4000, `SKILL.md grew to ${words} words; keep the router under the progressive-disclosure budget`);
});

test('every reference is reachable from SKILL.md through the reference graph', () => {
  assert.ok(referenceDocs.length > 0, 'reference/ should not be empty');
  const docsByPath = new Map(skillDocs.map(([name, body]) => [resolve(SKILL, name), {name, body}]));
  const pending = [resolve(SKILL, 'SKILL.md')];
  const reachable = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (reachable.has(path)) continue;
    reachable.add(path);
    const doc = docsByPath.get(path);
    if (doc) pending.push(...markdownTargets(doc.name, doc.body));
  }
  for (const [name] of referenceDocs) {
    assert.ok(reachable.has(resolve(SKILL, name)), `${name} has no route from SKILL.md`);
  }
});

test('every relative .md link in the skill resolves to a real file', () => {
  const broken: string[] = [];
  for (const [name, body] of skillDocs) {
    for (const target of markdownTargets(name, body)) {
      if (!existsSync(target)) broken.push(`${name} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], `dead links in the skill: ${broken.join(' | ')}`);
});

test('every selectable network has ecosystem context linked from the topic router', () => {
  const router = 'reference/ecosystem.md';
  const routes = markdownTargets(router, readFileSync(join(SKILL, router), 'utf8'));
  for (const chain of CHAIN_SUPPORT.filter(isChainSelectable)) {
    const path = resolve(SKILL, 'reference/ecosystem/chains', `${chain.key}.md`);
    assert.ok(routes.includes(path), `${chain.name} needs its own routed ecosystem context`);
    assert.ok(existsSync(path), `${chain.name} ecosystem context is missing`);
  }
});

test('long references expose a table of contents', () => {
  for (const [file, body] of referenceDocs) {
    if (body.split('\n').length > 100) {
      assert.match(body, /^## Contents$/m, `${file} is over 100 lines and needs a Contents map`);
    }
  }
});

test('the capability gate is wired: SKILL.md routes to capabilities.md, which names all four seams', () => {
  // The gate is what fires before an agent says "not possible". If either half goes missing the
  // skill silently reverts to answering capability questions off the command list.
  assert.match(skillMd, /capabilities\.md/, 'SKILL.md must route to the capability reference');
  const caps = readFileSync(join(SKILL, 'reference/capabilities.md'), 'utf8');
  for (const seam of ['set-minter', '--configure', '--transfer', '--augment']) {
    assert.ok(caps.includes(seam), `capabilities.md must name the ${seam} seam`);
  }
  for (const classification of ['Native', 'Extension', 'Unsupported/foreclosed', 'Unknown']) {
    assert.ok(caps.includes(classification), `capabilities.md must preserve the ${classification} classification`);
  }
  assert.match(skillMd, /Bytes:Creator/, 'SKILL.md must name the shared-program + per-token payload lane');
  assert.match(caps, /Bytes:Creator/, 'capabilities.md must map that shape to a native lane');
  assert.match(caps, /mint, then set the creator payload with `configure-param --file`/);
  assert.doesNotMatch(caps, /payload at mint/, 'the CLI has no mint-time payload flag');
});

test('known stale contradictions cannot re-enter the router or references', () => {
  const corpus = skillDocs.map(([, body]) => body).join('\n');
  for (const stale of [
    /Node\s*(?:≥|>=)\s*22\.5/i,
    /deploy-code --copies[^\n]*script-only/i,
    /no zero-infrastructure code drop/i,
    /fully on-chain[^\n]*small content only/i,
    /if it is on neither[^\n]*it is possible/i,
  ]) {
    assert.doesNotMatch(corpus, stale);
  }
});

test('Codex UI metadata matches the renamed skill', () => {
  const yaml = readFileSync(join(SKILL, 'agents', 'openai.yaml'), 'utf8');
  assert.match(yaml, /display_name: "ABX"/);
  assert.match(yaml, /default_prompt: "Use \$abx\b/);
});

test('the compressed router preserves chain and burn supply semantics', () => {
  assert.match(skillMd, /ABX_CHAIN=<chain>/);
  assert.match(skillMd, /ERC-721 Series cap is lifetime minted ids/);
  assert.match(skillMd, /ERC-1155 edition's[\s\S]*cap is live supply/);
});

test('setup gives the automatic scoped migration command instead of inviting a manual merge', () => {
  const setup = readFileSync(join(SKILL, 'reference/setup.md'), 'utf8');
  assert.match(setup, /abx skill install --target <that-parent>/);
  assert.match(setup, /do not move or merge/);
});
