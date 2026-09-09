// `abx attach` — the data-plane verb (site/content/docs/protocol/data-plane.mdx). These cover the pure,
// correct-by-construction guards that make attaching a file safe without a chain: representation
// auto-detection from the URI scheme, the refusal of unrecognized locators, and the refusal of the
// COMPUTED manifest keys (`artifacts`/`abx_provenance`) — the exact round-1 agent trap (an agent saw
// `artifacts` in the served JSON and tried to SET it). The declared-type-from-extension ladder is
// exercised via the shared storage helper.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {assertSettableField, representationForLocator} from '../src/ownerops.js';
import {contentTypeFromPath} from '@artblocks/abx-storage';

test('representation auto-detects from the URI scheme', () => {
  assert.equal(representationForLocator('ipfs://QmPrintMaster/master.tiff'), 'ipfs');
  assert.equal(representationForLocator('ar://TXID/coa.pdf'), 'arweave');
  assert.equal(representationForLocator('https://cdn.example/master.tiff'), 'url');
  assert.equal(representationForLocator('http://host/file.png'), 'url');
  assert.equal(representationForLocator('  IPFS://QmX/x.png  '), 'ipfs'); // trimmed, case-insensitive
});

test('an unrecognized locator is refused, never silently stored', () => {
  assert.equal(representationForLocator('not-a-locator'), null);
  assert.equal(representationForLocator('QmBareCidNoScheme'), null);
  assert.equal(representationForLocator('data:image/png;base64,AAAA'), null); // inline data → set-field, not attach
});

test('the COMPUTED manifest keys are refused with a redirect to the real verb', () => {
  for (const k of ['artifacts', 'abx_provenance']) {
    assert.throws(() => assertSettableField(k), (e: Error) => {
      assert.match(e.message, /not a field you set/i);
      assert.match(e.message, /COMPUTED/);
      assert.match(e.message, /abx attach/); // points at the correct verb
      return true;
    }, `expected "${k}" to be refused`);
  }
});

// `abx_params` is refused for a DIFFERENT reason than the two above, and the distinction is the
// test: spec v8 removed the `abx_params` projection from `tokenURI`, so the name is no longer
// computed from anything — which makes it a better decoy, not a worse one. Params are chain state
// read off the contract, so a hand-set field of that name would be an impostor of a real read. The
// refusal therefore sends you to the param verbs rather than to `attach`.
test('abx_params is refused as a reserved name — not as a computed key — and names the param verb', () => {
  assert.throws(() => assertSettableField('abx_params'), (e: Error) => {
    assert.match(e.message, /not a field you set/i);
    assert.match(e.message, /reserved name/i);
    assert.doesNotMatch(e.message, /COMPUTED/); // it is not computed any more; saying so would be a lie
    return true;
  });
});

test('abx_params names the param verb', () => {
  assert.throws(() => assertSettableField('abx_params'), (e: Error) => {
    assert.match(e.message, /abx configure-param/);
    return true;
  });
});

test('any creator-chosen key is settable (the whole point of attach)', () => {
  for (const k of ['print', 'certificate', 'stems', 'readme', 'source', 'image']) {
    assert.doesNotThrow(() => assertSettableField(k), `expected "${k}" to be attachable`);
  }
});

test('declared mimeType comes from the URL extension (the on-chain field has no MIME slot)', () => {
  assert.equal(contentTypeFromPath('ipfs://QmPrintMaster/master.tiff'), 'image/tiff'); // added this cycle
  assert.equal(contentTypeFromPath('ipfs://QmCert/coa.pdf'), 'application/pdf');
  assert.equal(contentTypeFromPath('ar://TX/song.flac'), 'audio/flac');
  assert.equal(contentTypeFromPath('https://host/readme.md'), 'text/markdown; charset=utf-8');
  assert.equal(contentTypeFromPath('ipfs://QmNoExtension'), 'application/octet-stream'); // the honest floor → warned
});

// -- batching: N artifacts, ONE transaction ------------------------------------
// The documented flow -- mint, attach each artifact, refresh -- sent one
// transaction per step with no all-or-nothing boundary, so a failure partway left a permanently
// half-written token that cannot be un-minted. An integrator hit that and folded 8 operations into 1
// tx using the SDK's `batchOps`, which the CLI already shipped and did not use.
//
// Run the real binary: these guards are about the exit code and the message, and every one of them
// must fire BEFORE any chain read -- a bad locator in pair 5 has to stop pair 1 from being sent.

const CLI_MAIN = resolve(import.meta.dirname, '../src/main.ts');
const noAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function runCli(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI_MAIN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1', ABX_CHAIN: 'sepolia'},
    });
    return {code: 0, out: noAnsi(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: noAnsi((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

const BATCH_ADDR = '0xa9B8616396424A2dd54ceD71F27f51C3090Bf294';

test('two artifacts become ONE multicall - all-or-nothing, so no half-written token', () => {
  const {out} = runCli([
    'attach', BATCH_ADDR,
    'stems', 'ipfs://QmA/stems.wav',
    'score', 'ipfs://QmB/score.pdf',
    '--dry-run',
  ]);
  assert.match(out, /2 artifacts/);
  assert.match(out, /ONE transaction/);
  assert.match(out, /Batch 2 ops in one tx/);
  assert.match(out, /batched\s+2/);
});

test('ONE artifact still sends the plain field tx - no multicall wrapper, no behaviour change', () => {
  const {out} = runCli(['attach', BATCH_ADDR, 'stems', 'ipfs://QmA/stems.wav', '--dry-run']);
  assert.match(out, /Set on-chain stems/);
  assert.doesNotMatch(out, /Batch 1 ops/);
  assert.doesNotMatch(out, /ONE transaction/);
});

test('an odd number of positionals is refused, naming the stray one', () => {
  const {code, out} = runCli(['attach', BATCH_ADDR, 'stems', 'ipfs://QmA/stems.wav', 'score', '--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /pairs/i);
  assert.match(out, /"score"/);
});

test('a bad locator anywhere in the batch stops the whole batch', () => {
  // The point of batching is that a partial set never lands; validating only pair 1 would defeat it.
  const {code, out} = runCli([
    'attach', BATCH_ADDR,
    'stems', 'ipfs://QmA/stems.wav',
    'score', 'not-a-locator',
    '--dry-run',
  ]);
  assert.equal(code, 1);
  assert.match(out, /recognized file locator/);
});

test('the same key twice in one batch is refused rather than letting the last write win', () => {
  // A field holds ONE active value - the same full-column-upsert hazard that bit `register` and
  // `lock-field`. Silently keeping the second value is the class of bug, not a convenience.
  const {code, out} = runCli([
    'attach', BATCH_ADDR,
    'stems', 'ipfs://QmA/stems.wav',
    'stems', 'ipfs://QmB/other.wav',
    '--dry-run',
  ]);
  assert.equal(code, 1);
  assert.match(out, /same key appears twice/);
  assert.match(out, /last write would silently win/);
});
