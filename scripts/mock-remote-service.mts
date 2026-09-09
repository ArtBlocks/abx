/**
 * A local MOCK MANAGED PROVIDER — for testing the remote-services membrane without a live provider.
 *
 * The reference resolver IS a conforming remote service, so a provider is just the reference node
 * plus provider-identity env. This stands one up on :19000 with a tenant-style API key, a signup
 * URL, and an attached render runner (a stub /health on :19001) so the descriptor advertises
 * `render.attached: true` with declared effects — exactly what a real managed provider looks like
 * to `abx remote` / `abx add --remote`.
 *
 *   node --import tsx scripts/mock-remote-service.mts [--no-render] [--port 19000] [--chain sepolia]
 *
 * Pair it with a local chain for a fully hermetic fixture (see scripts/mock-remote-fixture.sh), or
 * point it at any chain your RPC serves. Used by the `hosting-managed-remote*` agent-eval scenarios,
 * and handy for a provider implementing site/content/docs/using-abx/remote-services.mdx to diff against.
 */
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', '19000'));
const RENDER_PORT = PORT + 1;
const CHAIN = arg('chain', 'sepolia')!;
const WITH_RENDER = !process.argv.includes('--no-render');
export const TENANT_KEY = arg('key', 'mock_test_key_not_secret')!;

// A stub render runner: only /health matters — it's what the resolver probes to fill the
// descriptor's `render.effects`. (A real provider's runner does the same, with real Chromium.)
if (WITH_RENDER) {
  createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(
      JSON.stringify({
        ok: true,
        effects: [
          {key: 'render', outputs: [{key: 'image', mimeType: 'image/png'}, {key: 'traits', mimeType: 'application/json'}]},
        ],
        queued: 0,
      }),
    );
  }).listen(RENDER_PORT, '127.0.0.1', () => console.log(`[mock] render runner  :${RENDER_PORT}`));
}

// Provider identity + config MUST be set before the server module loads (it reads chain/RPC at
// module scope), hence the dynamic import below.
process.env.ABX_CHAIN = CHAIN;
process.env.ABX_DATA_DIR = mkdtempSync(join(tmpdir(), 'abx-provider-'));
process.env.ABX_RESOLVER_ADMIN_TOKEN = TENANT_KEY;
process.env.ABX_SERVICE_NAME = 'Meridian Metadata';
process.env.ABX_SERVICE_SIGNUP_URL = 'https://meridian-metadata.example/signup';
process.env.ABX_SERVICE_DOCS_URL = 'https://meridian-metadata.example/docs';
process.env.ABX_PUBLIC_BASE_URL = `http://127.0.0.1:${PORT}`;
if (WITH_RENDER) process.env.ABX_EFFECTS_URL = `http://127.0.0.1:${RENDER_PORT}`;
else delete process.env.ABX_EFFECTS_URL;
// The watcher would poll a real RPC every 12s for every registered project — noise we don't need.
process.env.ABX_WATCH_INTERVAL_MS = '0';

const {SelfHostIndexer} = await import('../packages/indexer/src/index.js');
// Relative to THIS FILE (scripts/), which is what an ESM specifier resolves against — the old
// `./packages/token-api/src/server.js` silently meant `scripts/packages/...` and never existed.
// NOT by package name either: `@artblocks/abx-token-api` walks up node_modules and can resolve to a
// PUBLISHED build installed outside the repo, so the fixture would test the last release instead of
// the working tree (the same trap as a global `abx` — see CLAUDE.md).
const {startTokenApiServer} = await import('../packages/token-api/src/server.js');
const {url} = await startTokenApiServer({indexer: new SelfHostIndexer(), port: PORT});
console.log(`[mock] provider       ${url}  (chain=${CHAIN}, key=${TENANT_KEY.slice(0, 8)}…, render=${WITH_RENDER})`);
