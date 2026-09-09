// AbxServiceClient — the wire discipline of the SDK's one HTTP surface (service.ts): retry on
// weather (network/5xx/429), throw immediately on answers (4xx) with the parsed machine code.
// HTTP is mocked the repo way: a real node:http server on port 0.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {
  classifyIndexError,
  indexProgress,
  isAccepted,
  AbxIndexTimeoutError,
  AbxServiceClient,
  AbxServiceError,
  type RegisterProjectAccepted,
  type RegisterProjectSummary,
} from '../src/service.js';

type Handler = (req: IncomingMessage, res: ServerResponse, hit: number) => void;

async function withServer(handler: Handler, run: (base: string, hits: () => number) => Promise<void>): Promise<void> {
  let hits = 0;
  const server: Server = createServer((req, res) => handler(req, res, ++hits));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  try {
    await run(base, () => hits);
  } finally {
    server.close();
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
};

const client = (base: string, token?: string) => new AbxServiceClient({baseUrl: base, token, retryDelayMs: 1});

test('5xx retries with backoff and succeeds when the service recovers (fly cold-start weather)', async () => {
  await withServer(
    (req, res, hit) => (hit < 3 ? json(res, 503, {error: 'warming up'}) : json(res, 200, {projects: []})),
    async (base, hits) => {
      assert.deepEqual(await client(base, 't').listProjects(), []);
      assert.equal(hits(), 3);
    },
  );
});

test('a genuine 4xx throws IMMEDIATELY (no retry) with the parsed status + machine code', async () => {
  await withServer(
    (req, res) => json(res, 400, {error: 'this service serves chain 84532, not 1', code: 'unsupported_chain'}),
    async (base, hits) => {
      await assert.rejects(
        () => client(base, 't').registerProject({chainId: 1, address: '0x' + '1'.repeat(40)}),
        (err: unknown) => {
          assert.ok(err instanceof AbxServiceError);
          assert.equal(err.status, 400);
          assert.equal(err.code, 'unsupported_chain');
          assert.match(err.message, /chain 84532/);
          return true;
        },
      );
      assert.equal(hits(), 1); // an answer, not weather — never retried
    },
  );
});

test('nothing listening → status-0 AbxServiceError, and the descriptor probe does NOT grind the full ladder', async () => {
  const c = new AbxServiceClient({baseUrl: 'http://127.0.0.1:1', retryDelayMs: 1});
  await assert.rejects(
    () => c.descriptor(),
    (err: unknown) => {
      assert.ok(err instanceof AbxServiceError);
      assert.equal(err.status, 0);
      assert.match(err.message, /nothing responded/);
      // The descriptor is an interactive "is this even a service?" probe, usually against a typo —
      // it gets one retry, not four, so a wrong URL says so immediately.
      assert.match(err.message, /after 2 attempt/);
      return true;
    },
  );
});

test('a 5xx surfaces the SERVICE\'s own message, and says "failed" rather than "unreachable"', async () => {
  await withServer(
    (req, res) => json(res, 500, {error: 'internal error serving /v1/projects — see the node\'s logs', code: 'internal_error'}),
    async (base, hits) => {
      await assert.rejects(
        () => client(base, 't').listProjects(),
        (err: unknown) => {
          assert.ok(err instanceof AbxServiceError);
          assert.equal(err.status, 500);
          assert.equal(err.code, 'internal_error');
          // the server's words survive the retry ladder (they used to be discarded)
          assert.match(err.message, /see the node's logs/);
          assert.doesNotMatch(err.message, /unreachable/);
          return true;
        },
      );
      assert.equal(hits(), 4); // a 5xx is retryable weather
    },
  );
});

test('the bearer token rides every authed call; descriptor works without one', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/.well-known/abx-service') return json(res, 200, {interfaces: ['abx-token-api/v1'], chains: [84532], _auth: req.headers.authorization ?? null});
      if (req.headers.authorization !== 'Bearer key-1') return json(res, 401, {error: 'unauthorized', code: 'unauthorized'});
      return json(res, 200, {projects: [{chainId: 84532, address: '0xabc'}]});
    },
    async (base) => {
      const d = await client(base).descriptor(); // no token — descriptor is public
      assert.deepEqual(d.chains, [84532]);
      assert.equal((d as {_auth?: string | null})._auth, null); // no header sent without a token
      const projects = await client(base, 'key-1').listProjects();
      assert.equal(projects.length, 1);
      await assert.rejects(() => client(base, 'wrong').listProjects(), (e: AbxServiceError) => e.status === 401 && e.code === 'unauthorized');
    },
  );
});

