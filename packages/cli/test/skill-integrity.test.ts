import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';

// The shipped agent skill is prose, so nothing type-checks it — but it is the product membrane, and
// its dispatch metadata, progressive-disclosure budget, routing, and known drift phrases are
// mechanical enough to pin here.
//
// (1) An orphaned reference file. `reference/*.md` is only reachable via the routing table in
//     SKILL.md; a file nobody links to is a file no agent ever reads. capabilities.md — added after
//     three sessions in one week where an agent told a creator ABX could not do something it does —
//     is the one that matters most, because it is only consulted when an agent is about to say no.
// (2) A dead relative link. Renaming a reference file silently breaks every pointer into it, and the
//     agent's fallback when a link fails is to answer from its own priors. That is the exact failure
//     this skill exists to prevent.

const SKILL = resolve(import.meta.dirname, '../../../.claude/skills/abx');
const skillMd = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');

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

test('every reference file is registered in SKILL.md — an unlinked one is never read', () => {
  const files = readdirSync(join(SKILL, 'reference')).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'reference/ should not be empty');
  for (const f of files) {
    assert.ok(skillMd.includes(`reference/${f}`), `reference/${f} is not linked from SKILL.md — no agent will ever open it`);
  }
});

test('every relative .md link in the skill resolves to a real file', () => {
  const docs = [
    ['SKILL.md', skillMd],
    ...readdirSync(join(SKILL, 'reference'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => [`reference/${f}`, readFileSync(join(SKILL, 'reference', f), 'utf8')] as const),
  ] as const;

  const broken: string[] = [];
  for (const [name, body] of docs) {
    for (const [, target] of body.matchAll(/\]\((?!https?:)([^)#\s]+\.md)(?:#[^)\s]*)?\)/g)) {
      const from = dirname(join(SKILL, name));
      if (!existsSync(resolve(from, target))) broken.push(`${name} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], `dead links in the skill: ${broken.join(' | ')}`);
});

test('long references expose a table of contents', () => {
  for (const file of readdirSync(join(SKILL, 'reference')).filter((f) => f.endsWith('.md'))) {
    const body = readFileSync(join(SKILL, 'reference', file), 'utf8');
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
  const corpus = [
    skillMd,
    ...readdirSync(join(SKILL, 'reference'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(SKILL, 'reference', f), 'utf8')),
  ].join('\n');
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
