// The harness's load-bearing properties, no browser involved: work detection is "the
// artifact at the CURRENT inputsHash address is missing", runs are idempotent, and a
// param change re-addresses output (so the same token renders again — self-invalidating).
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {stringToHex} from 'viem';
import type {ProjectState, TokenState, ParamValue} from '@artblocks/abx-sdk';
import type {StorageBackend, StoredContent} from '@artblocks/abx-storage';
import {EffectRunner, type EffectArtifactRecord, type EffectModule} from '../src/harness.js';

const ADDR = '0xAbCd000000000000000000000000000000000001';

function memoryStorage(): StorageBackend & {size(): number} {
  const map = new Map<string, StoredContent>();
  return {
    id: 'memory',
    async put(hash, content) {
      map.set(hash, content);
    },
    async get(hash) {
      return map.get(hash) ?? null;
    },
    async has(hash) {
      return map.has(hash);
    },
    size: () => map.size,
  };
}

/** The publish topology's minimum: a backend that can name a REACHABLE locator for what it holds.
 *  Referenced output travels as that pointer, so a backend without one has no publish lane at all
 *  (the constructor refuses it — see the boot-guard test). */
function locatorStorage(): StorageBackend & {size(): number} {
  return {
    ...memoryStorage(),
    async locator(hash: `0x${string}`) {
      return `ipfs://cid-${hash.slice(2, 10)}`;
    },
  };
}

const pv = (key: string, value: bigint): ParamValue => ({
  key,
  value: `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`,
  valueIsHash: false,
  updatedBy: ADDR as `0x${string}`,
});

function codeState(paletteValue: bigint): ProjectState {
  const token: TokenState = {
    tokenId: '0',
    lifecycle: 'live',
    owner: null,
    tokenURI: null,
    fields: [],
    lockedFields: [],
    params: [pv('seed', 0xabcdn), pv('palette', paletteValue)],
  };
  return {
    address: ADDR as `0x${string}`,
    chainId: 31337,
    abxVersion: 1,
    deployBlock: '1',
    deployTx: '0x00' as `0x${string}`,
    factory: null,
    implementation: null,
    isCanonical: null,
    name: 'Waves',
    symbol: 'WAV',
    owner: null,
    contractURI: null,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    royalty: null,
    collectionFields: [
      {field: 'code', representation: 'ipfs', value: '0x1234' as `0x${string}`},
    ],
    lockedCollectionFields: [],
    paramHooks: null,
    tokens: [token],
    extensions: [],
    events: [],
    fromBlock: '1',
    toBlock: '2',
    eventCount: 0,
    reconstructedAt: 'now',
  } as ProjectState;
}

function fakeEffect(): EffectModule & {runs: number} {
  const effect = {
    key: 'render',
    outputs: [
      {key: 'image', mimeType: 'image/png'},
      {key: 'traits', mimeType: 'application/json'},
    ],
    runs: 0,
    async run() {
      effect.runs += 1;
      return {
        image: {bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png'},
        traits: null, // optional output withheld — must not be stored or break anything
      };
    },
  };
  return effect;
}

test('sweep runs a missing token once, then skips (idempotent by addressing)', async () => {
  const storage = memoryStorage();
  const effect = fakeEffect();
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => codeState(0x0e1a40n),
    log: () => {},
  });

  const first = await runner.sweepProject(ADDR);
  assert.deepEqual(first, {ran: 1, skipped: 0, failed: 0, errors: []});
  assert.equal(effect.runs, 1);
  assert.equal(storage.size(), 1); // image stored; withheld traits stored nothing

  const second = await runner.sweepProject(ADDR);
  assert.deepEqual(second, {ran: 0, skipped: 1, failed: 0, errors: []});
  assert.equal(effect.runs, 1); // no re-run — the current address is populated
});