test('feedback methods use the standard provider paths, preserve reports, and encode /mine filters', async () => {
  const seen: string[] = [];
  let posted = '';
  await withServer(
    (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.method === 'GET' && req.url === '/feedback') {
        assert.equal(req.headers.authorization, undefined, 'discovery does not require a token');
        return json(res, 200, {target: 'service', fields: {kind: {enum: ['bug']}}});
      }
      assert.equal(req.headers.authorization, 'Bearer feedback-key');
      if (req.method === 'POST') {
        req.on('data', (chunk) => (posted += String(chunk)));
        req.on('end', () => json(res, 201, {ok: true, id: 'fb-1', createdAt: '2026-08-25T00:00:00Z'}));
        return;
      }
      return json(res, 200, {
        feedback: [{id: 'fb-1', kind: 'bug', summary: 'render stuck', createdAt: '2026-08-25T00:00:00Z'}],
      });
    },
    async (base) => {
      assert.equal((await client(base, 'feedback-key').feedbackInstructions()).target, 'service');
      const authed = client(base, 'feedback-key');
      assert.equal(
        (
          await authed.submitFeedback({
            component: 'renderer',
            kind: 'bug',
            summary: 'render stuck',
          })
        ).id,
        'fb-1',
      );
      assert.equal(
        (await authed.listFeedback({component: 'renderer', kind: 'bug', limit: 5}))[0]?.summary,
        'render stuck',
      );
      assert.deepEqual(seen, [
        'GET /feedback',
        'POST /feedback',
        'GET /feedback/mine?component=renderer&kind=bug&limit=5',
      ]);
      assert.deepEqual(JSON.parse(posted), {component: 'renderer', kind: 'bug', summary: 'render stuck'});
    },
  );
});

test('removeProject: not_registered reports {removed:false}; disabled still THROWS', async () => {
  await withServer(
    (req, res) => {
      if (req.url?.includes('/84532/0xaaa')) return json(res, 404, {error: 'not registered', code: 'not_registered'});
      return json(res, 404, {error: 'control plane disabled', code: 'disabled'});
    },
    async (base) => {
      // already gone — idempotent forget, not an error
      assert.deepEqual(await client(base, 't').removeProject(84532, '0xaaa'), {removed: false});
      // a node that can't accept removals hasn't removed anything — this was the old silent-404 bug
      await assert.rejects(() => client(base, 't').removeProject(84532, '0xbbb'), (e: AbxServiceError) => e.code === 'disabled');
    },
  );
});

test('paths are versioned + chain-scoped exactly as the spec pins them', async () => {
  const seen: string[] = [];
  await withServer(
    (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      json(res, 200, {ok: true, mode: 'incremental', elapsedMs: 1, project: {address: '0xabc', name: null, eventCount: 0, tokenCount: 0, mintedCount: 0}});
    },
    async (base) => {
      const c = client(base, 't');
      await c.registerProject({chainId: 84532, address: '0xabc'});
      await c.reindexProject(84532, '0xabc');
      await c.projectStatus(84532, '0xabc');
      await c.removeProject(84532, '0xabc');
      assert.deepEqual(seen, [
        'POST /v1/projects',
        'POST /v1/projects/84532/0xabc/reindex',
        'GET /v1/projects/84532/0xabc/status',
        'DELETE /v1/projects/84532/0xabc',
      ]);
    },
  );
});

// ── the register lifecycle: two conformant answer shapes, and the wait loop ──────────────────

