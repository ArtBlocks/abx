/**
 * The drift guard for the structured deploy plan.
 *
 * `deploy.ts` populates the plan object from the SAME locals the prose already prints, at every emit
 * site, by hand. The two can drift if someone adds a NEW fact to the human readout and forgets the
 * plan object.
 *
 * This test cannot parse arbitrary prose perfectly, so it doesn't try to. Instead it runs a real
 * `--dry-run --json` lane, captures the human narration (stderr, under `--json`) and the JSON payload
 * (stdout) separately, and asserts that a curated list of plan-relevant values legible in the prose
 * also appear in `payload.plan`. A future change that adds a field to the prose and forgets the plan
 * fails here with a message that says exactly what to do about it.
 *
 * WHAT THIS DOES NOT COVER (be honest about the limits, not just the goal): the curated list below is
 * a sample of prose facts per lane, not an exhaustive re-parse of every line the human readout can
 * print — a NEW prose line this file doesn't already assert on can still drift silently. The
 * assertions below cover renderer address, on-chain image file metadata, and legs/approvals
 * consistency; they do not claim to cover every fact of the same shape. Widen this file whenever a
 * new plan-relevant prose field is added.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {DEPLOY_PLAN_SCHEMA_VERSION, type DeployPlanFamily} from '../src/deploy-plan.js';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const FOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const NO_KEY = {ABX_DEPLOYER_PK: ''};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, '');

// The message every assertion below fails with — a future maintainer who adds a line to the human
// readout and forgets the plan object should see exactly what broke and why, not a bare diff.
const DRIFT_MSG =
  'the human readout gained a field the plan object does not carry — add it to the plan (packages/cli/src/deploy-plan.ts + the matching emit() site in packages/cli/src/commands/deploy.ts).';

/** Run the CLI with stdout (the `--json` payload) and stderr (the human narration, redirected there
 *  under `--json` — see jsonout.ts's `withJson`) captured SEPARATELY, so the drift check can compare
 *  one against the other rather than a merged blob. */
function runCliSplit(args: string[], overrides: Record<string, string> = {}): Promise<{code: number | null; stdout: string; stderr: string}> {
  const env: NodeJS.ProcessEnv = {...process.env, ABX_CHAIN: 'sepolia'};
  delete env.ABX_PUBLIC_BASE_URL;
  delete env.ABX_DEV_ALLOW_LOCALHOST_URI;
  Object.assign(env, overrides);
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 60_000}, (err, stdout, stderr) => {
      const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({code, stdout: stdout.trim(), stderr: stripAnsi(stderr)});
    });
  });
}

function tmpSketch(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'abx-plan-drift-'));
  const p = resolve(dir, 'sketch.js');
  writeFileSync(p, 'function setup(){createCanvas(400,400);noLoop();}\nfunction draw(){background(0);}\n');
  return p;
}