test('force re-renders an already-present output (the repair lane for a bad/blank capture)', async () => {
  const storage = memoryStorage();
  const effect = fakeEffect();
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => codeState(0x0e1a40n),
    log: () => {},
  });

  const first = await runner.sweepProject(ADDR);
  assert.deepEqual(first, {ran: 1, skipped: 0, failed: 0, errors: []});
  assert.equal(effect.runs, 1);

  // Without force the existing still is skipped; WITH force it re-renders in place (same address,
  // overwritten) — no param change, so the plain sweep would never touch it.
  const skipped = await runner.sweepProject(ADDR);
  assert.equal(skipped.skipped, 1);
  assert.equal(effect.runs, 1);

  const forced = await runner.sweepProject(ADDR, undefined, {force: true});
  assert.deepEqual(forced, {ran: 1, skipped: 0, failed: 0, errors: []});
  assert.equal(effect.runs, 2); // re-ran despite the artifact already existing
  assert.equal(storage.size(), 1); // overwritten at the same inputsHash address, not duplicated
});

test('a param change re-addresses the output, so the token renders again', async () => {
  const storage = memoryStorage();
  const effect = fakeEffect();
  let palette = 0x0e1a40n;
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => codeState(palette),
    log: () => {},
  });

  await runner.sweepProject(ADDR);
  palette = 0xff0000n; // the PostParam changed on-chain
  const after = await runner.sweepProject(ADDR);
  assert.deepEqual(after, {ran: 1, skipped: 0, failed: 0, errors: []});
  assert.equal(effect.runs, 2);
  assert.equal(storage.size(), 2); // old artifact remains addressed; new one added
});

test('a failing effect is counted, never thrown out of the sweep', async () => {
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage: memoryStorage(),
    effects: [
      {
        key: 'render',
        outputs: [{key: 'image', mimeType: 'image/png'}],
        run: async () => {
          throw new Error('browser exploded');
        },
      },
    ],
    fetchState: async () => codeState(1n),
    log: () => {},
  });
  const stats = await runner.sweepProject(ADDR);
  assert.deepEqual({ran: stats.ran, skipped: stats.skipped, failed: stats.failed}, {ran: 0, skipped: 0, failed: 1});
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0], /browser exploded/); // the message is surfaced (for `abx render`), not swallowed
});

test('an explicit unminted token id is a reported no-op, not a silent ran=0', async () => {
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage: memoryStorage(),
    effects: [fakeEffect()],
    fetchState: async () => codeState(1n), // only token 0 is minted
    log: () => {},
  });
  const stats = await runner.sweepProject(ADDR, ['5']); // token 5 was never minted
  assert.deepEqual({ran: stats.ran, skipped: stats.skipped, failed: stats.failed}, {ran: 0, skipped: 0, failed: 0});
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0], /not minted/); // it SAYS so, rather than a silent ran=0 that reads as "done"
});

// ── EditionCode: an id with zero live copies is excluded like a burned 721 token ────────────────
// `'no-live-copies'` means no mint-time seed was ever drawn for that id — there is nothing yet to
// derive an image/traits FROM (see the exclusion site's own comment in harness.ts). A watcher
// notification (or a deliberate `abx render <addr> <id>`) can still name such an id, so the guard
// must hold on the EXPLICIT-ids path too, not just the default `lifecycle === 'live'` sweep.
test('an EditionCode id with no live copies is excluded, same as a burned token, even when named explicitly', async () => {
  const liveId0: TokenState = {
    tokenId: '0',
    lifecycle: 'live',
    owner: null,
    tokenURI: null,
    fields: [],
    lockedFields: [],
    params: [pv('seed', 0xabcdn)],
  };
  const noLiveCopiesId1: TokenState = {
    tokenId: '1',
    lifecycle: 'no-live-copies', // an EditionCode id that has never been minted (0 copies)
    owner: null,
    tokenURI: null,
    fields: [],
    lockedFields: [],
    params: [],
  };
  const state: ProjectState = {...codeState(0x0e1a40n), tokens: [liveId0, noLiveCopiesId1]};
  const effect = fakeEffect();
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage: memoryStorage(),
    effects: [effect],
    fetchState: async () => state,
    log: () => {},
  });

  // Default sweep (no explicit ids): only the live id renders.
  const defaultSweep = await runner.sweepProject(ADDR);
  assert.deepEqual({ran: defaultSweep.ran, failed: defaultSweep.failed}, {ran: 1, failed: 0});
  assert.equal(effect.runs, 1);

  // Explicit ids naming BOTH — id 1 is excluded exactly like a burned token would be, not rendered
  // and not reported as a failure (it is a legitimate "nothing to do here yet" id, not an error).
  const explicit = await runner.sweepProject(ADDR, ['0', '1'], {force: true});
  assert.deepEqual({ran: explicit.ran, failed: explicit.failed}, {ran: 1, failed: 0});
  assert.equal(effect.runs, 2); // only id 0 re-ran (force); id 1 never touched
});

