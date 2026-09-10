// The /v1 control plane + service descriptor (control-plane.ts) over a REAL server on port 0.
// Everything exercised here answers before any chain call (auth → chain validation → store reads),
// so the tests are fully offline; the register-and-replay happy path lives in the e2e script.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type Server} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  currentAnchorGeneration,
  resolveChain,
  CONTROL_PLANE_INTERFACE,
  TOKEN_API_INTERFACE,
  type ProjectState,
  type ServiceDescriptor,
} from '@artblocks/abx-sdk';
import {SelfHostIndexer, SqliteStore} from '@artblocks/abx-indexer';
import type {StorageBackend, StoredContent} from '@artblocks/abx-storage';
import {createTokenApiServer} from '../src/server.js';
import {summarize, SUPPORTED_CONTRACT_GENERATION_IDS} from '../src/control-plane.js';

const CHAIN_KEY = process.env.ABX_CHAIN ?? 'base-sepolia';
const CHAIN_ID = resolveChain(process.env.ABX_CHAIN).id;
const ADDR = '0xb5d472600107a56c0a36838fff7030a864439a30';

function memoryStorage(): StorageBackend {
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
  };
}

/** Boot the real token API on port 0 against a fresh temp store. */
async function withNode(run: (base: string, indexer: SelfHostIndexer) => Promise<void>): Promise<void> {
  const store = new SqliteStore(mkdtempSync(join(tmpdir(), 'abx-cp-')));
  const indexer = new SelfHostIndexer(store);
  const server = createTokenApiServer({indexer, port: 0, baseUrl: 'http://localhost', storage: memoryStorage()});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  try {
    await run(base, indexer);
  } finally {
    server.close();
    store.destroy();
  }
}

/**
 * Boot the node against a REAL store but a stand-in catch-up, so the register handler's two answer
 * shapes (200 when it lands inside the deadline, 202 when it doesn't) are testable without a chain.
 * `gate` decides when the catch-up resolves.
 */
async function withStubCatchUp(
  run: (ctx: {base: string; indexer: SelfHostIndexer; calls: number[]; finish: () => void}) => Promise<void>,
): Promise<void> {
  const store = new SqliteStore(mkdtempSync(join(tmpdir(), 'abx-cp-')));
  const indexer = new SelfHostIndexer(store);
  const calls: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  (indexer as unknown as {reindexShared: unknown}).reindexShared = async (address: string) => {
    calls.push(Date.now());
    await gate;
    const now = new Date().toISOString();
    store.setIndexStatus(address, {status: 'live', error: null, attempts: 0, lastIndexedAt: now});
    return {
      state: {
        address,
        name: 'Stub',
        symbol: 'STB',
        owner: null,
        abxVersion: 1,
        isCanonical: true,
        extensions: [],
        eventCount: 7,
        tokens: [{lifecycle: 'live'}, {lifecycle: 'unminted'}],
        reconstructedAt: now,
        toBlock: '505',
      },
      elapsedMs: 3,
      mode: 'full',
    };
  };
  const server = createTokenApiServer({indexer, port: 0, baseUrl: 'http://localhost', storage: memoryStorage()});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  try {
    await run({base, indexer, calls, finish: release});
  } finally {
    release();
    server.close();
    store.destroy();
  }
}

/** Set env keys for one test, restoring (or deleting) each afterwards — the withStubRpc pattern. */
async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const getJson = async (base: string, path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return {status: res.status, headers: res.headers, body: (await res.json().catch(() => ({}))) as Record<string, any>};
};
const auth = (token: string) => ({authorization: `Bearer ${token}`, 'content-type': 'application/json'});

