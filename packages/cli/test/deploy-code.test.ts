import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer, type Server} from 'node:http';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {loopbackBaseUrl} from '../src/config.js';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');

/** A throwaway template sketch on disk — deploy-code's content step reads it before the dry-run
 *  plan, so the plan path needs a real file (the bytes are only chunked, never executed). */
function tmpSketch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-deploycode-'));
  const p = resolve(dir, 'sketch.js');
  writeFileSync(p, 'function setup(){createCanvas(400,400);noLoop();}\nfunction draw(){background(0);}\n');
  return p;
}

/** A ~60KB on-chain script (3 script chunks at the default 22KB chunk size) — the exact size a
 *  funded on-chain sweep found produces a setup transaction wanting 17,307,586 gas against the
 *  ~16,777,216 (2^24) `eth_estimateGas` ceiling when the whole setup rides one multicall. Newline-
 *  dense (many short statements) so `splitScriptChunks` always has somewhere to split. */
function tmpBigSketch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-deploycode-big-'));
  const p = resolve(dir, 'sketch.js');
  const lines = ['function setup(){createCanvas(400,400);noLoop();}', 'function draw(){background(0);}'];
  let bytes = lines.join('\n').length + 1;
  let i = 0;
  while (bytes < 60_000) {
    const line = `var pad${i} = ${i};`;
    lines.push(line);
    bytes += line.length + 1;
    i++;
  }
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

/** A template sketch that REPORTS traits (abx.traits) — exercises the traits-disposition check
 *  (a no-traits sketch reads as "none", not "omitted", so the warning path needs real traits). */
function tmpSketchWithTraits(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-deploycode-traits-'));
  const p = resolve(dir, 'sketch.js');
  writeFileSync(
    p,
    'function setup(){createCanvas(400,400);randomSeed(1);var r=floor(random(4,9));noLoop();\n' +
      "if(window.abx){abx.traits({Rings:r});abx.done();}}\nfunction draw(){background(0);}\n",
  );
  return p;
}

/** A template sketch that READS a PostParam (`td.palette`) — exercises the undeclared-param check. */
function tmpSketchWithParam(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-deploycode-param-'));
  const p = resolve(dir, 'sketch.js');
  writeFileSync(
    p,
    'var td=(window.abx&&abx.tokenData)||{};\nfunction setup(){createCanvas(400,400);background(td.palette||"#000");noLoop();}\nfunction draw(){}\n',
  );
  return p;
}

/** Env that guarantees NO signing key resolves (empty ⇒ the .env loader skips it, and an empty
 *  string is still falsy), so the "wallet-less creator" path is exercised regardless of the
 *  developer's real .env. SINGLE env name — SEPOLIA_FUNDED_PK / SEPOLIA_WALLET_PK are not read. */
const NO_KEY = {ABX_DEPLOYER_PK: ''};

/** Spawn the CLI (via tsx) with a HERMETIC env — the resolver-URL env vars are stripped so the
 *  test never picks up a developer's real `ABX_PUBLIC_BASE_URL`. */
function runCli(
  args: string[],
  overrides: Record<string, string> = {},
): Promise<{code: number | null; out: string}> {
  const env: NodeJS.ProcessEnv = {...process.env, ABX_CHAIN: 'sepolia'};
  delete env.ABX_PUBLIC_BASE_URL;
  delete env.ABX_DEV_ALLOW_LOCALHOST_URI;
  Object.assign(env, overrides);
  return new Promise((res) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', MAIN, ...args],
      {env, timeout: 60_000},
      (err, stdout, stderr) => {
        const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
        res({code, out: `${stdout}\n${stderr}`});
      },
    );
  });
}

function managedResolver(): Promise<{server: Server; baseUrl: string}> {
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/abx-service') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        service: {name: 'Managed Test'},
        interfaces: ['abx-token-api/v1', 'abx-control-plane/v1'],
        chains: [11155111],
        render: {
          attached: true,
          effects: [{
            key: 'render',
            outputs: [
              {key: 'image', mimeType: 'image/png'},
              {key: 'traits', mimeType: 'application/json'},
            ],
          }],
        },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolveReady) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolveReady({server, baseUrl: `http://127.0.0.1:${address.port}`});
    });
  });
}