test('an UNREACHABLE resolver throws — a killed/down resolver is a failure, never a clean ran=0', async () => {
  // No fetchState → exercises the real getState → fetchJson path against a port with nothing on it.
  const runner = new EffectRunner({
    resolverUrl: 'http://127.0.0.1:1',
    client: null,
    storage: memoryStorage(),
    effects: [fakeEffect()],
    log: () => {},
  });
  // The old behavior swallowed the connection failure into {ran:0,failed:0} (a failure disguised as
  // success). It must now REJECT so `abx render` / the sweep surface a real error.
  await assert.rejects(() => runner.sweepProject(ADDR), /unreachable/);
});

/** Capture the runner's publish POSTs by stubbing global fetch. Returns the parsed bodies. */
async function capturePublishes(run: () => Promise<void>): Promise<Array<Record<string, any>>> {
  const bodies: Array<Record<string, any>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: {headers?: Record<string, string>; body?: string}) => {
    if (String(url).endsWith('/v1/effect-artifacts')) {
      bodies.push({...JSON.parse(init.body ?? '{}'), _auth: init.headers?.authorization});
    }
    return new Response(JSON.stringify({ok: true}), {status: 200});
  }) as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies;
}

test('the publish lane splits by BINDING: referenced image → locator, bound traits → capped bytes', async () => {
  const storage = locatorStorage();
  const effect: EffectModule = {
    key: 'render',
    outputs: [
      {key: 'image', mimeType: 'image/png'},
      {key: 'traits', mimeType: 'application/json', bound: true},
    ],
    async run() {
      return {
        image: {bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png'},
        traits: {bytes: new TextEncoder().encode('{"P":"x"}'), contentType: 'application/json'},
      };
    },
  };
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => codeState(1n),
    log: () => {},
    adminToken: 'secret',
  });

  const posts = await capturePublishes(async () => void (await runner.sweepProject(ADDR)));
  assert.equal(posts.length, 2); // one per output
  for (const p of posts) assert.equal(p._auth, 'Bearer secret'); // admin-token gated
  const img = posts.find((p) => p.output === 'image')!;
  const tr = posts.find((p) => p.output === 'traits')!;
  // image is REFERENCED: the producer keeps the bytes, the resolver gets a pointer and redirects.
  assert.match(img.locator, /^ipfs:\/\/cid-/);
  assert.equal(img.bytes_base64, undefined);
  assert.match(img.inputsHash, /^0x[0-9a-f]{64}$/); // runner-supplied hash (server does NOT recompute)
  assert.equal(img.chainId, 31337); // chain-explicit publish — the /v1 control plane validates it
  // traits is BOUND: its content stitches into the token JSON, so a locator could never work.
  assert.ok(tr.bytes_base64);
  assert.equal(tr.locator, undefined);
});

test('boot guard: adminToken + a backend with no locator is REFUSED at construction, not after a render', async () => {
  // Referenced output can only reach a resolver that doesn't share this disk as a URL. A backend
  // that can't name one has no lane, so every render would be wasted work ending in a 400 — refuse
  // where the fix is cheap. (This used to silently fall back to shipping the bytes, which made every
  // conforming resolver an object store.)
  assert.throws(
    () =>
      new EffectRunner({
        resolverUrl: 'http://resolver.test',
        client: null,
        storage: memoryStorage(), // no locator()
        effects: [fakeEffect()],
        log: () => {},
        adminToken: 'secret',
      }),
    /exposes no locator/,
  );
  // Co-located (no admin token) is unaffected: it shares the backend, so there is nothing to publish.
  assert.doesNotThrow(
    () =>
      new EffectRunner({
        resolverUrl: 'http://resolver.test',
        client: null,
        storage: memoryStorage(),
        effects: [fakeEffect()],
        log: () => {},
      }),
  );
});