test('descriptor: a token-less node honestly advertises NO control plane; a token flips interfaces + auth on', async () => {
  await withNode(async (base) => {
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: undefined, ABX_EFFECTS_URL: undefined}, async () => {
      const {status, body} = await getJson(base, '/.well-known/abx-service');
      assert.equal(status, 200);
      const d = body as ServiceDescriptor;
      assert.deepEqual(d.interfaces, [TOKEN_API_INTERFACE]);
      assert.deepEqual(d.chains, [CHAIN_ID]);
      assert.deepEqual(d.contractGenerations?.map((generation) => generation.id), [...SUPPORTED_CONTRACT_GENERATION_IDS]);
      assert.equal(d.contractGenerations?.[0].support.serving, true);
      assert.equal(d.auth, undefined);
      assert.equal(d.render, undefined);
      assert.ok(d.service?.version);
    });
    await withEnv(
      {ABX_RESOLVER_ADMIN_TOKEN: 'tok', ABX_EFFECTS_URL: undefined, ABX_SERVICE_NAME: 'Example Provider', ABX_SERVICE_SIGNUP_URL: 'https://signup.example'},
      async () => {
        const {body} = await getJson(base, '/.well-known/abx-service');
        const d = body as ServiceDescriptor;
        // Exactly two ids, all-or-nothing. The artifact-registry routes ride the control plane —
        // once referenced output is locator-only, taking a registration is a DB insert, so there is
        // no infrastructure a node could lack that would justify a third, omittable capability.
        assert.deepEqual(d.interfaces, [TOKEN_API_INTERFACE, CONTROL_PLANE_INTERFACE]);
        assert.deepEqual(d.auth, {scheme: 'bearer', signupUrl: 'https://signup.example'});
        assert.equal(d.service?.name, 'Example Provider'); // provider identity is deployment env, never code
      },
    );
  });
});

test('descriptor render: ABX_EFFECTS_URL attaches rendering; the /health probe fills effects, a dead runner leaves null', async () => {
  // a fake runner serving the effects /health capability list
  const runner: Server = createServer((req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true, effects: [{key: 'render', outputs: [{key: 'image', mimeType: 'image/png'}]}], queued: 0}));
  });
  await new Promise<void>((r) => runner.listen(0, '127.0.0.1', () => r()));
  const runnerUrl = `http://127.0.0.1:${(runner.address() as {port: number}).port}`;
  try {
    await withNode(async (base) => {
      await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok', ABX_EFFECTS_URL: runnerUrl}, async () => {
        const {body} = await getJson(base, '/.well-known/abx-service');
        assert.deepEqual((body as ServiceDescriptor).render, {
          attached: true,
          effects: [{key: 'render', outputs: [{key: 'image', mimeType: 'image/png'}]}],
        });
      });
      await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok', ABX_EFFECTS_URL: 'http://127.0.0.1:1'}, async () => {
        const {body} = await getJson(base, '/.well-known/abx-service');
        // attached-but-unverified — distinct from "attached, zero effects"
        assert.deepEqual((body as ServiceDescriptor).render, {attached: true, effects: null});
      });
    });
  } finally {
    runner.close();
  }
});

test('auth: token unset ⇒ 404 code disabled on EVERY /v1 route; bad bearer ⇒ 401 code unauthorized', async () => {
  await withNode(async (base) => {
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: undefined}, async () => {
      for (const [method, path] of [['POST', '/v1/projects'], ['GET', '/v1/projects'], ['DELETE', `/v1/projects/${CHAIN_ID}/${ADDR}`]] as const) {
        const {status, body} = await getJson(base, path, {method});
        assert.equal(status, 404, `${method} ${path}`);
        assert.equal(body.code, 'disabled');
      }
    });
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'right'}, async () => {
      const {status, body} = await getJson(base, '/v1/projects', {headers: auth('wrong')});
      assert.equal(status, 401);
      assert.equal(body.code, 'unauthorized');
    });
  });
});