// The shared guard predicate — one source of truth for the off-chain-deploy refusal across
// deploy / deploy-series / deploy-code (the drift between these is exactly how deploy-code
// shipped without the guard). A localhost/loopback base baked on-chain resolves for no one.
test('loopbackBaseUrl flags every localhost/loopback form and passes real public domains', () => {
  for (const u of [
    'http://localhost:8787',
    'http://localhost:8787/t',
    'https://127.0.0.1',
    'http://0.0.0.0:3000',
    'http://[::1]:8787',
    'https://LOCALHOST:8787',
  ]) {
    assert.equal(loopbackBaseUrl(u), true, `expected loopback: ${u}`);
  }
  for (const u of [
    'https://meta.you.xyz',
    'https://drift.fly.dev',
    'https://example.com:8787/t',
    'https://arweave.net',
  ]) {
    assert.equal(loopbackBaseUrl(u), false, `expected public: ${u}`);
  }
});

// The core regression: a code project always resolves through a resolver, so deploy-code must
// refuse a localhost/missing public URL — and refuse it BEFORE any network call (a pure config
// error), so this test needs no RPC and never touches chain.
test('deploy-code refuses a localhost/missing resolver URL, before any network call', async () => {
  const {code, out} = await runCli(['deploy-code', '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX']);
  assert.notEqual(code, 0, `expected non-zero exit; got ${code}\n${out}`);
  assert.match(out, /resolves for no one|no on-chain \/ no-server path/i);
  // The fix must not have regressed into an RPC/other error masquerading as the guard.
  assert.doesNotMatch(out, /ECONN|chainId|getChainId|factory/i);
});

// With the explicit DEV escape, the localhost guard is bypassed — the command proceeds past it
// (and fails later for other reasons), but must NOT print the localhost refusal.
test('deploy-code honors the ABX_DEV_ALLOW_LOCALHOST_URI escape (guard bypassed)', async () => {
  const {out} = await runCli(
    ['deploy-code', '--script', '/nonexistent.js', '--name', 'X', '--symbol', 'XX', '--dry-run'],
    {ABX_DEV_ALLOW_LOCALHOST_URI: '1'},
  );
  assert.doesNotMatch(out, /resolves for no one/i);
  assert.match(out, /DEV ONLY/i);
});

// A wallet-less creator must be able to PREVIEW the fully-on-chain lane. Regression: dry-run used
// to hard-throw "dry run needs a deployer" with no --for/key, blocking the exact "before I set up
// a key" persona. Now it prints the (deployer-independent) plan and only defers the deterministic
// address. --onchain-uri resolves the generator/renderer/factory from the manifest → no RPC needed.
test('deploy-code --onchain-uri dry-run previews with no --for and no signing key', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /dry run needs a deployer/i);
  assert.match(out, /deployer:\s*not set|pass .*--for/i);
  assert.match(out, /Deploy plan|chain-complete expectation/i);
});

// The ceiling this whole change targets, end to end: a 60KB script (3 chunks) used to ride ONE setup
// multicall wanting ~17.3M gas against the ~16.777M eth_estimateGas ceiling — failing with a useless
// "gas limit too high" and leaving a half-configured contract on chain. The dry-run plan must now
// report MORE than the old fixed 2 transactions (deploy + one setup multicall), and a small script
// (tmpSketch, well under one chunk) must still report exactly 2 — no behavior change for the common
// case (see the pure planCodeSetupBatches unit tests in deploy-code-setup-batches.test.ts for the
// gas-bounded batch shape itself).
test('deploy-code: a large on-chain script splits into MORE than one setup transaction; a small one stays at 2', async () => {
  const big = await runCli(
    ['deploy-code', '--script', tmpBigSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dry-run'],
    NO_KEY,
  );
  assert.equal(big.code, 0, big.out);
  const bigMatch = big.out.match(/transactions:\s*(\d+)/i);
  assert.ok(bigMatch, `expected a "transactions: N" line in:\n${big.out}`);
  const bigCount = Number(bigMatch![1]);
  assert.ok(bigCount > 2, `expected MORE than 2 transactions for a 60KB script, got ${bigCount}\n${big.out}`);
  assert.match(big.out, /approvals\s+\d+ wallet approval/i);
  assert.doesNotMatch(big.out, /gas limit too high/i); // never the raw, useless RPC error

  const small = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dry-run'],
    NO_KEY,
  );
  assert.equal(small.code, 0, small.out);
  const smallMatch = small.out.match(/transactions:\s*(\d+)/i);
  assert.ok(smallMatch, `expected a "transactions: N" line in:\n${small.out}`);
  assert.equal(Number(smallMatch![1]), 2, 'a small script must still be exactly 2 transactions (deploy + one setup tx)');
});