test('register normalizes BOTH answer shapes off the HTTP status: 200 → summary, 202 → accepted', async () => {
  await withServer(
    (req, res, hit) =>
      hit === 1
        ? json(res, 200, {ok: true, mode: 'full', elapsedMs: 12, project: {address: '0xabc', name: 'A', eventCount: 3, tokenCount: 1, mintedCount: 1}})
        : json(res, 202, {ok: true, project: {address: '0xabc', status: 'backfilling'}}),
    async (base) => {
      const c = client(base, 't');
      const sync = await c.registerProject({chainId: 84532, address: '0xabc'});
      assert.equal(isAccepted(sync), false);
      assert.equal(sync.accepted, false, 'derived from the status code even though the body omits it');
      assert.equal((sync as RegisterProjectSummary).project.eventCount, 3);

      const async_ = await c.registerProject({chainId: 84532, address: '0xabc'});
      assert.equal(isAccepted(async_), true);
      assert.equal((async_ as RegisterProjectAccepted).project.status, 'backfilling');
    },
  );
});

test('a 202 with no status at all still narrows to accepted (defaults to backfilling)', async () => {
  await withServer(
    (req, res) => json(res, 202, {ok: true}),
    async (base) => {
      const r = await client(base, 't').registerProject({chainId: 84532, address: '0xABC'});
      assert.ok(isAccepted(r));
      assert.deepEqual(r.project, {address: '0xABC', name: null, status: 'backfilling'});
    },
  );
});

test('a TIMED-OUT register is NOT re-POSTed: the client asks whether it landed and returns the async shape', async () => {
  const seen: string[] = [];
  await withServer(
    (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      // The register handler never answers — the shape of a cold reconstruct on a throttled RPC.
      if (req.url === '/v1/projects' && req.method === 'POST') return;
      json(res, 200, {chainId: 84532, address: '0xabc', status: 'backfilling', fromBlock: '1', toBlock: null, eventCount: 0, tokenCount: 0, mintedCount: 0, reconstructedAt: null});
    },
    async (base) => {
      const c = new AbxServiceClient({baseUrl: base, token: 't', timeoutMs: 60, retryDelayMs: 1});
      const r = await c.registerProject({chainId: 84532, address: '0xabc'});
      // Re-POSTing would have started a SECOND full reconstruct on a service already too slow to
      // answer — the retry storm this replaced. Exactly one POST, then a status read.
      assert.deepEqual(seen, ['POST /v1/projects', 'GET /v1/projects/84532/0xabc/status']);
      assert.ok(isAccepted(r));
      assert.equal(r.project.status, 'backfilling');
    },
  );
});

test('a timed-out register whose registration did NOT land keeps retrying (a genuinely dead service)', async () => {
  let posts = 0;
  await withServer(
    (req, res) => {
      if (req.method === 'POST') {
        posts += 1;
        return; // never answers
      }
      json(res, 404, {error: 'not registered', code: 'not_registered'});
    },
    async (base) => {
      const c = new AbxServiceClient({baseUrl: base, token: 't', timeoutMs: 40, retryDelayMs: 1});
      await assert.rejects(() => c.registerProject({chainId: 84532, address: '0xabc'}), /nothing responded|failed after/);
      assert.ok(posts > 1, 'no evidence it landed ⇒ the normal retry ladder still applies');
    },
  );
});

test('awaitIndexed polls to a terminal state, reports progress, and treats stale as "keep waiting"', async () => {
  const states = ['queued', 'backfilling', 'stale', 'live'];
  const seen: string[] = [];
  await withServer(
    (req, res, hit) =>
      json(res, 200, {
        chainId: 84532,
        address: '0xabc',
        status: states[Math.min(hit - 1, states.length - 1)],
        fromBlock: '100',
        toBlock: String(100 + hit * 10),
        headBlock: '140',
        eventCount: hit,
        tokenCount: 0,
        mintedCount: 0,
        reconstructedAt: null,
      }),
    async (base) => {
      const final = await client(base, 't').awaitIndexed(84532, '0xabc', {
        intervalMs: 1,
        onProgress: (s) => seen.push(s.status),
      });
      assert.equal(final.status, 'live');
      assert.deepEqual(seen, ['queued', 'backfilling', 'stale', 'live']);
    },
  );
});

