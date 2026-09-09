// resolveDataDir: the ONE fallback `.abx-self-host` resolution every self-host
// consumer (CLI, indexer, storage) now shares, plus the bounded upward-discovery rule a READ path
// may opt into. See node.ts's doc comment for the full rationale — this is the regression guard
// for its contract: ABX_DATA_DIR always wins, discovery is bounded (home dir / repo root /
// filesystem root, checked but never crossed), cwd's own directory always wins over a discovered
// ancestor, and nothing is ever silently merged (the first hit wins outright).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {resolveDataDir} from '../src/node.js';

function scratch(): {root: string; cleanup: () => void} {
  const root = mkdtempSync(join(tmpdir(), 'abx-datadir-'));
  return {root, cleanup: () => rmSync(root, {recursive: true, force: true})};
}

const dir = (...parts: string[]) => {
  const p = join(...parts);
  mkdirSync(p, {recursive: true});
  return p;
};

test('ABX_DATA_DIR always wins — discovery never runs, even with a real cwd/.abx-self-host present', () => {
  const {root, cleanup} = scratch();
  try {
    const cwd = dir(root, 'proj');
    dir(root, 'proj', '.abx-self-host'); // exists at cwd too — env still wins outright
    const pinned = dir(root, 'elsewhere');
    const r = resolveDataDir({cwd, env: {ABX_DATA_DIR: pinned}, allowUpwardDiscovery: true});
    assert.deepEqual(r, {dir: resolve(pinned), source: 'env'});
  } finally {
    cleanup();
  }
});

test('no env, no discovery opt-in: plain cwd default, even when a parent has one', () => {
  const {root, cleanup} = scratch();
  try {
    dir(root, 'proj', '.abx-self-host');
    const cwd = dir(root, 'proj', 'sub');
    const r = resolveDataDir({cwd, env: {}}); // allowUpwardDiscovery omitted — the write-path default
    assert.deepEqual(r, {dir: resolve(cwd, '.abx-self-host'), source: 'cwd'});
  } finally {
    cleanup();
  }
});

test('discovery opt-in, but cwd already has its own directory: cwd wins, no upward search happens', () => {
  const {root, cleanup} = scratch();
  try {
    dir(root, '.abx-self-host'); // a parent ALSO has one
    const cwd = dir(root, 'proj');
    dir(cwd, '.abx-self-host');
    const r = resolveDataDir({cwd, env: {}, allowUpwardDiscovery: true});
    assert.deepEqual(r, {dir: resolve(cwd, '.abx-self-host'), source: 'cwd'});
  } finally {
    cleanup();
  }
});

test('subdirectory test: a child directory with no data dir of its own finds the parent project\'s', () => {
  const {root, cleanup} = scratch();
  try {
    const parentDataDir = dir(root, 'proj', '.abx-self-host');
    const cwd = dir(root, 'proj', 'contracts', 'src'); // a few levels deep
    const r = resolveDataDir({cwd, env: {}, allowUpwardDiscovery: true, home: root});
    assert.deepEqual(r, {dir: resolve(parentDataDir), source: 'discovered'});
  } finally {
    cleanup();
  }
});

test('parent-directory test: running one level ABOVE the project also finds nothing new (own cwd check first) — and a plain sibling finds nothing', () => {
  const {root, cleanup} = scratch();
  try {
    dir(root, 'proj', '.abx-self-host');
    const cwd = dir(root, 'unrelated-sibling'); // not an ancestor of proj at all
    const r = resolveDataDir({cwd, env: {}, allowUpwardDiscovery: true, home: root});
    // `root` (the walk's boundary here) has no `.abx-self-host` of its own, and `proj` is a
    // SIBLING, not an ancestor — never on the upward path from `unrelated-sibling`.
    assert.deepEqual(r, {dir: resolve(cwd, '.abx-self-host'), source: 'cwd'});
  } finally {
    cleanup();
  }
});

test('bounded at the user\'s home directory: checked (found if present there)…', () => {
  const {root, cleanup} = scratch();
  try {
    const home = dir(root, 'home');
    dir(home, '.abx-self-host');
    const cwd = dir(home, 'work', 'proj');
    const r = resolveDataDir({cwd, env: {}, allowUpwardDiscovery: true, home});
    assert.deepEqual(r, {dir: resolve(home, '.abx-self-host'), source: 'discovered'});
  } finally {
    cleanup();
  }
});

test('…but never crossed: a data dir ABOVE home is invisible to a search starting below it', () => {
  const {root, cleanup} = scratch();
  try {
    dir(root, '.abx-self-host'); // sits ABOVE the fake home
    const home = dir(root, 'home'); // home itself has none
    const cwd = dir(home, 'work', 'proj');
    const r = resolveDataDir({cwd, env: {}, allowUpwardDiscovery: true, home});
    assert.deepEqual(r, {dir: resolve(cwd, '.abx-self-host'), source: 'cwd'});
  } finally {
    cleanup();
  }
});

test('bounded at a repository root (.git): a data dir ABOVE the repo is invisible from inside it', () => {
  const {root, cleanup} = scratch();
  try {
    dir(root, '.abx-self-host'); // sits ABOVE the repo
    const repo = dir(root, 'repo');
    dir(repo, '.git');
    const cwd = dir(repo, 'contracts', 'src'); // deep inside the repo, no data dir anywhere in it
    const r = resolveDataDir({cwd, env: {}, allowUpwardDiscovery: true, home: '/nonexistent-home-not-on-this-path'});
    assert.deepEqual(r, {dir: resolve(cwd, '.abx-self-host'), source: 'cwd'});
  } finally {
    cleanup();
  }
});

test('the repo root itself is still checked, just never crossed', () => {
  const {root, cleanup} = scratch();
  try {
    const repo = dir(root, 'repo');
    dir(repo, '.git');
    const repoDataDir = dir(repo, '.abx-self-host'); // the repo root's OWN data dir
    dir(root, '.abx-self-host'); // a decoy one level further up — must not be the answer
    const cwd = dir(repo, 'contracts', 'src');
    const r = resolveDataDir({cwd, env: {}, allowUpwardDiscovery: true, home: '/nonexistent-home-not-on-this-path'});
    assert.deepEqual(r, {dir: resolve(repoDataDir), source: 'discovered'});
  } finally {
    cleanup();
  }
});