// --description was silently accepted and dropped on deploy-code (no on-chain description ever
// landed). It's now a real flag: written as an on-chain collection field and shown in the plan.
test('deploy-code recognizes --description and plans an on-chain collection field', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--description', 'a small poem', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /collection description.*on-chain/i);
  assert.doesNotMatch(out, /unrecognized flag/i); // --description is supported, not stray
});

// A typo'd / unsupported flag must WARN, not silently no-op (the silent no-op is how --description
// went unnoticed). Non-fatal — the command still runs; the warning just surfaces the mistake.
test('deploy-code warns on an unrecognized flag', async () => {
  const {out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--totally-bogus', 'zzz', '--dry-run'],
    NO_KEY,
  );
  assert.match(out, /unrecognized flag/i);
  assert.match(out, /--totally-bogus/);
});

// --image-base bakes an on-chain image url-template (off-chain thumbnails at a deterministic /{id} URL).
test('deploy-code --image-base plans an on-chain image url-template', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--image-base', 'https://cdn.example/orbit', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /on-chain url-template/i);
  assert.match(out, /https:\/\/cdn\.example\/orbit\/\{id\}\.png/);
  assert.doesNotMatch(out, /unrecognized flag/i);
});

// --attributes-renderer bakes an on-chain attributes field-renderer — but "traits on-chain" is NOT a
// free flag: the address must be a DEPLOYED Solidity renderer. A real session guessed one and put
// "traits on-chain" in a confirm readout. Dry-run must mark it PENDING VERIFICATION (a placeholder
// address has no code → a real deploy refuses it), never present it as settled.
test('deploy-code --attributes-renderer marks a placeholder renderer pending verification; rejects a non-address', async () => {
  const good = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--attributes-renderer', '0x000000000000000000000000000000000000dEaD', '--dry-run'],
    NO_KEY,
  );
  assert.equal(good.code, 0, good.out); // dry-run previews (warns), never throws
  assert.ok(good.out.toLowerCase().includes('0x000000000000000000000000000000000000dead'), good.out);
  // Whether the RPC is reachable (⇒ "NO code … NOT a deployed renderer") or not (⇒ "a real deploy
  // VERIFIES this is a deployed renderer"), the readout ties the flag to a DEPLOYED renderer — it is
  // never presented as settled on-chain traits off a bare address.
  assert.match(good.out, /deployed renderer/i);

  const bad = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--attributes-renderer', 'not-an-address', '--dry-run'],
    NO_KEY,
  );
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /must be a 0x address/i);
});

// The failure this whole change targets: a script that REPORTS traits, deployed fully-on-chain with
// NO resolver and NO --attributes-renderer, silently carries none of those traits to a marketplace.
// The dry-run must surface that up front (⚠ OMITTED) with the two ways to fix it — not let the agent
// discover it four decisions later.
test('deploy-code --onchain-uri warns when a script has traits but the lane carries none', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketchWithTraits(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /traits:.*OMITTED/i);
  assert.match(out, /--attributes-renderer/); // one fix offered
  assert.match(out, /--public-base-url/); // the other fix offered
});

// THE headline failure: --onchain-uri with no --image-base and no resolver = the on-chain image has
// no public destination. `abx render` to a local store is orphaned; marketplaces show a placeholder
// forever. The dry-run's Surfaces block must flag the thumbnail as having NO PUBLIC DESTINATION —
// not let the agent promise "render later is easy."
test('deploy-code --onchain-uri flags the thumbnail as having NO PUBLIC DESTINATION (orphaned render)', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /thumbnail:.*NO PUBLIC DESTINATION/i);
  assert.match(out, /ORPHANED/i);
  assert.match(out, /--image-base/); // the collection-wide fix
  assert.match(out, /set-field --field image/); // the per-token hatch
  assert.doesNotMatch(out, /CANNOT backfill/i);
  // A resolver OR an --image-base bucket clears it — with --image-base the thumbnail reads marketplace-visible.
  const good = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--image-base', 'https://cdn.example/orbit', '--dry-run'],
    NO_KEY,
  );
  assert.doesNotMatch(good.out, /NO PUBLIC DESTINATION/i);
  assert.match(good.out, /thumbnail:.*marketplace-visible/i);
});

