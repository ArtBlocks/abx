// Library linking + the CREATE2 bootstrap of the four library-linked factories.
//
// Linking is a POST-COMPILE substitution: solc leaves `__$<id>$__` where a delegatecalled library's
// address goes, and we write the address in. That is why linking costs nothing in determinism — the
// libraries themselves are CREATE2'd through the keyless proxy at canonical salts, so the linked
// factory's initcode is fixed too, and a forge-bootstrapped chain and an SDK-bootstrapped chain land
// on the same addresses. (The repo believed the opposite for a while, and paid for it: see
// create2.ts's write-path-library note.) The invariants here:
//   1. the shipped bytecode still ships UNLINKED (so substitution is real, not a no-op)
//   2. `AbxEditionLib` needs linking too — its own bytecode delegatecalls `AbxParamsLib`, which is
//      what made `deployEditionCodeFactory` die with `Invalid byte sequence` when it deployed the
//      library raw
//   3. no bootstrap leg is a plain `CREATE`: every one is `to: CREATE2_PROXY` with `salt ++ initcode`
//   4. the GENERALIZED guard at the bottom of this file: no `predict*` may hash — and no send path
//      may transmit — bytecode that still carries a placeholder, for ANY contract, derived from the
//      SDK's own exports rather than from a list of names. See that section's own note for why the
//      by-name guards above are not enough.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Address, Hex, PublicClient} from 'viem';
import {
  abxEditionLibBytecode,
  abxParamsLibBytecode,
  editionCodeFactoryBytecode,
  editionImageFactoryBytecode,
  oneOfOneEditionFactoryBytecode,
  seriesCodeFactoryBytecode,
} from '../src/abi/generated.js';
import * as generated from '../src/abi/generated.js';
import {
  ABX_SALT,
  CREATE2_PROXY,
  LIB_FQN,
  create2Calldata,
  libPlaceholder,
  linkEditionCodeFactory,
  linkEditionFactory,
  linkEditionLib,
  linkLibraries,
  linkOneOfOneEditionFactory,
  linkSeriesCodeFactory,
  predictCodeLib,
  predictCreate2Address,
  predictEditionCodeFactory,
  predictEditionLib,
  predictMetadataLib,
  predictParamsLib,
  predictSeriesCodeFactory,
} from '../src/create2.js';
import * as create2 from '../src/create2.js';
import {deploySeriesCodeFactory, deployEditionCodeFactory} from '../src/deploy.js';
import * as deployModule from '../src/deploy.js';
import * as chunksModule from '../src/chunks.js';
import * as ops from '../src/ops.js';

const SEPOLIA = 11155111;

test('factory bytecode placeholders match the computed library ids, and linking clears them', () => {
  const params = libPlaceholder(LIB_FQN.paramsLib);
  const code = libPlaceholder(LIB_FQN.codeLib);
  const edition = libPlaceholder(LIB_FQN.editionLib);
  assert.ok(seriesCodeFactoryBytecode.includes(params), 'AbxParamsLib placeholder present (SeriesCodeFactory)');
  assert.ok(seriesCodeFactoryBytecode.includes(code), 'AbxCodeLib placeholder present (SeriesCodeFactory)');
  assert.ok(editionCodeFactoryBytecode.includes(params), 'AbxParamsLib placeholder present (EditionCodeFactory)');
  assert.ok(editionCodeFactoryBytecode.includes(code), 'AbxCodeLib placeholder present (EditionCodeFactory)');
  assert.ok(editionCodeFactoryBytecode.includes(edition), 'AbxEditionLib placeholder present (EditionCodeFactory)');
  assert.ok(!linkSeriesCodeFactory().includes('__$'), 'no unlinked placeholders remain (SeriesCodeFactory)');
  assert.ok(!linkEditionCodeFactory().includes('__$'), 'no unlinked placeholders remain (EditionCodeFactory)');
});