test('chain validation: a mismatched chainId is refused with code unsupported_chain + the served chains', async () => {
  await withNode(async (base) => {
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
      // body form (register) — checked BEFORE any chain work
      const post = await getJson(base, '/v1/projects', {method: 'POST', headers: auth('tok'), body: JSON.stringify({chainId: 1, address: ADDR})});
      assert.equal(post.status, 400);
      assert.equal(post.body.code, 'unsupported_chain');
      assert.deepEqual(post.body.chains, [CHAIN_ID]);
      // missing chainId is invalid_request, not a silent implicit-chain register
      const missing = await getJson(base, '/v1/projects', {method: 'POST', headers: auth('tok'), body: JSON.stringify({address: ADDR})});
      assert.equal(missing.status, 400);
      assert.equal(missing.body.code, 'invalid_request');
      // path form
      const del = await getJson(base, `/v1/projects/999/${ADDR}`, {method: 'DELETE', headers: auth('tok')});
      assert.equal(del.body.code, 'unsupported_chain');
    });
  });
});

test('list + status + delete over a registered project (store reads only — no chain)', async () => {
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '11238537', factory: null, label: 'drift'});
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
      const list = await getJson(base, '/v1/projects', {headers: auth('tok')});
      assert.equal(list.status, 200);
      assert.equal(list.body.projects.length, 1);
      assert.deepEqual(
        {chainId: list.body.projects[0].chainId, address: list.body.projects[0].address, label: list.body.projects[0].label},
        {chainId: CHAIN_ID, address: ADDR, label: 'drift'},
      );

      const status = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}/status`, {headers: auth('tok')});
      assert.equal(status.status, 200);
      assert.equal(status.body.fromBlock, '11238537');
      assert.equal(status.body.toBlock, null); // registered, not yet indexed
      assert.equal(status.body.watcher.watching, false);

      const gone = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}`, {method: 'DELETE', headers: auth('tok')});
      assert.equal(gone.status, 200);
      const again = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}`, {method: 'DELETE', headers: auth('tok')});
      assert.equal(again.status, 404);
      assert.equal(again.body.code, 'not_registered');
      // reindex/status on an unknown project answer the same way, before touching chain
      const re = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}/reindex`, {method: 'POST', headers: auth('tok')});
      assert.equal(re.body.code, 'not_registered');
    });
  });
});

// ── ERC-1155 editions: `copies` on the summary/status surfaces ────────────────────────────────
// Additive alongside `mintedCount` (which keeps its meaning unchanged — `supply > 0`): the sum of
// every token's current supply, present only for edition contractTypes.
function editionProjectState(address: string, tokens: ProjectState['tokens']): ProjectState {
  return {
    address: address as ProjectState['address'],
    chainId: CHAIN_ID,
    abxVersion: 1,
    deployBlock: '100',
    deployTx: '0xdeadbeef',
    factory: null,
    implementation: null,
    isCanonical: true,
    name: 'Copies',
    symbol: 'CPY',
    owner: null,
    contractURI: null,
    tokenURIRenderer: null,
    tokenURILocked: null,
    contractURIRenderer: null,
    contractURILocked: null,
    royalty: null,
    collectionFields: [],
    lockedCollectionFields: [],
    contractType: 'edition',
    extensions: [],
    tokens,
    events: [],
    fromBlock: '100',
    toBlock: '105',
    eventCount: 0,
    reconstructedAt: '2026-08-05T00:00:00.000Z',
  } as unknown as ProjectState;
}

test('summarize: copies sums every token supply for an edition project, and is absent for a 721 one', () => {
  const edition = editionProjectState(ADDR, [
    {tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: [], supply: '12'},
    {tokenId: '1', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: [], supply: '3'},
  ]);
  assert.equal(summarize(edition).copies, '15');

  const oneOfOne = {...edition, contractType: '1of1' as const, tokens: [{tokenId: '0', lifecycle: 'live', owner: ADDR as never, tokenURI: null, fields: [], lockedFields: []}]};
  assert.equal('copies' in summarize(oneOfOne), false);
});