test('a locator this backend can only resolve itself is refused — reachability, not durability', async () => {
  // The rule is that a third party can resolve it. Scheme is NOT the test: an https gateway URL is a
  // peer of ipfs://. A loopback gateway is what fails, because nobody else can reach it.
  const storage: StorageBackend = {
    ...memoryStorage(),
    async locator() {
      return 'http://localhost:8080/ipfs/cid-local';
    },
  };
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [fakeEffect()],
    fetchState: async () => codeState(1n),
    log: () => {},
    adminToken: 'secret',
  });
  const posts = await capturePublishes(async () => void (await runner.sweepProject(ADDR)));
  assert.equal(posts.length, 0); // nothing published
  const stats = await runner.sweepProject(ADDR);
  assert.equal(stats.ran, 0); // and latched: no further renders are spent against a broken lane
  assert.match(stats.errors[0], /resolve for anyone|loopback|private host/);
});

test('a 4xx publish LATCHES the runner instead of re-rendering every sweep, forever', async () => {
  // The work ledger is "custody lacks the artifact at the current hash", so a render whose publish
  // is refused gets re-rendered on every subsequent sweep. Warn-and-continue would therefore burn
  // Chromium indefinitely; the only safe answer to a permanent refusal is to stop and say why once.
  const realFetch = globalThis.fetch;
  let publishAttempts = 0;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/v1/effect-artifacts')) {
      publishAttempts += 1;
      return new Response(JSON.stringify({error: 'referenced output needs a locator', code: 'invalid_request'}), {status: 400});
    }
    return new Response(JSON.stringify({ok: true, projects: []}), {status: 200});
  }) as typeof fetch;
  try {
    const runner = new EffectRunner({
      resolverUrl: 'http://resolver.test',
      client: null,
      storage: locatorStorage(),
      effects: [fakeEffect()],
      fetchState: async () => codeState(1n),
      log: () => {},
      adminToken: 'secret',
    });
    const first = await runner.sweepProject(ADDR);
    assert.equal(first.failed, 1);
    assert.equal(publishAttempts, 1);
    const second = await runner.sweepProject(ADDR);
    assert.equal(second.ran, 0);
    assert.equal(publishAttempts, 1); // not retried — latched
    assert.match(second.errors[0], /rendering stopped/);
    // force is the operator asserting they fixed it: the latch clears and work resumes.
    await runner.sweepProject(ADDR, undefined, {force: true});
    assert.equal(publishAttempts, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('preflight: a rejected credential stops the runner BEFORE any render', async () => {
  const realFetch = globalThis.fetch;
  let renders = 0;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes('/.well-known/abx-service')) {
      return new Response(JSON.stringify({interfaces: ['abx-token-api/v1', 'abx-control-plane/v1'], chains: [31337]}), {status: 200});
    }
    if (u.endsWith('/v1/projects')) {
      return new Response(JSON.stringify({error: 'unauthorized', code: 'unauthorized'}), {status: 401});
    }
    return new Response(JSON.stringify({ok: true}), {status: 200});
  }) as typeof fetch;
  try {
    const effect: EffectModule = {
      key: 'render',
      outputs: [{key: 'image', mimeType: 'image/png'}],
      async run() {
        renders += 1;
        return {image: {bytes: new Uint8Array([1]), contentType: 'image/png'}};
      },
    };
    const runner = new EffectRunner({
      resolverUrl: 'http://resolver.test',
      client: null,
      storage: locatorStorage(),
      effects: [effect],
      fetchState: async () => codeState(1n),
      log: () => {},
      adminToken: 'wrong-token',
    });
    const stats = await runner.sweepProject(ADDR);
    assert.equal(renders, 0); // the expensive part never happened
    assert.equal(stats.failed, 1);
    assert.match(stats.errors[0], /credential/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a skipped token RE-REGISTERS its rows — a transient publish failure heals without re-rendering', async () => {
  // Referenced output now costs a presence probe + a locator string to re-register, so this runs on
  // every skip: it repairs a resolver that lost its rows, and (the case that used to be silent) a
  // publish that failed after the bytes were already stored, which the local ledger calls done.
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage: locatorStorage(),
    effects: [fakeEffect()],
    fetchState: async () => codeState(1n),
    log: () => {},
    adminToken: 'secret',
  });
  const first = await capturePublishes(async () => void (await runner.sweepProject(ADDR)));
  assert.equal(first.length, 1);
  const second = await capturePublishes(async () => {
    const stats = await runner.sweepProject(ADDR);
    assert.equal(stats.skipped, 1); // no re-render
    assert.equal(stats.ran, 0);
  });
  assert.equal(second.length, 1); // but the row was registered again
  assert.match(second[0].locator, /^ipfs:\/\/cid-/);
});