// NEVER bake a localhost image host on-chain (same rule as the resolver base). A real deploy throws;
// dry-run says "would REFUSE".
test('deploy-code refuses a localhost --image-base', async () => {
  const {out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--image-base', 'http://localhost:9000/imgs', '--dry-run'],
    NO_KEY,
  );
  assert.match(out, /image-base.*(localhost|loopback)|resolves for NO marketplace/i);
});

// A real agent, helping with provisioning, baked R2's S3 API endpoint (auth-only) as --image-base —
// marketplaces get 403. Refuse the R2 API host and point at the public r2.dev / custom-domain URL,
// and name the EXACT ABX_S3_* upload vars (the agent had invented R2_* names abx never reads).
test('deploy-code refuses the R2 API endpoint as --image-base and names the real upload vars', async () => {
  const bad = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--image-base', 'https://acct.r2.cloudflarestorage.com', '--dry-run'],
    NO_KEY,
  );
  assert.match(bad.out, /r2\.dev|API endpoint|ABX_S3_ENDPOINT/i);
  assert.match(bad.out, /would REFUSE|403|NEVER public/i);
  // A public URL is accepted, and the readout names the exact upload vars (not guessed R2_* names).
  const good = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--image-base', 'https://pub-abc.r2.dev/orbit', '--dry-run'],
    NO_KEY,
  );
  assert.match(good.out, /ABX_S3_ENDPOINT.*ABX_S3_BUCKET.*ABX_S3_ACCESS_KEY_ID/s);
  assert.doesNotMatch(good.out, /would REFUSE/i);
});

// --image-base needs a mutable per-token URL that the effect runner overwrites in
// place — a content-addressed ipfs/arweave gateway URL can't be that (a re-upload gets a NEW
// address). This is checked against the URL's OWN shape, NOT this deploy's --backend/
// ABX_STORAGE_BACKEND (a separate, unrelated config — see the "regardless of --backend" case below,
// which is the exact scenario the R2-endpoint test above already covers on the default `fs` backend).
test('deploy-code refuses an ipfs/arweave-shaped --image-base (dry-run warns, real run refuses), independent of --backend', async () => {
  for (const url of ['https://ipfs.io/ipfs/bafybeigdyrzt.../{id}.png', 'https://arweave.net/abc123.../{id}.png']) {
    const dry = await runCli(['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--image-base', url, '--dry-run'], NO_KEY);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /would REFUSE/i);
    assert.match(dry.out, /content-addressed/i);
    // The same uniform row this WP adds to the dry-run also reflects the failure.
    assert.match(dry.out, /render\/storage\s+✗/);

    // Real (non-dry) run: the --image-base combo check runs during content-field assembly, well
    // before any signer is needed — so it refuses cleanly even with NO key configured at all.
    const real = await runCli(['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--image-base', url], NO_KEY);
    assert.notEqual(real.code, 0, real.out);
    assert.match(real.out, /content-addressed/i);
  }
});

test('deploy-code: a valid mutable-bucket --image-base is accepted on the DEFAULT fs backend — --backend is unrelated to --image-base validity', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--image-base', 'https://pub-abc.r2.dev/orbit', '--dry-run'],
    NO_KEY, // no --backend / ABX_STORAGE_BACKEND set at all → resolves to the fs default
  );
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /would REFUSE/i);
  assert.match(out, /render\/storage\s+✓/);
});

// The palette that got silently dropped: a script reading `td.palette` deployed without --schema must
// warn that the param is read but undeclared → dropped at render.
test('deploy-code warns when the script reads a PostParam not in --schema', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketchWithParam(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /postparams:.*palette/i);
  assert.match(out, /dropped|not.*in.*--schema|isn't in --schema/i);
  // Declaring it clears the warning.
  const good = await runCli(
    ['deploy-code', '--script', tmpSketchWithParam(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--schema', 'palette:HexColor:TokenOwner', '--dry-run'],
    NO_KEY,
  );
  assert.match(good.out, /postparams:.*1 declared/i);
  assert.doesNotMatch(good.out, /dropped at render/i);
});

// The fs render-home footgun bites the RESOLVER lane hardest: a hosted resolver can't read your
// laptop disk, so renders land nowhere it can serve → placeholder on OpenSea. The dry-run must warn
// on the resolver lane too (not only the no-resolver branch) and name the concrete fix.
test('deploy-code warns that fs render home is unreachable — on the resolver lane, with the fix', async () => {
  const bad = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--public-base-url', 'https://meta.example.xyz', '--dry-run'],
    {...NO_KEY, ABX_STORAGE_BACKEND: 'fs'},
  );
  assert.equal(bad.code, 0, bad.out);
  assert.match(bad.out, /render storage home is fs|fs.*LOCAL/i);
  assert.match(bad.out, /ABX_STORAGE_BACKEND=/); // names the concrete fix
  // A public backend clears it.
  const good = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--public-base-url', 'https://meta.example.xyz', '--dry-run'],
    {...NO_KEY, ABX_STORAGE_BACKEND: 'arweave'},
  );
  assert.doesNotMatch(good.out, /placeholder forever/i);
});