test('summarize: generation requires canonical factory proof and a matching on-chain version', () => {
  const generation = currentAnchorGeneration();
  const official = {
    ...editionProjectState(ADDR, []),
    abxVersion: generation.coreVersion,
    factory: generation.factories.editionFactory,
    isCanonical: true,
  };
  assert.deepEqual(summarize(official).contractGeneration, {
    id: generation.id,
    coreVersion: generation.coreVersion,
    lifecycle: generation.lifecycle,
    support: generation.support,
  });
  assert.equal('contractGeneration' in summarize({...official, isCanonical: false}), false);
  assert.equal('contractGeneration' in summarize({...official, abxVersion: generation.coreVersion + 1}), false);
});

test('list and status expose the verified contract generation without a database migration', async () => {
  await withNode(async (base, indexer) => {
    const generation = currentAnchorGeneration();
    const state = {
      ...editionProjectState(ADDR, []),
      abxVersion: generation.coreVersion,
      factory: generation.factories.editionFactory,
      isCanonical: true,
    };
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: state.factory});
    indexer.store.putProject(state);
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
      const list = await getJson(base, '/v1/projects', {headers: auth('tok')});
      assert.equal(list.body.projects[0].contractGeneration.id, generation.id);
      const status = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}/status`, {headers: auth('tok')});
      assert.equal(status.body.contractGeneration.id, generation.id);
      assert.equal(status.body.contractGeneration.support.serving, true);
    });
  });
});

test('the list and status routes carry copies for an edition project through to the wire', async () => {
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null, label: 'copies'});
    indexer.store.putProject(
      editionProjectState(ADDR, [
        {tokenId: '0', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: [], supply: '12'},
        {tokenId: '1', lifecycle: 'live', owner: null, tokenURI: null, fields: [], lockedFields: [], supply: '3'},
      ]),
    );
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
      const list = await getJson(base, '/v1/projects', {headers: auth('tok')});
      assert.equal(list.body.projects[0].copies, '15');

      const status = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}/status`, {headers: auth('tok')});
      assert.equal(status.body.copies, '15');

      const api = await getJson(base, '/api/projects');
      assert.equal(api.body[0].copies, '15');
    });
  });
});

test('register answers 200 with the counts when catch-up lands inside the deadline', async () => {
  await withStubCatchUp(async ({base, finish}) => {
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok', ABX_REGISTER_DEADLINE_MS: '5000'}, async () => {
      finish(); // catch-up is instant
      const {status, body} = await getJson(base, '/v1/projects', {
        method: 'POST',
        headers: auth('tok'),
        body: JSON.stringify({chainId: CHAIN_ID, address: ADDR, fromBlock: '100'}),
      });
      assert.equal(status, 200);
      assert.equal(body.mode, 'full');
      assert.equal(body.project.eventCount, 7);
      // The lifecycle rides the synchronous answer too, so a client reads `status` from one place
      // regardless of which shape it got.
      assert.equal(body.project.status, 'live');
    });
  });
});

test('register answers 202 + backfilling past the deadline; the registration is durable IMMEDIATELY and reaches live', async () => {
  await withStubCatchUp(async ({base, finish}) => {
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok', ABX_REGISTER_DEADLINE_MS: '20'}, async () => {
      const reg = await getJson(base, '/v1/projects', {
        method: 'POST',
        headers: auth('tok'),
        body: JSON.stringify({chainId: CHAIN_ID, address: ADDR, fromBlock: '100'}),
      });
      assert.equal(reg.status, 202);
      assert.equal(reg.body.accepted, true);
      assert.equal(reg.body.project.status, 'backfilling');
      assert.equal(reg.body.project.eventCount, undefined, 'no counts on a 202 — they do not exist yet');

      // DURABLE FIRST: the add survives a chain RPC that never answers, so it must be visible now.
      const list = await getJson(base, '/v1/projects', {headers: auth('tok')});
      assert.equal(list.body.projects.length, 1);
      assert.equal(list.body.projects[0].status, 'backfilling');

      const mid = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}/status`, {headers: auth('tok')});
      assert.equal(mid.body.status, 'backfilling');
      assert.equal(mid.body.attempts, 0, 'the stand-in catch-up does not stamp attempts; the field is still reported');

      finish();
      await new Promise((r) => setTimeout(r, 30));
      const done = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}/status`, {headers: auth('tok')});
      assert.equal(done.body.status, 'live');
    });
  });
});