test('no admin token → the runner does not publish (co-located shared-store topology)', async () => {
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage: memoryStorage(),
    effects: [fakeEffect()],
    fetchState: async () => codeState(1n),
    log: () => {},
    // no adminToken
  });
  const posts = await capturePublishes(async () => void (await runner.sweepProject(ADDR)));
  assert.equal(posts.length, 0);
});

test('queue: enqueue merges per project, drains async, and over-notification lands on skips', async () => {
  const storage = memoryStorage();
  const effect = fakeEffect();
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => codeState(0x0e1a40n),
    log: () => {},
  });

  // three notifications for the same project before the drain catches up — merged, not tripled
  runner.enqueue(ADDR, ['0']);
  runner.enqueue(ADDR, ['0']);
  runner.enqueue(ADDR); // no hint ⇒ all minted (widens the merged request)
  await runner.idle();
  assert.equal(effect.runs, 1); // one real render — the artifact exists after the first

  // a later notification with nothing new ⇒ pure skip (the settled-hash probe absorbs it)
  runner.enqueue(ADDR, ['0']);
  await runner.idle();
  assert.equal(effect.runs, 1);
});

test('attempt cap: a persistently-failing effect stops retrying at MAX_ATTEMPTS; force resets', async () => {
  const storage = memoryStorage();
  let failures = 0;
  let succeedNow = false;
  const flaky = {
    key: 'render',
    outputs: [{key: 'image', mimeType: 'image/png'}],
    async run() {
      if (!succeedNow) {
        failures += 1;
        throw new Error('deterministic script crash');
      }
      return {image: {bytes: new Uint8Array([9]), contentType: 'image/png'}};
    },
  };
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [flaky],
    fetchState: async () => codeState(1n),
    log: () => {},
  });

  // five sweeps: only the first three actually run (MAX_ATTEMPTS=3), the rest skip
  for (let i = 0; i < 5; i++) await runner.sweepProject(ADDR);
  assert.equal(failures, 3);

  // force bypasses + resets the cap — and a success clears the counter
  succeedNow = true;
  const stats = await runner.sweepProject(ADDR, undefined, {force: true});
  assert.equal(stats.ran, 1);
});

test('HTTP: /notify enqueues (202) and /run + /notify are token-gated when authToken is set; /health stays open', async () => {
  const storage = memoryStorage();
  const effect = fakeEffect();
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => codeState(0x0e1a40n),
    log: () => {},
    authToken: 'secret-tok',
  });
  const server = runner.startHttp(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as {port: number}).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // health: open
    assert.equal((await fetch(`${base}/health`)).status, 200);
    // unauthorized: both write lanes refuse
    assert.equal((await fetch(`${base}/notify`, {method: 'POST', body: JSON.stringify({address: ADDR}), headers: {'content-type': 'application/json'}})).status, 401);
    assert.equal((await fetch(`${base}/run`, {method: 'POST', body: JSON.stringify({address: ADDR}), headers: {'content-type': 'application/json'}})).status, 401);
    // authorized notify: 202 + async drain does the work
    const res = await fetch(`${base}/notify`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer secret-tok'},
      body: JSON.stringify({address: ADDR, tokenIds: ['0']}),
    });
    assert.equal(res.status, 202);
    await runner.idle();
    assert.equal(effect.runs, 1);
  } finally {
    server.close();
  }
});