test('the ERC-1155 image factories link AbxEditionLib too — the round-2 remediation, and the third instance of this bug', () => {
  // `OneOfOneEdition`/`EditionImage` were held library-free on purpose, then delegated their
  // Uri1155/CreatorToken1155/EditionSupply bodies into `AbxEditionLib` for EIP-170 relief — which
  // means their FACTORIES became library-linked, and the SDK kept hashing the unlinked bytecode.
  const edition = libPlaceholder(LIB_FQN.editionLib);
  assert.ok(oneOfOneEditionFactoryBytecode.includes(edition), 'AbxEditionLib placeholder present (OneOfOneEditionFactory)');
  assert.ok(editionImageFactoryBytecode.includes(edition), 'AbxEditionLib placeholder present (EditionImageFactory)');
  assert.ok(!linkOneOfOneEditionFactory().includes('__$'), 'no unlinked placeholders remain (OneOfOneEditionFactory)');
  assert.ok(!linkEditionFactory().includes('__$'), 'no unlinked placeholders remain (EditionImageFactory)');
  // Both link the SAME library copy — one AbxEditionLib per chain, shared with EditionCode.
  for (const linked of [linkOneOfOneEditionFactory(), linkEditionFactory(), linkEditionCodeFactory()]) {
    assert.ok(linked.toLowerCase().includes(predictEditionLib().slice(2).toLowerCase()), 'linked against the canonical AbxEditionLib');
  }
});

test('AbxEditionLib is itself unlinked — deploying it raw is the `Invalid byte sequence` bug', () => {
  // The regression this file was extended for. `abxEditionLibBytecode` is NOT valid hex as shipped;
  // only `linkEditionLib()` is deployable, and it must link against the address AbxParamsLib will
  // actually occupy (not a placeholder, and not some other build's address).
  assert.ok(abxEditionLibBytecode.includes(libPlaceholder(LIB_FQN.paramsLib)), 'AbxEditionLib links AbxParamsLib');
  const linked = linkEditionLib();
  assert.ok(!linked.includes('__$'), 'linkEditionLib() clears the placeholder');
  assert.ok(/^0x[0-9a-fA-F]+$/.test(linked), 'linked AbxEditionLib initcode is valid hex');
  assert.ok(linked.toLowerCase().includes(predictParamsLib().slice(2).toLowerCase()), 'linked against the canonical AbxParamsLib');
});

test('linkLibraries refuses to hand back bytecode with a placeholder left in it', () => {
  assert.throws(
    () => linkLibraries(editionCodeFactoryBytecode, [[LIB_FQN.paramsLib, `0x${'11'.repeat(20)}`]]),
    /unlinked library placeholder remains/,
  );
});

test('the library + factory predictions are pure and distinct (cross-chain-identical by construction)', () => {
  assert.equal(predictParamsLib(), predictParamsLib());
  assert.equal(predictEditionLib(), predictEditionLib());
  const all = [predictParamsLib(), predictCodeLib(), predictEditionLib(), predictSeriesCodeFactory(), predictEditionCodeFactory()];
  assert.equal(new Set(all).size, all.length, 'five distinct addresses (distinct salts and/or initcode)');
});

// ── the bootstrap legs: CREATE2 through the keyless proxy, never a plain creation ──

type Sent = {op: string; to: Address | null; data: Hex};

/** A PublicClient stub: `hasCode` decides which addresses already have code. */
function fakeClient(hasCode: (address: string) => boolean): PublicClient {
  return {
    getChainId: async () => SEPOLIA,
    getCode: async ({address}: {address: string}) => (hasCode(address) ? '0x60006000' : '0x'),
    readContract: async () => `0x${'11'.repeat(20)}` as Address, // `implementation()` / `specVersion()`
  } as unknown as PublicClient;
}

function recorder(): {sent: Sent[]; send: (tx: {op: string; to: Address | null; data: Hex}) => Promise<unknown>} {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (tx) => {
      sent.push({op: tx.op, to: tx.to, data: tx.data});
      // `contractAddress` is non-null so the plain-creation deployers (which assert on it) run to
      // completion here; the CREATE2 ones compute their address and ignore this field.
      return {transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: 1n, contractAddress: `0x${'22'.repeat(20)}`};
    },
  };
}

test('deploySeriesCodeFactory: 3 libraries + the factory, all CREATE2 at the canonical salts', async () => {
  const {sent, send} = recorder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await deploySeriesCodeFactory(send as any, fakeClient(() => false));
  assert.deepEqual(
    sent.map((s) => s.op),
    ['deploy-metadata-lib', 'deploy-params-lib', 'deploy-code-lib', 'deploy-series-code-factory'],
  );
  for (const s of sent) assert.equal(s.to, CREATE2_PROXY, `${s.op} must not be a plain creation`);
  assert.equal(sent[1].data, create2Calldata(ABX_SALT.paramsLib, abxParamsLibBytecode));
  assert.equal(sent[3].data, create2Calldata(ABX_SALT.seriesCodeFactory, linkSeriesCodeFactory()));
  assert.equal(r.paramsLib, predictParamsLib());
  assert.equal(r.codeLib, predictCodeLib());
  assert.equal(r.factory, predictSeriesCodeFactory()); // predictable, and identical on every chain
});

