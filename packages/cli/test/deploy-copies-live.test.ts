// `--copies` routes `deploy`/`deploy-series`/`deploy-code`/`predict` to their ERC-1155 edition
// twins' factories — CREATE2-canonical on both supported chains.
// These tests spawn the real CLI (matching the pattern in stray-flags.test.ts) against the live
// manifest + live default chain: a --copies dry run must resolve the REAL canonical edition
// factory (never a stale/absent one) and stop cleanly at the dry-run gate; predict must print a
// deterministic clone address for every edition lane.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join as joinPath, resolve} from 'node:path';

const CLI = resolve(import.meta.dirname, '../src/main.ts');
const FOR = '0x000000000000000000000000000000000000dEaD';

const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');

function run(args: string[]): {code: number; out: string} {
  try {
    const out = execFileSync('node', ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ABX_NO_UPDATE_CHECK: '1'},
      timeout: 30_000,
    });
    return {code: 0, out: plain(out)};
  } catch (e) {
    const err = e as {status?: number; stdout?: string; stderr?: string};
    return {code: err.status ?? 1, out: plain((err.stdout ?? '') + (err.stderr ?? ''))};
  }
}

// A real one-file media dir for deploy-series --copies (it globs --dir before anything else).
const mediaDir = mkdtempSync(joinPath(tmpdir(), 'abx-edition-fixture-'));
writeFileSync(joinPath(mediaDir, '0.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

// The canonical edition anchors (identical on both chains — see reference/deployments.mdx; the
// manifest in packages/sdk/src/deployments.ts is the source of truth these must agree with).
const ONE_OF_ONE_EDITION_FACTORY = '0x6ecc7fAd2186965BaECD0Aa215b00239a3459ddF';
const EDITION_FACTORY = '0xB6a8f051B08A8d6Fb0B6DA53BD23006CE2da31b7';
const EDITION_CODE_FACTORY = '0x9441Cc75318E20Ae6237EDb213b4C3019d756Bf0';

test('deploy --copies open: resolves the canonical OneOfOneEditionFactory, clean dry-run stop, exit 0', () => {
  const {code, out} = run(['deploy', '--copies', 'open', '--for', FOR, '--dry-run']);
  assert.equal(code, 0);
  assert.match(out, new RegExp(ONE_OF_ONE_EDITION_FACTORY, 'i'));
  assert.match(out, /dry run/);
});

test('deploy --copies 100: same canonical factory for a capped edition', () => {
  const {code, out} = run(['deploy', '--copies', '100', '--for', FOR, '--dry-run']);
  assert.equal(code, 0);
  assert.match(out, new RegExp(ONE_OF_ONE_EDITION_FACTORY, 'i'));
});

test('deploy-series --copies 50: resolves the canonical EditionImageFactory, clean dry-run stop', () => {
  const {code, out} = run(['deploy-series', '--copies', '50', '--dir', mediaDir, '--for', FOR, '--dry-run']);
  assert.equal(code, 0);
  assert.match(out, new RegExp(EDITION_FACTORY, 'i'));
});

test('deploy-code --copies 25: resolves the canonical EditionCodeFactory, clean dry-run stop', () => {
  const {code, out} = run(['deploy-code', '--copies', '25', '--script', '/dev/null', '--for', FOR, '--dry-run']);
  assert.equal(code, 0);
  assert.match(out, new RegExp(EDITION_CODE_FACTORY, 'i'));
});

// KNOWN RED until the pre-launch redeploy, and deliberately not relaxed.
//
// The anchor freshness probes now gate on `abxVersion()` (`ABX_CORE_VERSION`, bumped to 2 by the
// older implementation) instead of asking whether the implementation exposes some feature —
// a shape question every pre-remediation build also passed, which is why a stale anchor used to
// report as `resolved`. The `OneOfOneEditionFactory` recorded in the manifest predates that
// remediation, so the CLI correctly refuses it:
//
//   ✗ factory 0xe8b18A7D... is an older/incompatible version.
//
// That refusal is the control working. Do not soften this test, pin an override, or lower the gate
// to make it green — it goes green when the current contracts are deployed and the manifest is
// repointed, and staying red until then is the whole point of having the gate.
test('predict --copies (1/1 lane): prints a deterministic clone address from the live factory', () => {
  const {code, out} = run(['predict', '--copies', 'open', '--for', FOR]);
  assert.equal(code, 0);
  assert.match(out, /0x[0-9a-fA-F]{40}/);
});

test('predict --copies --dir (Series lane): prints a deterministic clone address', () => {
  const {code, out} = run(['predict', '--copies', '50', '--dir', mediaDir, '--for', FOR]);
  assert.equal(code, 0);
  assert.match(out, /0x[0-9a-fA-F]{40}/);
});

test('predict --copies --script (code lane): prints a deterministic clone address', () => {
  const {code, out} = run(['predict', '--copies', '25', '--script', '/dev/null', '--for', FOR]);
  assert.equal(code, 0);
  assert.match(out, /0x[0-9a-fA-F]{40}/);
});

test('predict without --copies is UNCHANGED: it targets the 721 factory, not an edition one', () => {
  const {out} = run(['predict', '--for', FOR]);
  assert.doesNotMatch(out, /edition/i);
});

test('--copies 1 is legal (not refused) but prints the single-copy advisory note', () => {
  const {out} = run(['deploy', '--copies', '1', '--for', FOR, '--dry-run']);
  assert.match(out, /single-copy ERC-1155 edition/);
});

test('--copies 0 is refused with a pointed message before anything else runs', () => {
  const {code, out} = run(['deploy', '--copies', '0', '--for', FOR, '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /ambiguous/);
});

test('deploy-code --copies + --no-delegation is refused: EditionCode has nothing to disable', () => {
  const {code, out} = run(['deploy-code', '--copies', '25', '--script', '/dev/null', '--no-delegation', '--for', FOR, '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /--no-delegation/);
  assert.match(out, /nothing to disable/);
});

// `--dep` on an EditionCode is now SUPPORTED — `EditionCode` already inherited the `Dependencies`
// extension and calls `_initDependencies()`, and the legs come from the SDK's shared
// `dependencySetupCalls`, so only the CLI had refused it. Verified live on Sepolia: `abx verify`
// reports "chain-complete — every dependency resolves to on-chain bytes" (a provenance claim, not an
// immutability one — a registry dep's bytes still live in the registry).
test('deploy-code --copies + --dep is ACCEPTED (on-chain deps work on the edition lane)', () => {
  const {code, out} = run([
    'deploy-code', '--copies', '100', '--script', '/dev/null', '--dep', 'p5@1.0.0',
    '--onchain-uri', '--name', 'Dep Edition', '--symbol', 'DEPED', '--for', FOR, '--dry-run',
  ]);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /not yet supported for edition code deploys/);
  assert.match(out, /\[0\] p5@1\.0\.0/); // listed in order — index 0 is the runtime by convention
  // This runs on the DEFAULT chain (base-sepolia), which has no AB Dependency Registry — so the SOFT
  // pointer leg is skipped with a warning and the deploy still proceeds. That is the documented
  // behavior, and it is why an on-chain-dep drop must target Sepolia to actually be chain-complete.
  assert.match(out, /no dependency registry known for this chain/);
});

// `--code-dir` on an EditionCode is supported — the directory-mode content step is a
// near-verbatim port of the 721 twin's own block (upload deferred past --dry-run/--confirm, the
// `code` collection field written from whatever locator the backend returns). `CODE_DIR` is the
// same fixture used by the 721 lane's own --code-dir tests: an index.html + a program, no upload
// actually happens under --dry-run (these assert the PLAN, never a real Pinata/Arweave write).
const CODE_DIR = resolve(import.meta.dirname, '../../../fixtures/code-drop-rehearsal/directory-build');

test('deploy-code --copies + --code-dir is ACCEPTED (hot lane): reaches Content, no scope-cut refusal', () => {
  const {code, out} = run(['deploy-code', '--copies', '25', '--code-dir', CODE_DIR, '--onchain-uri', '--backend', 'ipfs', '--for', FOR, '--dry-run']);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /not yet supported/);
  assert.doesNotMatch(out, /not supported for edition code deploys/);
  // The directory-mode Content step (upload deferred, never actually run under --dry-run) + the
  // generator resolving animation_url — both prove `hasProgram` sees a directory build, not just --script.
  assert.match(out, /2 file\(s\) from directory-build\/ → ipfs directory \(code field\)/);
  assert.match(out, /would point animation_url at the canonical generator/);
});

test('deploy-code --copies + --code-dir + --sign (browser-wallet lane) is ACCEPTED', () => {
  const {code, out} = run(['deploy-code', '--copies', '25', '--code-dir', CODE_DIR, '--onchain-uri', '--backend', 'ipfs', '--sign', '--for', FOR, '--dry-run']);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /not yet supported/);
});

test('deploy-code --copies + --code-dir refuses a storage backend with no directory upload (fs, the default)', () => {
  // Same refusal the 721 --code-dir lane gives for the identical combination — no --backend flag
  // means the LOCAL FS backend, which cannot serve a public directory upload at all. This check runs
  // in the Content step UNCONDITIONALLY (not gated by --dry-run), same as the 721 twin.
  const {code, out} = run(['deploy-code', '--copies', '25', '--code-dir', CODE_DIR, '--onchain-uri', '--for', FOR, '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /storage backend 'fs' has no directory upload/);
});

test('deploy-code --copies + --code-dir + --script is refused: pick one content mode', () => {
  const {code} = run(['deploy-code', '--copies', '25', '--code-dir', CODE_DIR, '--script', '/dev/null', '--for', FOR, '--dry-run']);
  assert.notEqual(code, 0);
});

// `--image-base` on an EditionCode is supported — a deterministic per-id off-chain still
// (`{base}/{id}.png`), the same field write as the 721 twin. The render sweep excludes an id with
// no live copies (harness.ts, unit-tested there); this end only proves the DEPLOY-TIME plan: the
// url-template bakes, across multiple premint ids (--max/--mint-count) and multiple copies each
// (--copies), and the mutual-exclusivity / localhost guards match the 721 lane exactly.
test('deploy-code --copies + --image-base is ACCEPTED: bakes a per-id url-template, across N ids × M copies', () => {
  const {code, out} = run([
    'deploy-code', '--copies', '10', '--script', '/dev/null', '--image-base', 'https://stills.example.com',
    '--max', '4', '--mint-count', '3', '--mint-amount', '10', '--public-base-url', 'https://meta.example.com',
    '--for', FOR, '--dry-run',
  ]);
  assert.equal(code, 0, out);
  assert.match(out, /on-chain url-template.*stills\.example\.com\/\{id\}\.png/);
  assert.match(out, /3 id\(s\) × 10 cop(y|ies)/); // 3 premint ids, 10 copies each — the multi-id × multi-copy case
});

test('deploy-code --copies + --image-base + --image-renderer is refused: pick one `image` write', () => {
  const {code, out} = run([
    'deploy-code', '--copies', '10', '--script', '/dev/null', '--image-base', 'https://stills.example.com',
    '--image-renderer', '0x000000000000000000000000000000000000dEaD', '--onchain-uri', '--for', FOR, '--dry-run',
  ]);
  assert.notEqual(code, 0);
  assert.match(out, /--image-renderer and --image-base both set the `image` field/);
});

test('deploy-code --copies + --image-base refuses a localhost URL, same as the 721 lane', () => {
  // The localhost/ipfs guards only WARN under --dry-run (matching the 721 lane) — the REAL refusal
  // fires before any signing/upload work, so this runs without --dry-run and still needs no key.
  const {code, out} = run([
    'deploy-code', '--copies', '10', '--script', '/dev/null', '--image-base', 'http://localhost:8787/stills',
    '--public-base-url', 'https://meta.example.com', '--for', FOR, '--name', 'X', '--symbol', 'XX',
  ]);
  assert.notEqual(code, 0);
  assert.match(out, /is localhost\/loopback/);
});

test('deploy-code --copies + --image-base refuses an ipfs-shaped URL (content-addressed, not a fixed per-id target)', () => {
  const {code, out} = run([
    'deploy-code', '--copies', '10', '--script', '/dev/null', '--image-base', 'https://ipfs.io/ipfs/bafybeituneshapedplaceholder/{id}.png',
    '--public-base-url', 'https://meta.example.com', '--for', FOR, '--name', 'X', '--symbol', 'XX',
  ]);
  assert.notEqual(code, 0);
  assert.match(out, /content-addressed/i);
});

// These two used to assert the OPPOSITE — that `--onchain-image` was refused on the edition lanes at
// all (deploy-series) and off the hot lane (deploy --copies). Both were CLI-plumbing gaps, not contract
// ones: the chunk store is a shared singleton and `OnChainMetadata`'s reader representation is
// standard-neutral, so the 721 staging path ported over as-is. What stays refused is the COLD
// lane, on every lineage alike — staging is a sequence where each chunk tx's receipt feeds the next,
// so it cannot be signed offline in one run.
test('deploy-series --copies + --onchain-image is ACCEPTED (bytes on-chain per id)', () => {
  const {code, out} = run(['deploy-series', '--copies', '50', '--dir', mediaDir, '--onchain-image', '--compress', 'fastlz', '--for', FOR, '--dry-run']);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /not yet supported for edition deploys/);
  // --onchain-image implies on-chain resolution, so no resolver URL is demanded or baked.
  assert.match(out, /resolves on-chain via the renderer/i);
});

test('deploy --copies + --onchain-image + --sign is ACCEPTED (one session signs staging + deploy)', () => {
  const svg = joinPath(mediaDir, 'one.svg');
  writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const {code, out} = run(['deploy', '--copies', '10', '--onchain-image', '--compress', 'fastlz', '--image', svg, '--sign', '--for', FOR, '--dry-run']);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /wired for the hot lane only/);
  // The staging tx(s) must be COUNTED — the wallet session's `total` and this line share one source.
  assert.match(out, /approvals\s+2 wallet approval\(s\)/);
});

// Real --name/--symbol: these run WITHOUT --dry-run (the cold lane is the thing under test), and the
// placeholder-identity refusal fires ahead of the staging guard on a real send — it only warns in a
// preview. Omitting them would test that refusal instead of this one.
for (const argv of [
  ['deploy-series', '--copies', '50', '--dir', mediaDir, '--onchain-image', '--compress', 'fastlz', '--name', 'Cold Lane', '--symbol', 'COLD', '--unsigned', '--for', FOR],
  ['deploy', '--copies', '10', '--onchain-image', '--compress', 'fastlz', '--image', joinPath(mediaDir, 'one.svg'), '--name', 'Cold Lane', '--symbol', 'COLD', '--unsigned', '--for', FOR],
] as string[][]) {
  test(`${argv[0]} --copies + --onchain-image is refused on the COLD lane (each chunk tx feeds the next)`, () => {
    writeFileSync(joinPath(mediaDir, 'one.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const {code, out} = run(argv);
    assert.notEqual(code, 0);
    assert.match(out, /needs interactive signing/);
  });
}

test('deploy --type series + --copies is refused: points at deploy-series --copies instead', () => {
  const {code, out} = run(['deploy', '--type', 'series', '--copies', '100', '--for', FOR, '--dry-run']);
  assert.notEqual(code, 0);
  assert.match(out, /deploy-series --copies/);
});

test('deploy-code --resume + --copies is refused at dispatch (nonsensical: --resume targets an EXISTING contract)', () => {
  // Refused before either body runs — doesn't even need a real --resume target for this to fire.
  const {code, out} = run(['deploy-code', '--resume', '0xC75761FBC5291014963B7FF45760326E7429C2Ee', '--copies', '25', '--script', '/dev/null']);
  assert.notEqual(code, 0);
  assert.match(out, /--resume cannot be combined with --copies/);
});