// A provider that declares an attached renderer owns both the runner and its output storage. The
// old readout recognized that once, then contradicted itself with local deploy-effects/fs guidance.
test('deploy-code treats an attached managed renderer as complete and never prescribes local rendering', async () => {
  const {server, baseUrl} = await managedResolver();
  try {
    const {code, out} = await runCli(
      ['deploy-code', '--script', tmpSketchWithTraits(), '--name', 'X', '--symbol', 'XX',
        '--public-base-url', baseUrl, '--dry-run'],
      {...NO_KEY, ABX_STORAGE_BACKEND: 'fs', ABX_DEV_ALLOW_LOCALHOST_URI: '1'},
    );
    assert.equal(code, 0, out);
    assert.match(out, /managed renderer/i);
    assert.match(out, /render\/storage\s+✓ managed by the resolver/i);
    assert.doesNotMatch(out, /stand up the runner|deploy-effects|placeholder forever|needs a backend that can name one/i);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((err) => err ? reject(err) : resolveClose()));
  }
});

// The in-chain SVG lane: NO --script/--code-dir, image + attributes are Solidity field renderers,
// --onchain-uri → the whole tokenURI is computed on-chain. This is the case where an on-chain
// tokenURI is unambiguously right (a small SVG, no browser, no bucket, no resolver).
test('deploy-code renderer-only (in-chain SVG): no script, --image-renderer + --attributes-renderer', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--image-renderer', '0x000000000000000000000000000000000000dEaD',
      '--attributes-renderer', '0x000000000000000000000000000000000000bEEf',
      '--onchain-uri', '--schema', 'palette:HexColor:TokenOwner', '--name', 'InChain', '--symbol', 'IC', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /no program|renderer-only/i);
  assert.match(out, /fully on-chain/i);
  // the image surface is ON-CHAIN (not the orphaned/placeholder warning) — no bucket/resolver needed.
  assert.match(out, /thumbnail:.*ON-CHAIN/i);
  assert.doesNotMatch(out, /NO PUBLIC DESTINATION/i);
  assert.doesNotMatch(out, /unrecognized flag/i); // --image-renderer is a real flag
});

// The fold: a renderer-only on-chain drop with NO param schema is a SINGLE tx (URI renderers + mint
// ride the deploy init; no setup multicall). Adding a PostParam schema makes it 2 tx, where the 2nd
// is purely the schema — not the old plumbing.
test('deploy-code renderer-only folds into 1 tx (no schema) / 2 tx (with schema)', async () => {
  const base = ['deploy-code', '--image-renderer', '0x000000000000000000000000000000000000dEaD',
    '--attributes-renderer', '0x000000000000000000000000000000000000bEEf', '--onchain-uri',
    '--name', 'X', '--symbol', 'XX', '--mint-count', '1', '--dry-run'];
  const one = await runCli(base, NO_KEY);
  assert.equal(one.code, 0, one.out);
  assert.match(one.out, /transactions:\s*1\b/i);
  assert.match(one.out, /single transaction|rides the deploy tx/i);

  const two = await runCli([...base, '--schema', 'palette:HexColor:TokenOwner'], NO_KEY);
  assert.equal(two.code, 0, two.out);
  assert.match(two.out, /transactions:\s*2\b/i);
  assert.match(two.out, /param schemas/i); // the 2nd tx is the schema, not plumbing
});

// image goes to exactly ONE place: reject --image-renderer together with --image-base.
test('deploy-code rejects --image-renderer together with --image-base', async () => {
  const {out} = await runCli(
    ['deploy-code', '--image-renderer', '0x000000000000000000000000000000000000dEaD',
      '--image-base', 'https://pub-abc.r2.dev/orbit', '--onchain-uri', '--name', 'X', '--symbol', 'XX', '--dry-run'],
    NO_KEY,
  );
  assert.match(out, /both set the .?image.? field|pick ONE/i);
});