test('deployEditionCodeFactory: 4 libraries + the factory, and AbxEditionLib goes out LINKED', async () => {
  const {sent, send} = recorder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await deployEditionCodeFactory(send as any, fakeClient(() => false));
  assert.deepEqual(
    sent.map((s) => s.op),
    ['deploy-metadata-lib', 'deploy-params-lib', 'deploy-code-lib', 'deploy-edition-lib', 'deploy-edition-code-factory'],
  );
  for (const s of sent) {
    assert.equal(s.to, CREATE2_PROXY, `${s.op} must not be a plain creation`);
    assert.ok(!s.data.includes('__$'), `${s.op} initcode must be linked (this is the Invalid-byte-sequence guard)`);
  }
  assert.equal(sent[3].data, create2Calldata(ABX_SALT.editionLib, linkEditionLib()));
  assert.equal(r.editionLib, predictEditionLib());
  assert.equal(r.factory, predictEditionCodeFactory());
});

test('libraries already on-chain are reused, not redeployed (the proxy reverts on an occupied address)', async () => {
  const {sent, send} = recorder();
  const existing = new Set([
    predictMetadataLib().toLowerCase(),
    predictParamsLib().toLowerCase(),
    predictCodeLib().toLowerCase(),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await deployEditionCodeFactory(send as any, fakeClient((a) => existing.has(a.toLowerCase())));
  assert.deepEqual(
    sent.map((s) => s.op),
    ['deploy-edition-lib', 'deploy-edition-code-factory'],
    'the two libraries forge already deployed are linked against, not redeployed',
  );
  assert.equal(r.paramsLib, predictParamsLib());
  assert.equal(r.codeLib, predictCodeLib());
});

test('an occupied factory address is refused in words, not by an opaque proxy revert', async () => {
  const {send} = recorder();
  const taken = new Set([predictSeriesCodeFactory().toLowerCase()]);
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deploySeriesCodeFactory(send as any, fakeClient((a) => taken.has(a.toLowerCase()))),
    /already deployed at its canonical address/,
  );
});

// ── the generalized guard: nothing the SDK predicts or sends may carry a placeholder ──
//
// **Why this exists, and why it is not written as a list of contract names.** Three separate times
// a contract became library-linked and the SDK went on using its UNLINKED bytecode: `SeriesCode`,
// then `EditionCode` (whose LIBRARY was also unlinked), then `OneOfOneEdition`/`EditionImage` in the
// round-2 EIP-170 remediation. Each time the by-name guards above were extended to cover exactly the
// contracts that had already broken, so the next one broke the same way.
//
// The failure is silent, which is what makes it dangerous. viem does not reject a string containing
// `__$<34 hex>$__` — it UTF-8-encodes it — so `predictCreate2Address` returns a perfectly
// plausible-looking address that is the keccak of ASCII garbage, for a TRUST ANCHOR (the address
// platforms allowlist), and the same bytes would go out as initcode: a contract whose delegatecalls
// go nowhere, or a rejected transaction.
//
// So these tests derive their subject set from the SDK's OWN exports — every `predict*` in
// create2.ts, every `prepareDeploy*` in ops.ts, every `deploy*(send, client)` orchestrator in
// deploy.ts/chunks.ts — and never from a literal list. A newly library-linked contract is covered
// the moment it has a prediction or a deploy path, with no edit to this file.

/** The solc placeholder shape, in the caller's bytecode: `__$` + 34 hex + `$__` = 40 chars, exactly
 *  the width of the 20-byte address that replaces it (which is why linking preserves length). */
const PLACEHOLDER_RE = /__\$[0-9a-f]{34}\$__/g;

/** The DISTINCT solc placeholders left in `hex` — deduped so a failure names the libraries, not the
 *  couple of hundred call sites that reference each one. */
const placeholdersIn = (hex: string): string[] => [...new Set(hex.match(PLACEHOLDER_RE) ?? [])];

/** Every `<name>Bytecode` the generated ABI surface exports, as [exportName, bytecode] pairs. */
const generatedBytecodes: Array<readonly [string, Hex]> = Object.entries(generated)
  .filter((e): e is [string, Hex] => e[0].endsWith('Bytecode') && typeof e[1] === 'string')
  .sort();

/** Every zero-arg `predict*` create2.ts exports (the SDK's full claimed-address surface). The
 *  arity filter drops `predictCreate2Address(salt, bytecode)`, which is the primitive, not a claim. */
const predictors: Array<readonly [string, () => Address]> = Object.entries(create2)
  .filter((e): e is [string, () => Address] => /^predict[A-Z]/.test(e[0]) && typeof e[1] === 'function' && e[1].length === 0)
  .sort();

/** Every zero-arg `link*` create2.ts exports (the SDK's full canonical-initcode surface). */
const linkers: Array<readonly [string, () => Hex]> = Object.entries(create2)
  .filter((e): e is [string, () => Hex] => /^link[A-Z]/.test(e[0]) && typeof e[1] === 'function' && e[1].length === 0)
  .sort();

test('every predict* hashes LINKED initcode — identified by reconstruction, not by a name list', () => {
  assert.ok(predictors.length >= 14, `expected the full predict* surface, found ${predictors.length}`);
  // Every initcode the SDK could plausibly be hashing: each raw generated bytecode (the WRONG answer
  // for a library-linked contract) and each `link*()` result (the right one). Reconstructing which
  // one a `predict*` actually used is what lets this test NAME the offending contract instead of
  // just saying "an address changed".
  const candidates: Array<{initcode: Hex; label: string; linked: boolean}> = [
    ...generatedBytecodes.map(([label, initcode]) => ({initcode, label, linked: false})),
    ...linkers.map(([label, fn]) => ({initcode: fn(), label: `${label}()`, linked: true})),
  ];
  const byAddress = new Map<string, {label: string; initcode: Hex; salt: string}>();
  for (const [saltKey, salt] of Object.entries(ABX_SALT)) {
    for (const c of candidates) byAddress.set(predictCreate2Address(salt, c.initcode).toLowerCase(), {...c, salt: saltKey});
  }

  for (const [name, predict] of predictors) {
    const hit = byAddress.get(predict().toLowerCase());
    assert.ok(
      hit,
      `${name}() = ${predict()} matches no (canonical salt × known initcode) pair — either it uses a ` +
        `non-canonical salt/bytecode, or its bytecode is not exported from abi/generated.ts. Register it ` +
        `so this guard can see it; an unreviewable trust-anchor address is exactly what this test exists to stop.`,
    );
    const placeholders = placeholdersIn(hit.initcode);
    assert.equal(
      placeholders.length,
      0,
      `${name}() hashes UNLINKED bytecode: it is keccak(${hit.label} @ salt '${hit.salt}'), which still ` +
        `carries ${placeholders.join(', ')}. viem UTF-8-encodes that placeholder instead of rejecting it, so ` +
        `the "address" above is a hash of ASCII garbage — nothing can ever be deployed there. Add a link* ` +
        `helper for this contract (see linkOneOfOneEditionFactory) and predict from IT, not from the raw bytecode.`,
    );
  }
});

test('every link* helper really substitutes: same length, placeholder-free, and derived from a shipped bytecode', () => {
  assert.ok(linkers.length >= 5, `expected the full link* surface, found ${linkers.length}`);
  for (const [name, link] of linkers) {
    const linked = link();
    assert.equal(linked.match(PLACEHOLDER_RE), null, `${name}() must clear every placeholder`);
    assert.ok(/^0x[0-9a-fA-F]+$/.test(linked), `${name}() must be valid hex (an unlinked one is not)`);
    // The source must be a bytecode we actually ship, still unlinked — proving substitution is real
    // and that the helper isn't quietly linking some other build's bytes.
    const source = generatedBytecodes.find(([, bc]) => bc.length === linked.length && isLinkOf(bc, linked));
    assert.ok(source, `${name}() must be the linked form of one of abi/generated.ts's exported bytecodes`);
    assert.notEqual(source![1], linked, `${name}() must differ from the shipped bytecode (substitution, not a no-op)`);
    assert.ok((source![1].match(PLACEHOLDER_RE) ?? []).length > 0, `${source![0]} should still ship UNLINKED`);
  }
});

/** Is `candidate` `unlinked` with each 40-char placeholder replaced by 40 hex chars, and nothing else
 *  touched? Linking is length-preserving, so this is an exact positional comparison. */
function isLinkOf(unlinked: string, candidate: string): boolean {
  if (candidate.length !== unlinked.length) return false;
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let cursor = 0;
  for (let m = re.exec(unlinked); m; m = re.exec(unlinked)) {
    if (candidate.slice(cursor, m.index) !== unlinked.slice(cursor, m.index)) return false;
    if (!/^[0-9a-fA-F]{40}$/.test(candidate.slice(m.index, m.index + 40))) return false;
    cursor = m.index + 40;
  }
  return cursor > 0 && candidate.slice(cursor) === unlinked.slice(cursor);
}

test('every initcode the SDK would actually SEND is placeholder-free (ops.ts prepare* surface)', () => {
  const prepares = Object.entries(ops).filter(
    (e): e is [string, (args: {chainId: number}) => {to: Address | null; data: Hex}] =>
      /^prepareDeploy/.test(e[0]) && typeof e[1] === 'function',
  );
  assert.ok(prepares.length >= 14, `expected the full prepareDeploy* surface, found ${prepares.length}`);
  let checked = 0;
  for (const [name, prepare] of prepares) {
    let tx: {to: Address | null; data: Hex};
    // A clone deploy needs `{factory, params, salt, clone}` and throws without them — those encode a
    // FUNCTION CALL to a factory, not initcode, so skipping them is correct, and the `to` filter
    // below is the second line of defence in case one ever stops throwing.
    try {
      tx = prepare({chainId: SEPOLIA});
    } catch {
      continue;
    }
    if (tx.to !== null && tx.to !== CREATE2_PROXY) continue; // not a deploy of raw initcode
    checked++;
    assert.deepEqual(
      placeholdersIn(tx.data),
      [],
      `${name}() would send an unlinked library placeholder as initcode — the RPC rejects it as ` +
        `\`Invalid byte sequence\`, or (worse) it deploys a contract whose delegatecalls go nowhere. ` +
        `Send link*() output, not the raw *Bytecode export.`,
    );
  }
  assert.ok(checked >= 8, `expected to reach the singleton/factory deploys, only checked ${checked}`);
});

test('every initcode the SDK would actually SEND is placeholder-free (deploy orchestrators, driven end-to-end)', async () => {
  // Drives each `deploy*(send, client)` orchestrator against a chain where nothing exists yet, and
  // inspects every byte it puts on the wire. This is the strongest form of the guard: it covers the
  // library legs a bootstrap adds (`AbxEditionLib` must go out LINKED itself) as well as the factory,
  // and it is blind to which contract is involved — a new orchestrator is covered on the day it lands.
  const modules: Array<readonly [string, Record<string, unknown>]> = [
    ['deploy.ts', deployModule as unknown as Record<string, unknown>],
    ['chunks.ts', chunksModule as unknown as Record<string, unknown>],
  ];
  const orchestrators = modules.flatMap(([where, mod]) =>
    Object.entries(mod)
      .filter(([name, fn]) => /^deploy[A-Z]/.test(name) && typeof fn === 'function' && (fn as () => void).length === 2)
      .map(([name, fn]) => [`${where}:${name}`, fn as (send: unknown, client: unknown) => Promise<unknown>] as const),
  );
  assert.ok(orchestrators.length >= 11, `expected every (send, client) deployer, found ${orchestrators.length}`);

  for (const [name, run] of orchestrators) {
    const {sent, send} = recorder();
    // One stub serving both shapes the orchestrators take as their 2nd arg: a PublicClient (deploy.ts)
    // and a `{chainId}` options bag (chunks.ts's deployChunkStore). Nothing has code, so every
    // library leg deploys and every `assertVacant` passes.
    const client = {...(fakeClient(() => false) as unknown as Record<string, unknown>), chainId: SEPOLIA};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await run(send as any, client as any);
    assert.ok(sent.length > 0, `${name} sent nothing`);
    for (const tx of sent) {
      assert.deepEqual(
        placeholdersIn(tx.data),
        [],
        `${name} → op '${tx.op}' would broadcast an unlinked library placeholder. Every leg of a ` +
          `bootstrap (the libraries included — AbxEditionLib links AbxParamsLib) must be linked first.`,
      );
    }
  }
});