test('a re-POST while catch-up is running answers 202 without starting a second reconstruct', async () => {
  await withStubCatchUp(async ({base, calls, finish, indexer}) => {
    // The real coalescing lives in SelfHostIndexer.reindexShared (see indexer/test/lifecycle.test.ts);
    // here the stand-in counts calls to prove the control plane routes BOTH posts through it.
    let inflight = 0;
    const shared = (indexer as unknown as {reindexShared: (a: string) => Promise<unknown>}).reindexShared;
    let pending: Promise<unknown> | null = null;
    (indexer as unknown as {reindexShared: unknown}).reindexShared = (address: string) => {
      if (pending) return pending;
      inflight += 1;
      pending = shared.call(indexer, address).finally(() => (pending = null));
      return pending;
    };
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok', ABX_REGISTER_DEADLINE_MS: '20'}, async () => {
      const body = JSON.stringify({chainId: CHAIN_ID, address: ADDR, fromBlock: '100'});
      const first = await getJson(base, '/v1/projects', {method: 'POST', headers: auth('tok'), body});
      const second = await getJson(base, '/v1/projects', {method: 'POST', headers: auth('tok'), body});
      assert.equal(first.status, 202);
      assert.equal(second.status, 202);
      assert.equal(inflight, 1, 'the second POST joined the in-flight catch-up');
      assert.equal(calls.length, 1);
      finish();
    });
  });
});

