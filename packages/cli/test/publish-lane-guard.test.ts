// The publish topology's prerequisite, enforced at the CLI membrane.
//
// A resolver you don't share a disk with serves referenced output (the still, a video, a model) by
// REDIRECT — it takes a URL and refuses the bytes (`site/content/docs/protocol/effects.mdx → Bound vs referenced`).
// So a backend that can't name a public URL has no publish lane, and rendering against one is work
// spent to earn a 400.
//
// This used to "work" by shipping the bytes to the resolver, which made every conforming resolver an
// object store. Now the combination is refused BEFORE Chromium launches — enforcement, not a warning,
// because the warning version of this guidance is exactly what agents walked past.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const SOME_ADDR = '0xb5d472600107a56c0a36838fff7030a864439a30';

function run(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<{out: string; code: number}> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABX_CHAIN: 'base-sepolia',
    ABX_REMOTE_SELF_TOKEN: 'tok',
    ...extraEnv,
  };
  delete env.ABX_STORAGE_BACKEND;
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  return new Promise((res) => {
    execFile(process.execPath, ['--import', 'tsx', MAIN, ...args], {env, timeout: 120_000}, (err, stdout, stderr) => {
      const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({out: `${stdout}\n${stderr}`, code});
    });
  });
}

test('abx render --remote on the default fs backend is REFUSED, naming every way out', async () => {
  const {out, code} = await run(['render', SOME_ADDR, '--remote', 'https://resolver.example']);
  assert.equal(code, 1);
  assert.match(out, /can't produce a URL/);
  // The three that work are peers — the message must not rank them, and must include co-location.
  assert.match(out, /--backend cloud/);
  assert.match(out, /--backend ipfs/);
  assert.match(out, /--backend arweave/);
  assert.match(out, /co-located/);
});

test("the cloud backend without a public read base is caught too — it HAS a locator method that returns nothing", async () => {
  const {out, code} = await run(['render', SOME_ADDR, '--remote', 'https://resolver.example', '--backend', 'cloud'], {
    ABX_S3_ENDPOINT: 'https://s3.example',
    ABX_S3_BUCKET: 'b',
    ABX_S3_REGION: 'auto',
    ABX_S3_ACCESS_KEY_ID: 'k',
    ABX_S3_SECRET_ACCESS_KEY: 's',
    ABX_S3_PUBLIC_BASE: undefined,
  });
  assert.equal(code, 1);
  assert.match(out, /ABX_S3_PUBLIC_BASE/);
});

test('deploy-effects refuses to scaffold a hosted runner that could never publish', async () => {
  // The runner itself refuses to start on fs, so scaffolding it would deploy a container that exits.
  const {out, code} = await run(['deploy-effects', '--resolver-url', 'https://resolver.example'], {
    ABX_STORAGE_BACKEND: 'fs',
  });
  assert.equal(code, 1);
  assert.match(out, /can't serve renders off its own container disk/);
});

test('co-located rendering is untouched: no --remote, no locator requirement', async () => {
  // fs is fine when the runner and resolver share one backend — there is nothing to publish. This
  // fails later (no such project locally), which is the point: it got PAST the publish-lane guard.
  const {out} = await run(['render', SOME_ADDR]);
  assert.doesNotMatch(out, /can't produce a URL/);
});