test('status reporting: rendering → done on success, failed(error, attempts) on crash — via the control plane', async () => {
  const reports: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: {body?: string}) => {
    const u = String(url);
    if (u.endsWith('/v1/effect-status')) {
      reports.push(JSON.parse(init?.body ?? '{}'));
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }
    if (u.endsWith('/v1/effect-artifacts')) return new Response(JSON.stringify({ok: true}), {status: 200});
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    const storage = locatorStorage();
    let crash = true;
    const effect = {
      key: 'render',
      outputs: [{key: 'image', mimeType: 'image/png'}],
      async run() {
        if (crash) throw new Error('boom');
        return {image: {bytes: new Uint8Array([1]), contentType: 'image/png'}};
      },
    };
    const runner = new EffectRunner({
      resolverUrl: 'http://resolver.test',
      client: null,
      storage,
      effects: [effect],
      fetchState: async () => codeState(1n),
      log: () => {},
      adminToken: 'admin-tok',
    });
    await runner.sweepProject(ADDR); // crash path
    assert.deepEqual(reports.map((r) => r.status), ['rendering', 'failed']);
    assert.equal(reports[1].error, 'boom');
    assert.equal(reports[1].attempts, 1);
    reports.length = 0;
    crash = false;
    await runner.sweepProject(ADDR); // success path
    assert.deepEqual(reports.map((r) => r.status), ['rendering', 'done']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── deterministic-image lane (on-chain url-template + off-chain S3 thumbnails, no resolver) ──
// A cloud-style backend: a public base + caller-keyed putObject/getObject (the deterministic
// primitive), alongside the content-addressed hash map (unused on this lane).
function memoryCloud(publicBase: string): StorageBackend & {objects: Map<string, StoredContent>} {
  const objects = new Map<string, StoredContent>();
  const hashed = new Map<string, StoredContent>();
  return {
    id: 'memory-cloud',
    publicBase,
    async put(hash, content) {
      hashed.set(hash, content);
    },
    async get(hash) {
      return hashed.get(hash) ?? null;
    },
    async has(hash) {
      return hashed.has(hash);
    },
    async putObject(key, content) {
      objects.set(key, content);
    },
    async getObject(key) {
      return objects.get(key) ?? null;
    },
    objects,
  };
}

function withImageTemplate(state: ProjectState, template: string): ProjectState {
  state.collectionFields.push({field: 'image', representation: 'url-template', value: stringToHex(template)});
  return state;
}

test('deterministic lane: still lands at the on-chain-named S3 key; idempotent via the hash marker', async () => {
  const storage = memoryCloud('https://cdn.test');
  const effect = fakeEffect();
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => withImageTemplate(codeState(0x0e1a40n), 'https://cdn.test/orbit/{id}.png'),
    log: () => {},
  });

  const first = await runner.sweepProject(ADDR);
  assert.deepEqual(first, {ran: 1, skipped: 0, failed: 0, errors: []});
  // token 0 → the exact object the on-chain url-template names (publicBase stripped), plus its marker.
  assert.ok(storage.objects.has('orbit/0.png'), 'still written to the deterministic key');
  assert.ok(storage.objects.has('orbit/0.png.abxhash'), 'inputsHash marker written');

  const second = await runner.sweepProject(ADDR);
  assert.deepEqual(second, {ran: 0, skipped: 1, failed: 0, errors: []});
  assert.equal(effect.runs, 1); // marker matches the current inputsHash → no re-render
});

// ── the artifact registry lanes (the data plane's enumeration surface) ─────────

test('recordArtifact: rows land for every PRODUCED output on run, and re-record on skip (registry self-heal)', async () => {
  const storage = memoryStorage();
  const effect = fakeEffect(); // produces image, withholds traits
  const rows: EffectArtifactRecord[] = [];
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => codeState(1n),
    log: () => {},
    recordArtifact: (row) => void rows.push(row),
  });

  await runner.sweepProject(ADDR);
  assert.equal(rows.length, 1); // image recorded; withheld traits recorded nothing
  assert.equal(rows[0].effectKey, 'render');
  assert.equal(rows[0].outputKey, 'image');
  assert.equal(rows[0].contentType, 'image/png'); // the DECLARED type
  assert.equal(rows[0].locator, null); // memory backend exposes no locator → bytes live in custody
  assert.match(rows[0].inputsHash, /^0x[0-9a-f]{64}$/);
  assert.equal(rows[0].address, ADDR.toLowerCase());

  // a wiped registry self-heals on the next sweep: the skip path re-records what storage holds
  rows.length = 0;
  const second = await runner.sweepProject(ADDR);
  assert.equal(second.skipped, 1);
  assert.equal(rows.length, 1); // re-recorded without a re-render
  assert.equal(rows[0].outputKey, 'image');
});