// ── 1/1 lane: royalty bps, burnable, mint plan, approvals count, custody choice, URI base ─────────
test('deploy --dry-run --json: royalty/burnable/mint/approvals/custody/URI-base all agree between prose and plan', async () => {
  const {code, stdout, stderr} = await runCliSplit(
    ['deploy', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--burnable', '--royalty-bps', '750', '--public-base-url', 'https://example.abx.test', '--dry-run', '--json'],
    NO_KEY,
  );
  assert.equal(code, 0, stderr);
  const payload = JSON.parse(stdout);
  const plan = payload.plan;
  assert.ok(plan, `no plan object in the JSON payload:\n${stdout}`);

  // royalty bps
  assert.match(stderr, /royalty 7\.5% →/, `fixture drifted — expected a 7.5% royalty line:\n${stderr}`);
  assert.equal(plan.royalty.bps, 750, DRIFT_MSG);

  // burnable
  assert.match(stderr, /burnable yes/, `fixture drifted — expected burnable=yes in the prose:\n${stderr}`);
  assert.equal(plan.royalty.burnable, true, DRIFT_MSG);

  // mint plan
  assert.match(stderr, /mint: token #0 → 0x[0-9a-fA-F]{40} at deploy/, `fixture drifted — expected an immediate mint line:\n${stderr}`);
  assert.equal(plan.mint.deferred, false, DRIFT_MSG);
  assert.equal(plan.mint.count, 1, DRIFT_MSG);

  // approvals count — read the actual number out of the prose rather than assume it, so this test
  // doesn't silently stop checking anything if the fixture's own approval count ever changes.
  const approvalsLine = stderr.match(/approvals\s+(\d+) wallet approval\(s\)/);
  assert.ok(approvalsLine, `no approvals line in the prose:\n${stderr}`);
  assert.equal(plan.transactions.approvals, Number(approvalsLine![1]), DRIFT_MSG);

  // custody choice (off-chain, default `fs` backend)
  assert.match(stderr, /storage: fs /, `fixture drifted — expected off-chain fs custody:\n${stderr}`);
  assert.equal(plan.custody.backend, 'fs', DRIFT_MSG);

  // URI base
  assert.match(stderr, /tokenURI base {3}https:\/\/example\.abx\.test\/t/, `fixture drifted — expected the public base baked into tokenURI:\n${stderr}`);
  assert.equal(plan.custody.tokenUriBase, 'https://example.abx.test/t', DRIFT_MSG);
});

// ── code lane: the richest lane (adds approvals-from-a-setup-multicall + on-chain custody) ────────
test('deploy-code --dry-run --json: royalty/burnable/mint/approvals/on-chain-custody all agree between prose and plan', async () => {
  const script = tmpSketch();
  const {code, stdout, stderr} = await runCliSplit(
    ['deploy-code', '--script', script, '--onchain-uri', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--burnable', '--royalty-bps', '250', '--mint-count', '1', '--dry-run', '--json'],
    NO_KEY,
  );
  assert.equal(code, 0, stderr);
  const payload = JSON.parse(stdout);
  const plan = payload.plan;
  assert.ok(plan, `no plan object in the JSON payload:\n${stdout}`);

  assert.match(stderr, /royalty 2\.5%/, `fixture drifted — expected a 2.5% royalty:\n${stderr}`);
  assert.equal(plan.royalty.bps, 250, DRIFT_MSG);

  assert.match(stderr, /burnable/i, `fixture drifted — no burnable mention:\n${stderr}`);
  assert.equal(plan.royalty.burnable, true, DRIFT_MSG);

  assert.match(stderr, /mint: 1 token\(s\) in order → 0x[0-9a-fA-F]{40} at deploy/, `fixture drifted — expected an immediate mint line:\n${stderr}`);
  assert.equal(plan.mint.deferred, false, DRIFT_MSG);
  assert.equal(plan.mint.count, 1, DRIFT_MSG);

  const approvalsLine = stderr.match(/approvals\s+(\d+) wallet approval\(s\)/);
  assert.ok(approvalsLine, `no approvals line in the prose:\n${stderr}`);
  assert.equal(plan.transactions.approvals, Number(approvalsLine![1]), DRIFT_MSG);

  // on-chain custody choice — no resolver base, the metadata renderer resolves from chain
  assert.match(stderr, /resolution: ON-CHAIN/, `fixture drifted — expected ON-CHAIN resolution:\n${stderr}`);
  assert.equal(plan.custody.onChainUri, true, DRIFT_MSG);

  // renderer address — the "On-chain renderer" step's own line names it; the plan must carry the
  // SAME address, not just say "on-chain" (this was omitted entirely before).
  const rendererLine = stderr.match(/would resolve tokenURI\/contractURI ON-CHAIN via the renderer (0x[0-9a-fA-F]{40})/);
  assert.ok(rendererLine, `fixture drifted — expected an "on-chain renderer" line:\n${stderr}`);
  assert.equal(plan.custody.renderer, rendererLine![1], DRIFT_MSG);

  // legs/approvals consistency: a setup multicall rides ahead of the deploy
  // tx here (--onchain-uri needs setTokenURIRenderer/setContractURIRenderer calls), so approvals is
  // 2 (multicall + deploy) and legs must be non-null AND end with the deploy tx itself — the exact
  // omission the original finding flagged ("the deploy transaction itself is absent from its own leg
  // list"). A future regression that drops the trailing 'deploy' entry fails here.
  assert.ok(Array.isArray(plan.transactions.legs), `legs should be a non-null array when approvals > 1 (got ${JSON.stringify(plan.transactions.legs)}), ${DRIFT_MSG}`);
  assert.equal(plan.transactions.legs[plan.transactions.legs.length - 1], 'deploy', `legs must end with the deploy tx itself, ${DRIFT_MSG}`);
});

// ── 1/1 lane, --onchain-image regression ──────────────────────────────────────────────────────────
// Confirms the plan carries the renderer address and the on-chain image's file metadata — both
// printed by the human readout (the "On-chain renderer" step and the "Stage on-chain image" step)
// but originally absent from `payload.plan` entirely — and that `legs` ends with the deploy tx it
// used to silently omit even though `approvals` already counted it.
test('deploy --onchain-image --dry-run --json: renderer address, image file metadata, and legs/approvals all agree between prose and plan', async () => {
  const svgPath = tmpSketch().replace(/sketch\.js$/, 'image.svg');
  writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
  const {code, stdout, stderr} = await runCliSplit(
    ['deploy', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--onchain-image', '--image', svgPath, '--compress', 'fastlz', '--dry-run', '--json'],
    NO_KEY,
  );
  assert.equal(code, 0, stderr);
  const payload = JSON.parse(stdout);
  const plan = payload.plan;
  assert.ok(plan, `no plan object in the JSON payload:\n${stdout}`);

  // renderer address
  const rendererLine = stderr.match(/would use renderer (0x[0-9a-fA-F]{40})/);
  assert.ok(rendererLine, `fixture drifted — expected an "on-chain renderer" line:\n${stderr}`);
  assert.equal(plan.custody.renderer, rendererLine![1], DRIFT_MSG);

  // image file metadata — the "Stage on-chain image" line reports the raw byte count and the
  // post-compression (staged) byte count; the plan's `custody.image` must carry the SAME numbers.
  const stageLine = stderr.match(/would stage \S+ on-chain \(chunk store\): (\d+)B → \d+ chunk\(s\) \[fastlz \d+→(\d+)B\]/);
  assert.ok(stageLine, `fixture drifted — expected a "would stage … on-chain" line:\n${stderr}`);
  assert.ok(plan.custody.image, `no custody.image object in the plan (renderer address was fine — only the file metadata regressed), ${DRIFT_MSG}`);
  assert.equal(plan.custody.image.bytes, Number(stageLine![1]), DRIFT_MSG);
  assert.equal(plan.custody.image.stagedBytes, Number(stageLine![2]), DRIFT_MSG);
  // mimeType/contentHash have no prose counterpart on this lane (see deploy-plan.ts's own doc
  // comment) — sanity-checked, not drift-tested, so a missing prose line can never mask a real bug.
  assert.equal(plan.custody.image.mimeType, 'image/svg+xml');
  assert.match(plan.custody.image.contentHash, /^0x[0-9a-f]{64}$/);

  // legs/approvals consistency
  const approvalsLine = stderr.match(/approvals\s+(\d+) wallet approval\(s\)/);
  assert.ok(approvalsLine, `no approvals line in the prose:\n${stderr}`);
  assert.equal(plan.transactions.approvals, Number(approvalsLine![1]), DRIFT_MSG);
  assert.deepEqual(plan.transactions.legs, ['onchain-image-staging', 'deploy'], DRIFT_MSG);
});

// ── schema/version compatibility, across every lane the plan object covers ────────────────────────
// Cheap coverage of the acceptance criterion the full refactor would have addressed structurally:
// every lane's plan object carries the SAME schemaVersion and a family value from the closed union —
// so a consumer that switches on `family` can't be handed a lane this schema doesn't know about.
const FAMILIES: Array<{args: string[]; family: DeployPlanFamily}> = [
  {args: ['deploy', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--onchain-uri'], family: '1of1'},
  {args: ['deploy', '--copies', '3', '--for', FOR, '--name', 'X', '--symbol', 'XX', '--onchain-uri'], family: '1of1-edition'},
];

test('every deploy lane emits the same schemaVersion and a closed-union family', async () => {
  for (const {args, family} of FAMILIES) {
    const {code, stdout, stderr} = await runCliSplit([...args, '--dry-run', '--json'], NO_KEY);
    assert.equal(code, 0, `${args.join(' ')}:\n${stderr}`);
    const plan = JSON.parse(stdout).plan;
    assert.equal(plan.schemaVersion, DEPLOY_PLAN_SCHEMA_VERSION, `${family}: schemaVersion drifted`);
    assert.equal(plan.family, family, `${family}: family discriminator drifted`);
  }
});