test('awaitIndexed returns (not throws) on failed, and times out with the durability reassurance', async () => {
  await withServer(
    (req, res) =>
      json(res, 200, {
        chainId: 84532,
        address: '0xabc',
        status: 'failed',
        fromBlock: '1',
        toBlock: null,
        eventCount: 0,
        tokenCount: 0,
        mintedCount: 0,
        reconstructedAt: null,
        error: {class: 'rpc_rate_limited', message: 'upstream RPC rate-limited; will retry'},
      }),
    async (base) => {
      const r = await client(base, 't').awaitIndexed(84532, '0xabc', {intervalMs: 1});
      assert.equal(r.status, 'failed');
      assert.equal(r.error?.class, 'rpc_rate_limited');
    },
  );
  await withServer(
    (req, res) => json(res, 200, {chainId: 84532, address: '0xabc', status: 'backfilling', fromBlock: '1', toBlock: '2', eventCount: 0, tokenCount: 0, mintedCount: 0, reconstructedAt: null}),
    async (base) => {
      await assert.rejects(
        () => client(base, 't').awaitIndexed(84532, '0xabc', {intervalMs: 5, timeoutMs: 12}),
        (e: unknown) => {
          assert.ok(e instanceof AbxIndexTimeoutError);
          assert.equal(e.last?.status, 'backfilling');
          assert.match(e.message, /registration is durable/);
          return true;
        },
      );
    },
  );
});

test('a 5xx that volunteers a failure class surfaces it on the error (the wait-vs-broken distinction)', async () => {
  await withServer(
    (req, res) => json(res, 503, {error: 'upstream unavailable', code: 'internal_error', class: 'rpc_unavailable'}),
    async (base) => {
      await assert.rejects(
        () => client(base, 't').listProjects(),
        (e: AbxServiceError) => e.status === 503 && e.class === 'rpc_unavailable',
      );
    },
  );
});

// ── the closed error-class vocabulary + progress math (pure) ─────────────────────────────────

test('classifyIndexError maps upstream failures to the closed set and NEVER echoes the endpoint', () => {
  const keyed = 'https://eth-sepolia.g.example.io/v2/SUPER_SECRET_KEY';
  const cases: Array<[string, string]> = [
    [`HTTP request failed. URL: ${keyed} — 429 Too Many Requests`, 'rpc_rate_limited'],
    ['Request exceeded compute units per second capacity', 'rpc_rate_limited'],
    [`fetch failed. URL: ${keyed}`, 'rpc_unavailable'],
    ['The operation was aborted due to timeout', 'rpc_unavailable'],
    ['connect ECONNREFUSED 127.0.0.1:8545', 'rpc_unavailable'],
    ['Cannot read properties of undefined', 'internal'],
  ];
  for (const [message, want] of cases) {
    const got = classifyIndexError(new Error(message));
    assert.equal(got.class, want, message);
    // The whole point of a closed message set: a scrubber can be wrong, a fixed string cannot.
    assert.doesNotMatch(got.message ?? '', /SECRET|https?:\/\/|ECONNREFUSED/);
  }
});

test('indexProgress computes lag from fromBlock/toBlock/headBlock, and refuses to guess without a head', () => {
  const base = {chainId: 1, address: '0x', status: 'backfilling' as const, eventCount: 0, tokenCount: 0, mintedCount: 0, reconstructedAt: null};
  // A ratio is only meaningful mid-backfill. Once LIVE, `toBlock` advances only when the project has
  // events — so a current project on a busy chain would report a tiny percentage and read as broken.
  for (const status of ['live', 'stale', 'queued', 'failed'] as const) {
    assert.equal(indexProgress({...base, status, fromBlock: '100', toBlock: '150', headBlock: '99999'}), null, status);
  }
  assert.deepEqual(indexProgress({...base, fromBlock: '100', toBlock: '150', headBlock: '200'}), {done: 50n, total: 100n, percent: 50});
  assert.equal(indexProgress({...base, fromBlock: '100', toBlock: '150'}), null, 'no head ⇒ no ratio (never a fabricated percentage)');
  assert.equal(indexProgress({...base, fromBlock: '100', toBlock: null, headBlock: '200'}), null);
  // Past head (a stale head read) clamps rather than reporting >100%.
  assert.equal(indexProgress({...base, fromBlock: '100', toBlock: '400', headBlock: '200'})?.percent, 100);
});