// No program AND no field renderer is still an error (a misconfigured code deploy), but the message
// now points at the renderer-only escape hatch.
test('deploy-code with no script, no code-dir, no renderer errors with guidance', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--onchain-uri', '--name', 'X', '--symbol', 'XX', '--dry-run'],
    NO_KEY,
  );
  assert.notEqual(code, 0);
  assert.match(out, /--image-renderer|--script|--code-dir/);
});

// `--dep none` is the explicit zero-deps sentinel — it must NOT be parsed as a registry ref named
// "none" (which produced a bogus setDependency leg + a "NOT FOUND on registry" warning).
test('deploy-code --dep none means zero dependencies, not a registry ref', async () => {
  const {out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dep', 'none', '--dry-run'],
    NO_KEY,
  );
  assert.doesNotMatch(out, /NOT FOUND on registry/i);
  assert.doesNotMatch(out, /\[0\]\s*none/i);
});

// A large fully-on-chain tokenURI can revert on an unauthenticated public read (Etherscan "Read
// Contract" without a wallet) due to a client gas cap. The dry-run must pre-empt the mis-diagnosis
// (the real session blamed indexing lag + ran `abx index --full`).
test('deploy-code --onchain-uri surfaces the public-read gas caveat for a large document', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--dep', 'p5@1.0.0', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /public-read|Etherscan/i);
  assert.match(out, /gas cap|REVERT/i);
  assert.match(out, /not.*indexing|Do not run .*index --full/i); // pre-empts the mis-diagnosis
});

// The Surfaces block is the most-praised thing in the deploy preflight, and it contradicted itself:
// with BOTH renderers set it printed "thumbnail: ON-CHAIN ✓ / traits: on-chain ✓" and then, two lines
// later, "one or more surfaces resolve to NOTHING a marketplace can see", re-recommending the very
// flags already passed — because an undeclared param was folded into the broken-surface test. A
// dropped param is not a dead surface; the piece renders, that input takes its default.
test('Surfaces: an undeclared param alone never claims a surface resolves to NOTHING', async () => {
  // Any address WITH code on the test chain (sepolia): the dry run verifies code presence at the
  // renderer address, not that render() behaves. The canonical metadata renderer is a convenient
  // stand-in — an address with no code is correctly reported as an unusable renderer instead.
  const R = '0x5772249A8fA0bAFfD4B2e3378189465B4dB67417';
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketchWithParam(), '--name', 'X', '--symbol', 'XX',
     '--image-renderer', R, '--attributes-renderer', R, '--onchain-uri', '--max', '1', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /thumbnail: ON-CHAIN/i, 'the on-chain thumbnail must be reported as resolved');
  assert.doesNotMatch(out, /resolves? to NOTHING/i, 'a dropped param must not be called a dead surface');
  // ...and the milder, correct guidance is still given.
  assert.match(out, /dropped params render with their defaults/i);
});

// An on-chain image renderer has no off-chain still — so a runner, a bucket backend, and a "publishes
// a URL" warning are all inapplicable, whether or not a script also drives animation_url.
test('Surfaces: an on-chain image renderer is never told to stand up a render runner', async () => {
  // Any address WITH code on the test chain (sepolia): the dry run verifies code presence at the
  // renderer address, not that render() behaves. The canonical metadata renderer is a convenient
  // stand-in — an address with no code is correctly reported as an unusable renderer instead.
  const R = '0x5772249A8fA0bAFfD4B2e3378189465B4dB67417';
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketch(), '--name', 'X', '--symbol', 'XX',
     '--image-renderer', R, '--attributes-renderer', R, '--onchain-uri', '--max', '1', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /nothing to render/i);
  assert.doesNotMatch(out, /stand up the runner/i);
  assert.doesNotMatch(out, /needs a backend that can name one/i);
});

// The alarm must still fire — loudly and specifically — when a surface really is dead.
test('Surfaces: a script with no renderer and no resolver still reports BOTH surfaces dead', async () => {
  const {code, out} = await runCli(
    ['deploy-code', '--script', tmpSketchWithTraits(), '--name', 'X', '--symbol', 'XX', '--onchain-uri', '--max', '1', '--dry-run'],
    NO_KEY,
  );
  assert.equal(code, 0, out);
  assert.match(out, /thumbnail and traits surfaces resolve to NOTHING/i);
  assert.match(out, /--image-renderer/);
  assert.match(out, /--attributes-renderer/);
});
