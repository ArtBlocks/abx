import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, Hex} from 'viem';
import {planEditionResume, planResume, type EditionResumeReader, type EditionSetupLegs, type ResumeReader, type SetupLegs} from '../src/resume.ts';

/**
 * `abx deploy-code --resume <addr>`.
 *
 * A code deploy is two transactions. When the second fails you own a live-but-unusable contract and
 * the CREATE2 salt reserved for its address is spent, so the dry run's pinned-salt reproduce command
 * can never be run again. One reporter session produced three orphaned contracts from three attempts;
 * another produced five. Those contracts were recoverable — a tester resent the setup by hand with
 * `cast` and `abx verify` then reported chain-complete — which is the argument for a verb.
 *
 * What these tests pin is the DIFF, because the diff is where a repair verb can do damage: re-minting
 * a token that already exists cannot be undone, and re-writing a schema is an upsert that can strand
 * stored values.
 */

const RENDERER = '0x857D2Ee19D13878F1E06A799A40c4dF2ed0F5312' as Address;
const REGISTRY = '0xf099C8fc301340dE2C4D1D2b76fcA05D852dF14A' as Address;
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/** Everything absent — the common case, since the setup multicall is atomic. */
const emptyChain: ResumeReader = {
  scriptChunkCount: async () => 0,
  scriptChunk: async () => null,
  schemaExists: async () => false,
  dependencyCount: async () => 0,
  dependencyRegistry: async () => null,
  tokenURIRenderer: async () => null,
  contractURIRenderer: async () => null,
  contractFieldSet: async () => false,
  totalSupply: async () => 0,
};

function legs(over: Partial<SetupLegs> = {}): SetupLegs {
  return {
    chunks: [
      {index: 0, hex: '0xaaaa' as Hex, data: '0xc0de00' as Hex},
      {index: 1, hex: '0xbbbb' as Hex, data: '0xc0de01' as Hex},
    ],
    schemas: [
      {key: 'palette', data: '0x5c11ae00' as Hex},
      {key: 'density', data: '0x5c11ae01' as Hex},
    ],
    deps: {count: 1, registry: REGISTRY, calls: ['0xdep0' as Hex, '0xdepreg' as Hex]},
    uri: {calls: ['0xur1' as Hex, '0xur2' as Hex, '0xur3' as Hex], animationField: 'animation_url'},
    mints: {intendedTotal: 3, data: '0x617a' as Hex},
    ...over,
  };
}

test('a fresh orphan (setup never landed) re-sends every leg, in the original order', async () => {
  const plan = await planResume(emptyChain, legs());
  assert.deepEqual(plan.calls, [
    '0xc0de00', '0xc0de01', // chunks
    '0x5c11ae00', '0x5c11ae01', // schemas
    '0xdep0', '0xdepreg', // dependencies
    '0xur1', '0xur2', '0xur3', // the on-chain URI legs
    '0x617a', '0x617a', '0x617a', // 3 mints
  ]);
  assert.deepEqual(plan.done, []);
  assert.equal(plan.sending.mints, 3);
  assert.deepEqual(plan.sending.chunkIndices, [0, 1]);
});

test('a fully-complete contract yields NO calls — the verb sends nothing rather than re-doing work', async () => {
  const complete: ResumeReader = {
    scriptChunkCount: async () => 2,
    scriptChunk: async (i) => (i === 0 ? ('0xaaaa' as Hex) : ('0xbbbb' as Hex)),
    schemaExists: async () => true,
    dependencyCount: async () => 1,
    dependencyRegistry: async () => REGISTRY,
    tokenURIRenderer: async () => RENDERER,
    contractURIRenderer: async () => RENDERER,
    contractFieldSet: async () => true,
    totalSupply: async () => 3,
  };
  const plan = await planResume(complete, legs());
  assert.deepEqual(plan.calls, []);
  assert.deepEqual(plan.todo, []);
  assert.equal(plan.done.length, 5); // one line per group, all reassuring
});

// ── the mint leg: a shortfall, never a re-send ─────────────────────────────────
// This is the one leg that is NOT idempotent. Getting it wrong mints extra tokens, and a token
// cannot be un-minted — so it is computed against current supply, not from the intended count.

test('mints are a SHORTFALL against current supply, not a re-send', async () => {
  const partlyMinted = {...emptyChain, totalSupply: async () => 2};
  const plan = await planResume(partlyMinted, legs());
  assert.equal(plan.sending.mints, 1); // 3 intended, 2 exist → 1 more
  assert.equal(plan.calls.filter((c) => c === '0x617a').length, 1);
  assert.match(plan.todo.join(' '), /mint 1 more token/);
});

test('supply ALREADY at or above the intended total mints nothing', async () => {
  for (const supply of [3, 4]) {
    const plan = await planResume({...emptyChain, totalSupply: async () => supply}, legs());
    assert.equal(plan.sending.mints, 0);
    assert.equal(plan.calls.includes('0x617a'), false);
    assert.match(plan.done.join(' '), /already minted/);
  }
});

