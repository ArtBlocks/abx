// `ABX_CHAIN` set in a `.env` must actually select the chain.
//
// It didn't. `config.ts` derives `CHAIN` as a module-level const, so it evaluated while the import
// graph loaded — before `main()` called `loadDotEnv()`. Every other setting escaped this by being
// read lazily inside a function (`storageOptions()`, the signing key at send time), by which point
// `.env` was loaded. `ABX_CHAIN` was the one eager read, and the worst one to lose: the CLI
// announced `base-sepolia` and acted on it while the creator's `.env` said `sepolia`, with no error.
//
// A cold sandbox agent found it: asked for Sepolia, wrote it in `.env`, got a Base Sepolia preview
// and correctly called it "a serious trust problem for a tool whose pitch is 'here's exactly what
// would be deployed'". On a funded send it is a wrong-chain deploy with real artifacts at an address
// nobody meant — the same consequence that made the swallowed `--chain` flag worth fixing.
//
// The fixture dir lives INSIDE the repo on purpose: `loadDotEnv` returns at the first `.env` it finds
// walking up, so a nearer one wins over the repo's — and staying inside the tree keeps `tsx` and the
// workspace packages resolvable, which they are not from `/tmp`.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const CLI_SRC = resolve(import.meta.dirname, '../src');
const REPO = resolve(import.meta.dirname, '../../..');

/** A throwaway dir inside the repo holding just a `.env`, so it is the nearest one found. */
function withDotEnv<T>(contents: string, fn: (dir: string) => T): T {
  const dir = resolve(REPO, `.abx-test-dotenv-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, {recursive: true});
  writeFileSync(resolve(dir, '.env'), contents);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('CHAIN comes from a .env ABX_CHAIN, not just an exported one', () => {
  const chain = withDotEnv('ABX_CHAIN=sepolia\n', (dir) =>
    execFileSync(
      'node',
      ['--import', 'tsx', '-e', `import(${JSON.stringify(`${CLI_SRC}/config.ts`)}).then((m) => console.log(m.CHAIN))`],
      // ABX_CHAIN deliberately stripped from the environment: the ONLY source is the `.env`.
      {cwd: dir, encoding: 'utf8', env: {...process.env, ABX_CHAIN: undefined} as NodeJS.ProcessEnv, timeout: 60_000},
    ).trim(),
  );
  assert.equal(chain, 'sepolia', 'a .env ABX_CHAIN must win over the shipped default');
});

test('the shipped default still applies when no .env sets a chain', () => {
  const chain = withDotEnv('ABX_STORAGE_BACKEND=fs\n', (dir) =>
    execFileSync(
      'node',
      ['--import', 'tsx', '-e', `import(${JSON.stringify(`${CLI_SRC}/config.ts`)}).then((m) => console.log(m.CHAIN))`],
      {cwd: dir, encoding: 'utf8', env: {...process.env, ABX_CHAIN: undefined} as NodeJS.ProcessEnv, timeout: 60_000},
    ).trim(),
  );
  assert.equal(chain, 'base-sepolia', 'no ABX_CHAIN anywhere ⇒ the shipped default');
});

test('an unknown chain in .env is REFUSED, not silently ignored', () => {
  // The same ordering bug hid this guard too: `assertKnownChainEnv()` runs at main.ts module scope
  // and read `process.env.ABX_CHAIN`, so a `.env` typo read as "unset" and the CLI quietly proceeded
  // on the default. Loading `.env` before `config.ts` derives CHAIN fixes both, because config.ts is
  // imported before main.ts's own module body runs.
  const out = withDotEnv('ABX_CHAIN=mainnet\n', (dir) => {
    try {
      execFileSync('node', ['--import', 'tsx', `${CLI_SRC}/main.ts`, 'doctor'], {
        cwd: dir,
        encoding: 'utf8',
        env: {...process.env, ABX_CHAIN: undefined, ABX_NO_UPDATE_CHECK: '1'} as NodeJS.ProcessEnv,
        timeout: 60_000,
      });
      return '';
    } catch (e) {
      const err = e as {stdout?: string; stderr?: string};
      return (err.stdout ?? '') + (err.stderr ?? '');
    }
  });
  assert.match(out, /is not a recognized chain/);
  assert.match(out, /Production networks are disabled/, 'a mainnet-ish alias gets the production explanation');
});

test('a recognized but disabled production chain is REFUSED with its registry status', () => {
  const out = withDotEnv('ABX_CHAIN=base\n', (dir) => {
    try {
      execFileSync('node', ['--import', 'tsx', `${CLI_SRC}/main.ts`, 'doctor'], {
        cwd: dir,
        encoding: 'utf8',
        env: {...process.env, ABX_CHAIN: undefined, ABX_NO_UPDATE_CHECK: '1'} as NodeJS.ProcessEnv,
        timeout: 60_000,
      });
      return '';
    } catch (e) {
      const err = e as {stdout?: string; stderr?: string};
      return (err.stdout ?? '') + (err.stderr ?? '');
    }
  });
  assert.match(out, /ABX_CHAIN="base" is recognized but disabled/);
  assert.match(out, /chain 8453, production/);
  assert.match(out, /paired base-sepolia network/);
});
