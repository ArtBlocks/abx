// `abx state`/`abx tokens` both gained an edition branch (kind-aware: supply/maxSupply per id
// instead of a single owner). No live edition fixture exists yet (P6 hasn't deployed the three
// edition factories anywhere), so the POSITIVE edition-formatting path isn't live-testable — these
// are regression guards that the 721 branch stays exactly what it was: run against the same live
// SeriesCode fixture edition-ownerops-live.test.ts uses, kind detection must route to the UNCHANGED
// 721 code path, never the new edition one.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

const CLI = resolve(import.meta.dirname, '../src/main.ts');
const SERIES_CODE_FIXTURE = '0xC75761FBC5291014963B7FF45760326E7429C2Ee'; // base-sepolia, kind: code

const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');

function run(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
      timeout: 30_000,
    });
    return {code: 0, out: plain(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: plain((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

test('state: a 721 (SeriesCode) target takes the unchanged 721 branch — no "edition" wording, header says "Series state"', () => {
  const {code, out} = run(['state', SERIES_CODE_FIXTURE]);
  assert.equal(code, 0);
  assert.match(out, /Series state/);
  assert.doesNotMatch(out, /\bedition\b/i);
});

test('state --json: a 721 target keeps the 721 payload shape (type series/1of1, totalSupply/nextTokenId present)', () => {
  const {code, out} = run(['state', SERIES_CODE_FIXTURE, '--json']);
  assert.equal(code, 0);
  const payload = JSON.parse(out);
  assert.equal(payload.type, 'series');
  assert.ok('totalSupply' in payload);
  assert.ok('nextTokenId' in payload);
  // The edition payload's own fields must NOT leak onto a 721 response.
  assert.ok(!('supply0' in payload));
  assert.ok(!('maxSupply0' in payload));
});

test('tokens --json: a 721 target keeps per-token `owner` (never `supply`/`maxSupply`)', () => {
  const {code, out} = run(['tokens', SERIES_CODE_FIXTURE, '--json', '--limit', '2']);
  assert.equal(code, 0);
  const listing = JSON.parse(out);
  assert.ok(Array.isArray(listing.tokens));
  for (const t of listing.tokens) {
    assert.ok('owner' in t);
    assert.ok(!('supply' in t), 'a 721 TokenRow must not carry the edition-only `supply` field');
    assert.ok(!('maxSupply' in t));
  }
});

test('tokens (human table): a 721 target\'s header/columns are unchanged ("owner" column, no "copies (cap)")', () => {
  const {code, out} = run(['tokens', SERIES_CODE_FIXTURE, '--limit', '1']);
  assert.equal(code, 0);
  assert.match(out, /owner/);
  assert.doesNotMatch(out, /copies \(cap\)/);
});

test('tokenuri: a 721 target reads tokenURI(id), never uri(id)', () => {
  const {code, out} = run(['tokenuri', SERIES_CODE_FIXTURE, '--token', '0']);
  assert.equal(code, 0);
  assert.match(out, /tokenURI\(0\)/);
});