test('no mints intended ⇒ supply is never even read', async () => {
  let read = false;
  const reader = {...emptyChain, totalSupply: async () => { read = true; return 0; }};
  const plan = await planResume(reader, legs({mints: {intendedTotal: 0, data: '0x617a' as Hex}}));
  assert.equal(read, false);
  assert.equal(plan.sending.mints, 0);
});

// ── chunks: compared by CONTENT ───────────────────────────────────────────────
// A count check would call a chunk "present" when a hand repair wrote different bytes at that index —
// and a hand repair with `cast` is exactly what the reporter did.

test('a chunk whose stored bytes DIFFER is re-sent, even though the index is occupied', async () => {
  const wrongBytes: ResumeReader = {
    ...emptyChain,
    scriptChunkCount: async () => 2,
    scriptChunk: async (i) => (i === 0 ? ('0xaaaa' as Hex) : ('0xdeadbeef' as Hex)), // index 1 is wrong
  };
  const plan = await planResume(wrongBytes, legs());
  assert.deepEqual(plan.sending.chunkIndices, [1]);
  assert.match(plan.todo.join(' '), /store 1 of 2 chunk\(s\).*indices 1/);
});

test('chunk comparison is case-insensitive on the hex — a checksum difference is not a difference', async () => {
  const upper: ResumeReader = {
    ...emptyChain,
    scriptChunkCount: async () => 2,
    scriptChunk: async (i) => (i === 0 ? ('0xAAAA' as Hex) : ('0xBBBB' as Hex)),
  };
  const plan = await planResume(upper, legs());
  assert.deepEqual(plan.sending.chunkIndices, []);
});

test('a partly-written script re-sends only the missing indices', async () => {
  const half: ResumeReader = {
    ...emptyChain,
    scriptChunkCount: async () => 1,
    scriptChunk: async (i) => (i === 0 ? ('0xaaaa' as Hex) : null),
  };
  const plan = await planResume(half, legs());
  assert.deepEqual(plan.sending.chunkIndices, [1]);
  assert.deepEqual(plan.sending.chunkBytes, [2]); // 0xbbbb = 2 bytes → the 200-gas/byte floor
});

// ── schemas: existence is the whole test ──────────────────────────────────────

test('an existing schema is NOT rewritten — an upsert here could strand stored values', async () => {
  const oneExists = {...emptyChain, schemaExists: async (k: string) => k === 'palette'};
  const plan = await planResume(oneExists, legs());
  assert.deepEqual(plan.sending.schemaKeys, ['density']);
  assert.equal(plan.calls.includes('0x5c11ae00'), false); // palette's leg is not sent
  assert.match(plan.todo.join(' '), /declare density/);
});

// ── the URI legs: all-or-nothing as a group ───────────────────────────────────

test('renderers set but the animation field missing still re-sends the group (the half-wired state)', async () => {
  const halfWired = {
    ...emptyChain,
    tokenURIRenderer: async () => RENDERER,
    contractURIRenderer: async () => RENDERER,
    contractFieldSet: async () => false,
  };
  const plan = await planResume(halfWired, legs());
  assert.equal(plan.sending.uri, true);
  assert.match(plan.todo.join(' '), /wire the metadata renderers/);
});

test('a dependency registry pointing somewhere else re-sends the dependency group', async () => {
  const otherRegistry = {
    ...emptyChain,
    dependencyCount: async () => 1,
    dependencyRegistry: async () => '0x1111111111111111111111111111111111111111' as Address,
  };
  const plan = await planResume(otherRegistry, legs());
  assert.equal(plan.sending.deps, true);
  assert.match(plan.todo.join(' '), /re-point the registry/);
});

// ── EditionCode: the per-id sibling ───────────────────────────────────────────
// The non-mint legs are the SAME diff as the 721 lane (planCoreLegs) — these tests pin only what's
// different: the mint leg is a per-id shortfall against totalSupply(id), one call per short id
// (not one call per missing copy — the edition mint takes the shortfall AS its amount argument).

/** Everything absent — mirrors `emptyChain` above, minus the whole-contract totalSupply. */
const emptyEditionChain: EditionResumeReader = {
  scriptChunkCount: async () => 0,
  scriptChunk: async () => null,
  schemaExists: async () => false,
  dependencyCount: async () => 0,
  dependencyRegistry: async () => null,
  tokenURIRenderer: async () => null,
  contractURIRenderer: async () => null,
  contractFieldSet: async () => false,
  totalSupplyForId: async () => 0,
};