test('status reports the lifecycle, headBlock, and a credential-free failure class', async () => {
  await withNode(async (base, indexer) => {
    indexer.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null});
    indexer.store.putMeta(`watch:${CHAIN_KEY}:head`, '900');
    indexer.store.setIndexStatus(ADDR, {
      status: 'failed',
      error: {class: 'rpc_rate_limited', message: 'upstream RPC rate-limited; will retry'},
      attempts: 2,
    });
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
      const {body} = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}/status`, {headers: auth('tok')});
      assert.equal(body.status, 'failed');
      // headBlock is top-level so a client computes lag without knowing this node HAS a watcher.
      assert.equal(body.headBlock, '900');
      assert.equal(body.attempts, 2);
      assert.deepEqual(body.error, {class: 'rpc_rate_limited', message: 'upstream RPC rate-limited; will retry'});
      assert.doesNotMatch(JSON.stringify(body.error), /https?:\/\//);

      // The list carries the state + the class only (the hint stays on the detail route).
      const list = await getJson(base, '/v1/projects', {headers: auth('tok')});
      assert.equal(list.body.projects[0].status, 'failed');
      assert.deepEqual(list.body.projects[0].error, {class: 'rpc_rate_limited'});
    });
  });
});

test('a registration nothing has stamped yet reads as queued, never as a silent nothing', async () => {
  await withNode(async (base, indexer) => {
    indexer.store.register({address: ADDR, chainKey: CHAIN_KEY, fromBlock: '100', factory: null, registeredAt: 'now'});
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
      const {body} = await getJson(base, `/v1/projects/${CHAIN_ID}/${ADDR}/status`, {headers: auth('tok')});
      assert.equal(body.status, 'queued');
    });
  });
});

test('wrong method on a known path is a 405 naming the allowed method — never a silent fallthrough', async () => {
  await withNode(async (base) => {
    await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
      for (const [method, path, want] of [
        ['PUT', '/v1/projects', /POST \/v1\/projects/],
        ['GET', `/v1/projects/${CHAIN_ID}/${ADDR}`, /DELETE/],
        ['GET', `/v1/projects/${CHAIN_ID}/${ADDR}/reindex`, /POST/],
        ['POST', `/v1/projects/${CHAIN_ID}/${ADDR}/status`, /GET/],
        ['GET', '/v1/effect-artifacts', /POST/],
        ['GET', '/v1/effect-status', /POST/],
      ] as const) {
        const {status, body} = await getJson(base, path, {method, headers: auth('tok')});
        assert.equal(status, 405, `${method} ${path}`);
        assert.match(body.error, want);
      }
    });
  });
});

test('OPTIONS preflight answers with the headers a browser needs to send Authorization', async () => {
  await withNode(async (base) => {
    const res = await fetch(`${base}/v1/projects`, {method: 'OPTIONS'});
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/);
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /DELETE/);
  });
});

// ── the public-read error taxonomy ──────────────────────────────────────────────
// A bare `{error: 'not found'}` 404 was indistinguishable across three different problems, and a
// client that hand-built `/t/<chainId>/<addr>` (reaching for collection metadata) read its own
// mistake as a service outage. Each condition now carries a distinguishing machine `code`.
test('a KNOWN route with the wrong shape is 400 invalid_request naming the right template', async () => {
  await withNode(async (base) => {
    // /t/:chainId/:address with the token id dropped — the observed real-world mistake.
    const {status, body} = await getJson(base, `/t/${CHAIN_ID}/${ADDR}`);
    assert.equal(status, 400);
    assert.equal(body.code, 'invalid_request');
    assert.match(body.error, /\/t\/:chainId\/:address\/:id/);
    // and it points at the route that actually serves what they wanted
    assert.match(body.error, /\/c\/:chainId\/:address/);
    assert.equal(body.didYouMean, `/c/${CHAIN_ID}/${ADDR}`);
  });
});

test('a route that does not exist at all is 404 unknown_route — never confusable with an unindexed project', async () => {
  await withNode(async (base) => {
    const {status, body} = await getJson(base, '/tokens/1/0xabc');
    assert.equal(status, 404);
    assert.equal(body.code, 'unknown_route');
    assert.ok(Array.isArray(body.routes) && body.routes.length > 0);
  });
});

test('a well-formed path for a contract this node does not index is 404 not_registered', async () => {
  await withNode(async (base) => {
    const {status, body} = await getJson(base, `/c/${CHAIN_ID}/${ADDR}`);
    assert.equal(status, 404);
    assert.equal(body.code, 'not_registered');
    assert.match(body.hint, /abx add/);
  });
});

test('a path for a chain this node does not serve is 400 unsupported_chain + the chains it does', async () => {
  await withNode(async (base) => {
    const {status, body} = await getJson(base, `/t/999999/${ADDR}/0`);
    assert.equal(status, 400);
    assert.equal(body.code, 'unsupported_chain');
    assert.deepEqual(body.chains, [CHAIN_ID]);
  });
});

// ── the artifact registry: a POINTER registry, not an upload endpoint ─────────────────────────────
// `site/content/docs/protocol/effects.mdx → Bound vs referenced`. Which form is legal is decided by the output's
// BINDING, never by the producer, and BOTH mismatches are loud: accept-and-drop either leaves a token
// permanently unrenderable (media bytes discarded) or serves a confidently wrong answer (a locator
// recorded for traits, then never stitched).
const HASH = `0x${'ab'.repeat(32)}`;
const publish = (base: string, body: Record<string, unknown>) =>
  getJson(base, '/v1/effect-artifacts', {method: 'POST', headers: auth('tok'), body: JSON.stringify(body)});
const artifactBody = (extra: Record<string, unknown>) => ({
  chainId: CHAIN_ID,
  address: ADDR,
  tokenId: '0',
  inputsHash: HASH,
  ...extra,
});

test('a REFERENCED output must be a locator — bytes are refused, and the reason names the fix', async () => {
  await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
    await withNode(async (base) => {
      const ok = await publish(base, artifactBody({output: 'image', locator: 'ipfs://cid-1'}));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.mode, 'locator');

      const bytes = await publish(
        base,
        artifactBody({output: 'image', contentType: 'image/png', bytes_base64: Buffer.from([1, 2, 3]).toString('base64')}),
      );
      assert.equal(bytes.status, 400);
      assert.equal(bytes.body.code, 'invalid_request');
      assert.match(bytes.body.error, /REFERENCED/);
      assert.match(bytes.body.error, /locator/);
    });
  });
});

test('a BOUND output must be content — a locator is refused (it would record, then never stitch)', async () => {
  await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
    await withNode(async (base) => {
      const loc = await publish(base, artifactBody({output: 'traits', locator: 'ipfs://cid-traits'}));
      assert.equal(loc.status, 400);
      assert.equal(loc.body.code, 'invalid_request');
      assert.match(loc.body.error, /BOUND/);

      const ok = await publish(
        base,
        artifactBody({output: 'traits', bytes_base64: Buffer.from(JSON.stringify([{trait_type: 'P', value: 'x'}])).toString('base64')}),
      );
      assert.equal(ok.status, 200);
      assert.equal(ok.body.mode, 'bytes');
    });
  });
});

test('bound content over the 64KB cap is refused — a bound output can never become blob storage', async () => {
  await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
    await withNode(async (base) => {
      const {status, body} = await publish(
        base,
        artifactBody({output: 'traits', bytes_base64: Buffer.alloc(64 * 1024 + 1, 0x41).toString('base64')}),
      );
      assert.equal(status, 400);
      assert.equal(body.code, 'invalid_request');
      assert.match(body.error, /cap is 65536/);
    });
  });
});

test('a locator only the producer could resolve is refused — reachability, not durability', async () => {
  await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
    await withNode(async (base) => {
      // Scheme is NOT the test: an https gateway URL is a peer of ipfs:// / ar://. What fails is a
      // locator nobody else can resolve, or one that would rot (a presigned, expiring URL).
      for (const locator of ['https://gw.example/ipfs/cid-1', 'ar://tx-1', 'ipfs://cid-1']) {
        const {status} = await publish(base, artifactBody({output: 'image', locator}));
        assert.equal(status, 200, `${locator} should be accepted`);
      }
      for (const locator of [
        'http://localhost:8080/ipfs/cid-1',
        'http://127.0.0.1:9/x.png',
        'https://10.0.0.4/x.png',
        'https://bucket.example/x.png?X-Amz-Signature=deadbeef&X-Amz-Expires=900',
      ]) {
        const {status, body} = await publish(base, artifactBody({output: 'image', locator}));
        assert.equal(status, 400, `${locator} should be refused`);
        assert.match(body.error, /locator rejected/);
      }
    });
  });
});

test('superseded bound content is dropped eagerly — held bytes bounded by supply, not by param churn', async () => {
  await withEnv({ABX_RESOLVER_ADMIN_TOKEN: 'tok'}, async () => {
    await withNode(async (base, indexer) => {
      const traits = (v: string) => Buffer.from(JSON.stringify([{trait_type: 'P', value: v}])).toString('base64');
      const first = await publish(base, artifactBody({output: 'traits', bytes_base64: traits('one')}));
      assert.equal(first.status, 200);
      // a param change re-addresses the output: a second publish at a NEW inputsHash
      const secondHash = `0x${'cd'.repeat(32)}`;
      const second = await publish(base, artifactBody({output: 'traits', inputsHash: secondHash, bytes_base64: traits('two')}));
      assert.equal(second.status, 200);

      const older = indexer.store.getEffectArtifact(first.body.key as string)!;
      const newer = indexer.store.getEffectArtifact(second.body.key as string)!;
      assert.equal(older.bytes, null); // superseded content dropped…
      assert.ok(newer.bytes && newer.bytes.length > 0); // …current content held
      assert.equal(older.inputsHash, HASH.toLowerCase()); // the row itself survives, as provenance
    });
  });
});