test('N effects: every effect\'s produced outputs enumerate into the registry (the resolver stays effect-agnostic)', async () => {
  const storage = memoryStorage();
  const rows: EffectArtifactRecord[] = [];
  const make = (key: string, outputKey: string, mimeType: string): EffectModule => ({
    key,
    outputs: [{key: outputKey, mimeType}],
    async run() {
      return {[outputKey]: {bytes: new Uint8Array([7]), contentType: mimeType}};
    },
  });
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [make('render', 'image', 'image/png'), make('world.rebuild', 'model', 'model/gltf-binary')],
    fetchState: async () => codeState(1n),
    log: () => {},
    recordArtifact: (row) => void rows.push(row),
  });
  await runner.sweepProject(ADDR);
  assert.deepEqual(
    rows.map((r) => `${r.effectKey}/${r.outputKey}:${r.contentType}`).sort(),
    ['render/image:image/png', 'world.rebuild/model:model/gltf-binary'],
  );
});

test('declared type wins: a runtime contentType mismatch stores + records the DECLARED mimeType', async () => {
  const storage = memoryStorage();
  const rows: EffectArtifactRecord[] = [];
  const effect: EffectModule = {
    key: 'render',
    outputs: [{key: 'image', mimeType: 'image/png'}],
    async run() {
      return {image: {bytes: new Uint8Array([1]), contentType: 'application/octet-stream'}}; // wrong at runtime
    },
  };
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => codeState(1n),
    log: () => {},
    recordArtifact: (row) => void rows.push(row),
  });
  await runner.sweepProject(ADDR);
  assert.equal(rows[0].contentType, 'image/png');
});

test('an UNDECLARED output is refused (never stored, never recorded) — declared, never sniffed', async () => {
  const storage = memoryStorage();
  const rows: EffectArtifactRecord[] = [];
  const effect: EffectModule = {
    key: 'render',
    outputs: [{key: 'image', mimeType: 'image/png'}],
    async run() {
      return {
        image: {bytes: new Uint8Array([1]), contentType: 'image/png'},
        video: {bytes: new Uint8Array([2]), contentType: 'video/mp4'}, // not declared
      };
    },
  };
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => codeState(1n),
    log: () => {},
    recordArtifact: (row) => void rows.push(row),
  });
  await runner.sweepProject(ADDR);
  assert.equal(storage.size(), 1); // image only — the undeclared video was refused
  assert.deepEqual(rows.map((r) => r.outputKey), ['image']);
});

test('deterministic lane: the registry row carries the stable public URL as its locator', async () => {
  const storage = memoryCloud('https://cdn.test');
  const rows: EffectArtifactRecord[] = [];
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [fakeEffect()],
    fetchState: async () => withImageTemplate(codeState(1n), 'https://cdn.test/orbit/{id}.png'),
    log: () => {},
    recordArtifact: (row) => void rows.push(row),
  });
  await runner.sweepProject(ADDR);
  const img = rows.find((r) => r.outputKey === 'image')!;
  assert.equal(img.locator, 'https://cdn.test/orbit/0.png'); // the on-chain-named object, not a hash key

  // and the skip path records it too (sidecar marker matched, storage.has(key) never would)
  rows.length = 0;
  await runner.sweepProject(ADDR);
  assert.equal(rows.find((r) => r.outputKey === 'image')?.locator, 'https://cdn.test/orbit/0.png');
});

test('deterministic lane: a param change overwrites the SAME key (stable URL, no proliferation)', async () => {
  const storage = memoryCloud('https://cdn.test');
  const effect = fakeEffect();
  let palette = 0x0e1a40n;
  const runner = new EffectRunner({
    resolverUrl: 'http://resolver.test',
    client: null,
    storage,
    effects: [effect],
    fetchState: async () => withImageTemplate(codeState(palette), 'https://cdn.test/orbit/{id}.png'),
    log: () => {},
  });

  await runner.sweepProject(ADDR);
  const before = new TextDecoder().decode((await storage.getObject!('orbit/0.png.abxhash'))!.bytes);

  palette = 0xff0000n; // a collector changes the palette param → new inputsHash
  const res = await runner.sweepProject(ADDR);
  assert.deepEqual(res, {ran: 1, skipped: 0, failed: 0, errors: []}); // re-rendered
  const after = new TextDecoder().decode((await storage.getObject!('orbit/0.png.abxhash'))!.bytes);
  assert.notEqual(before, after); // marker advanced
  // ONE image object + ONE marker — overwritten in place, so the on-chain URL never changes.
  assert.equal(storage.objects.size, 2);
});