function editionLegs(over: Partial<EditionSetupLegs> = {}): EditionSetupLegs {
  return {
    chunks: [
      {index: 0, hex: '0xaaaa' as Hex, data: '0xc0de00' as Hex},
      {index: 1, hex: '0xbbbb' as Hex, data: '0xc0de01' as Hex},
    ],
    schemas: [{key: 'palette', data: '0x5c11ae00' as Hex}],
    deps: {count: 0, registry: null, calls: []},
    uri: {calls: [], animationField: null},
    // Opaque per-(id,amount) tokens — not real calldata, just distinct strings a test can assert on.
    mints: [
      {id: 0n, intendedAmount: 3n, dataForAmount: (amount) => `0xmint-id0-amt${amount}` as Hex},
      {id: 1n, intendedAmount: 2n, dataForAmount: (amount) => `0xmint-id1-amt${amount}` as Hex},
    ],
    ...over,
  };
}

test('EditionCode: a fresh orphan mints the FULL intended amount, per id, in ONE call each', async () => {
  const plan = await planEditionResume(emptyEditionChain, editionLegs());
  assert.equal(plan.sending.mints, 2); // 2 ids short, 2 calls — not 5 (the sum of copies)
  assert.deepEqual(
    plan.calls.slice(-2),
    ['0xmint-id0-amt3', '0xmint-id1-amt2'], // id 0 → mint 3, id 1 → mint 2
  );
  assert.match(plan.todo.join(' '), /id 0: mint 3 more \(0 of 3 exist\)/);
  assert.match(plan.todo.join(' '), /id 1: mint 2 more \(0 of 2 exist\)/);
});

test('EditionCode: a partly-minted id sends only its SHORTFALL, as one call', async () => {
  const partial: EditionResumeReader = {
    ...emptyEditionChain,
    totalSupplyForId: async (id) => (id === 0n ? 1 : 0), // id 0 has 1 of 3; id 1 has none of 2
  };
  const plan = await planEditionResume(partial, editionLegs());
  assert.equal(plan.sending.mints, 2); // both ids still short, but id 0's call carries amount=2, not 3
  assert.equal(plan.calls.includes('0xmint-id0-amt2'), true); // id 0: shortfall 2, ONE call
  assert.equal(plan.calls.includes('0xmint-id1-amt2'), true); // id 1: shortfall 2
  assert.match(plan.todo.join(' '), /id 0: mint 2 more \(1 of 3 exist\)/);
});

test('EditionCode: an id already at or above its intended amount mints nothing for that id', async () => {
  const oneDone: EditionResumeReader = {
    ...emptyEditionChain,
    totalSupplyForId: async (id) => (id === 0n ? 3 : 0), // id 0 fully minted; id 1 still short
  };
  const plan = await planEditionResume(oneDone, editionLegs());
  assert.equal(plan.sending.mints, 1);
  assert.equal(plan.calls.includes('0xmint-id0-amt3'), false); // id 0's call never sent
  assert.equal(plan.calls.includes('0xmint-id1-amt2'), true);
  assert.match(plan.todo.join(' '), /id 1: mint 2 more/);
  assert.equal(plan.todo.join(' ').includes('id 0:'), false);
});

test('EditionCode: every premint id already fully minted ⇒ ONE reassuring done line, no calls', async () => {
  const complete: EditionResumeReader = {
    ...emptyEditionChain,
    totalSupplyForId: async (id) => (id === 0n ? 3 : 2),
  };
  // Chunks/schemas out of scope for this assertion (covered elsewhere) — isolate the mint leg.
  const plan = await planEditionResume(complete, editionLegs({chunks: [], schemas: []}));
  assert.deepEqual(plan.calls, []);
  assert.deepEqual(plan.todo, []);
  assert.equal(plan.sending.mints, 0);
  assert.match(plan.done.join(' '), /mints: all 2 premint id\(s\) already fully minted/);
});

test('EditionCode: no premint ids intended ⇒ totalSupplyForId is never even read', async () => {
  let read = false;
  const reader: EditionResumeReader = {...emptyEditionChain, totalSupplyForId: async () => { read = true; return 0; }};
  const plan = await planEditionResume(reader, editionLegs({mints: []}));
  assert.equal(read, false);
  assert.equal(plan.sending.mints, 0);
});

test('EditionCode: the non-mint legs diff IDENTICALLY to the 721 lane (shared planCoreLegs)', async () => {
  // Same chunk-content-mismatch scenario as the 721 "wrongBytes" test above, run through the
  // edition entry point — proves the two lanes can never drift on the legs they share.
  const wrongBytes: EditionResumeReader = {
    ...emptyEditionChain,
    scriptChunkCount: async () => 2,
    scriptChunk: async (i) => (i === 0 ? ('0xaaaa' as Hex) : ('0xdeadbeef' as Hex)),
  };
  const plan = await planEditionResume(wrongBytes, editionLegs({mints: []}));
  assert.deepEqual(plan.sending.chunkIndices, [1]);
  assert.match(plan.todo.join(' '), /store 1 of 2 chunk\(s\).*indices 1/);
});
