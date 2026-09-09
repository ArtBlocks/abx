// Local ABX data-directory discovery across project subdirectories. `abx status`
// (a READ path) run from a project subdirectory must find the SAME node a run from the project
// root would, instead of quietly opening a second, empty one — while a WRITE-shaped command
// (`abx forget`) from the identical subdirectory must NEVER discover, staying strict to cwd so
// nothing is ever created or mutated somewhere the operator didn't `cd` into. See
// packages/sdk/src/node.ts (resolveDataDir) for the shared rule and packages/cli/src/config.ts
// (DATA_DIR_DISCOVERY_COMMANDS) for the CLI's read/write allowlist.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {SqliteStore} from '@artblocks/abx-indexer';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
// An ABSOLUTE path to tsx's loader — these tests run the CLI with its OWN `cwd` set to a disposable
// temp directory (that's the whole point: data-dir resolution reads `process.cwd()`), so a bare
// `--import tsx` specifier — which every other CLI test uses, always from the repo root — fails to
// resolve from there (`ERR_MODULE_NOT_FOUND`). Resolving it here, once, from THIS file's own
// (repo-rooted) module context sidesteps that entirely.
const TSX_LOADER = import.meta.resolve('tsx');
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function runCli(args: string[], cwd: string, overrides: Record<string, string | undefined> = {}): Promise<{code: number | null; out: string}> {
  const env: NodeJS.ProcessEnv = {...process.env, ABX_NO_UPDATE_CHECK: '1'};
  delete env.ABX_DATA_DIR; // the outer test run may already have one set — this suite tests what happens with NONE
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((res) => {
    execFile(process.execPath, ['--import', TSX_LOADER, MAIN, ...args], {cwd, env, timeout: 30_000}, (err, stdout, stderr) => {
      const code = err && typeof (err as {code?: number}).code === 'number' ? (err as {code: number}).code : err ? 1 : 0;
      res({code, out: stripAnsi(`${stdout}\n${stderr}`)});
    });
  });
}

function scratch(): {root: string; cleanup: () => void} {
  // realpathSync: macOS resolves the system tmpdir through a `/var` → `/private/var` symlink, and
  // the CLI's OWN `process.cwd()` reports the resolved form — so comparing against the un-resolved
  // path here would spuriously fail every path assertion below.
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'abx-cli-datadir-')));
  return {root, cleanup: () => rmSync(root, {recursive: true, force: true})};
}

const dir = (...parts: string[]) => {
  const p = resolve(...parts);
  mkdirSync(p, {recursive: true});
  return p;
};

test('abx status, run from a project subdirectory, discovers the parent node and says so', async () => {
  const {root, cleanup} = scratch();
  try {
    const project = dir(root, 'my-project');
    dir(project, '.abx-self-host'); // a node already lives here (e.g. from an earlier `abx deploy`)
    const cwd = dir(project, 'contracts', 'src'); // a few levels deep, no data dir of its own

    const {code, out} = await runCli(['status'], cwd);
    assert.equal(code, 0, out);
    assert.match(out, /using the data directory found in a parent directory/);
    assert.match(out, /set ABX_DATA_DIR to pin one explicitly/);
    // The existing "data: <path>" readout (unchanged) proves it's the PARENT's node that answered.
    assert.match(out, new RegExp(`data: ${resolve(project, '.abx-self-host', 'index.db').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(out, /No projects yet/); // the discovered node is empty — a real, if empty, answer
  } finally {
    cleanup();
  }
});

test('abx status, run from an UNRELATED directory, never discovers a sibling project\'s node', async () => {
  const {root, cleanup} = scratch();
  try {
    dir(root, 'my-project', '.abx-self-host'); // exists, but is a SIBLING of cwd below, not an ancestor
    const cwd = dir(root, 'somewhere-else');

    const {code, out} = await runCli(['status'], cwd);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /using the data directory found in a parent directory/);
    assert.match(out, new RegExp(`data: ${resolve(cwd, '.abx-self-host', 'index.db').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(out, /No projects yet/);
  } finally {
    cleanup();
  }
});

test('a WRITE command (abx forget), run from the identical subdirectory, never discovers — stays strict to cwd', async () => {
  const {root, cleanup} = scratch();
  try {
    const project = dir(root, 'my-project');
    const projectDataDir = dir(project, '.abx-self-host');
    const ADDRESS = '0x1234567890123456789012345678901234567890';
    // Register a real project in the PARENT's store — if `forget` discovered it, this would
    // silently deregister a project belonging to a directory the operator never `cd`-ed into.
    const parentStore = new SqliteStore(projectDataDir);
    parentStore.register({address: ADDRESS, chainKey: 'sepolia', fromBlock: '0', factory: null, registeredAt: new Date().toISOString()});

    const cwd = dir(project, 'contracts', 'src');
    const {code, out} = await runCli(['forget', ADDRESS], cwd);
    assert.equal(code, 0, out);
    // Never even considered the parent — reports the address as untracked from a FRESH cwd node.
    assert.match(out, new RegExp(`${ADDRESS} isn't tracked by this node`));
    assert.doesNotMatch(out, /using the data directory found in a parent directory/);
    // And it did NOT touch the parent's registration — the real regression this test guards.
    assert.ok(parentStore.getRegistration(ADDRESS), 'the parent registration must survive untouched');
  } finally {
    cleanup();
  }
});

test('ABX_DATA_DIR overrides discovery outright, even from a subdirectory with a real parent node', async () => {
  const {root, cleanup} = scratch();
  try {
    const project = dir(root, 'my-project');
    dir(project, '.abx-self-host');
    const cwd = dir(project, 'contracts', 'src');
    const pinned = dir(root, 'pinned-elsewhere');

    const {code, out} = await runCli(['status'], cwd, {ABX_DATA_DIR: pinned});
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /using the data directory found in a parent directory/);
    assert.match(out, new RegExp(`data: ${resolve(pinned, 'index.db').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    cleanup();
  }
});
