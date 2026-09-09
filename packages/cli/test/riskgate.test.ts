/**
 * The shared risk gate is the one choke point `runWrite`/`runMinterWrite`
 * (ownerops.ts) and the deploy family's resumed-setup send (main.ts) all route through now, instead
 * of each hand-rolling its own copy of "preview under --dry-run → optional --confirm → pick a lane
 * → sign". See riskgate.ts's module doc for the duplication this replaced.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseEther, zeroAddress, type Address, type Hex, type PublicClient} from 'viem';
import type {PreparedTx} from '@artblocks/abx-sdk';
import {confirmSend, gatedSend, laneFromFlags} from '../src/riskgate.js';
import type {Flags} from '../src/flags.js';

const SRC_DIR = resolve(import.meta.dirname, '../src');

/** Every `.ts` file directly under `src/`, plus `src/commands/*.ts` (`readdirSync` alone would
 *  silently stop covering the command bodies in the subdirectory).
 *  Returns paths relative to `SRC_DIR` (e.g. `flags.ts`, `commands/deploy.ts`) so callers' existing
 *  `file === 'x.ts'` exclusions keep working unchanged. */
function allSourceFiles(): string[] {
  const top = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));
  const cmds = readdirSync(resolve(SRC_DIR, 'commands'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `commands/${f}`);
  return [...top, ...cmds];
}

// ── laneFromFlags: the one place --sign/--unsigned/default-send is decided ───

test('laneFromFlags: default send; --sign → wallet; --unsigned → cold', () => {
  assert.equal(laneFromFlags({}), 'send');
  assert.equal(laneFromFlags({sign: 'true'}), 'sign');
  assert.equal(laneFromFlags({unsigned: 'true'}), 'unsigned');
  // `--sign --unsigned` used to resolve by precedence (unsigned won). It is refused now — see the
  // lane-flag tests at the bottom of this file for why a silent pick is the wrong answer.
  assert.throws(() => laneFromFlags({sign: 'true', unsigned: 'true'}), /pick ONE signing lane/);
});

// ── confirmSend: every path that must NEVER stall a script or hang a test ────

test('confirmSend: not opted in (no --confirm) resolves immediately, no prompt', async () => {
  await confirmSend('would do the thing', {});
});

test('confirmSend: --confirm + --yes proceeds silently (never blocks an agent that already said yes)', async () => {
  await confirmSend('would do the thing', {confirm: 'true', yes: 'true'});
});

test('confirmSend: --confirm on non-TTY stdin (every test runner, every script/CI) proceeds silently', async () => {
  // The realistic non-interactive case: this test process's stdin is not a TTY, exactly like a
  // script or an agent driving the CLI — confirmSend must never wait on input that will never come.
  assert.ok(!process.stdin.isTTY, 'sanity: this test process must not be attached to a TTY');
  await confirmSend('would do the thing', {confirm: 'true'});
});

// ── gatedSend: the dry-run short-circuit must precede ANY chain access ───────

function preparedTx(overrides: Partial<PreparedTx> = {}): PreparedTx {
  return {
    op: 'test.op',
    to: '0x000000000000000000000000000000000000dEaD' as Address,
    data: '0x' as `0x${string}`,
    value: '0x0',
    chainId: 11155111,
    summary: 'Do the test thing',
    fields: {foo: 'bar'},
    ...overrides,
  };
}

test('gatedSend: --dry-run returns null without ever resolving a chain/signer (no network, no key)', async () => {
  // chainKey is deliberately garbage (not a real/known chain) and there's no signing key anywhere —
  // if the dry-run branch touched the network or the signer, this would throw. It must not.
  const result = await gatedSend(preparedTx(), {'dry-run': 'true'} as Flags, {chainKey: 'not-a-real-chain'});
  assert.equal(result, null);
});

test('gatedSend: --dry-run with a builder provider calls it with the expectedSigner (or the zero address), not a live signer', async () => {
  let seenSigner: Address | undefined;
  const provider = (signer: Address) => {
    seenSigner = signer;
    return preparedTx();
  };
  await gatedSend(provider, {'dry-run': 'true'} as Flags, {chainKey: 'not-a-real-chain'});
  assert.equal(seenSigner, zeroAddress); // no expectedSigner given → the preview falls back to zero

  await gatedSend(provider, {'dry-run': 'true'} as Flags, {chainKey: 'not-a-real-chain', expectedSigner: '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as Address});
  assert.equal(seenSigner, '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C');
});

// ── regression: zero ad-hoc `flags['dry-run']` reads outside flags.ts ────────
// isDryRun(flags) is the ONE place that truthiness is decided (flags.ts). Every write command used
// to (or, for the minter path and the deploy-code resume send, still could have) hand-rolled its own
// `!!flags['dry-run']` — a fresh one could always drift. Lint the source directly: nothing outside
// flags.ts's own definition may read the raw flag.
test('no cli/src module reads the raw `dry-run` flag directly — every read goes through isDryRun()', () => {
  const rawPattern = /flags\[['"]dry-run['"]\]/;
  for (const file of allSourceFiles()) {
    if (file === 'flags.ts') continue;
    const src = readFileSync(resolve(SRC_DIR, file), 'utf8');
    assert.doesNotMatch(src, rawPattern, `${file} reads flags['dry-run'] directly — use isDryRun(flags) from flags.ts instead`);
  }
});

// ── regression: the local indexer is memoized, not reconstructed per call site ─
test('no cli/src module outside config.ts constructs `new SelfHostIndexer(...)` — every site uses localIndexer()', () => {
  const rawPattern = /new SelfHostIndexer\(/;
  for (const file of allSourceFiles()) {
    if (file === 'config.ts') continue;
    const src = readFileSync(resolve(SRC_DIR, file), 'utf8');
    assert.doesNotMatch(src, rawPattern, `${file} constructs its own SelfHostIndexer — use localIndexer() from config.ts instead`);
  }
});

// ── a verdict field may not be OPTIMISTIC by default ──────────────────────────
//
// Three separate defects in one sweep, all the same shape: the tool asserted an outcome it had not
// established.
//   · `verify --remote --json` printed `"ok": true` while exiting 1 on a project the resolver had
//     never heard of — the payload is emitted early and printed in its FINAL state, so a throwing
//     path left the optimistic initializer standing.
//   · `replace-script --dry-run` reported `status: 'would-succeed'` for a send that then failed for
//     insufficient funds, because the verdict never considered whether the signer could pay.
//   · `lock-field --token 0` previewed success for a write that would freeze the wrong (empty)
//     scope, leaving the value the creator can see unfrozen — on a PERMANENT operation.
//
// `ok` is documented as the field CI gates on, so an un-earned `true` is the one answer these
// surfaces must never give: "could not determine" is not "fine". Detecting "is this object later
// emitted?" statically is unreliable, so this is a TRIPWIRE with an explicit allowlist instead: a
// NEW optimistic success literal fails the test until someone justifies it here. That forces the
// decision at review time, which is the step all three bugs skipped. Same shape as the accepted
// advisories in scripts/check-production-audit.mjs.
const EARNED_SUCCESS_LITERALS: Record<string, string> = {
  // Written only after the handler has actually done the work it is acknowledging.
  'signer.ts': 'HTTP acks returned at the END of a successful browser-sign handler',
  'remote.ts': 'returned after a successful remote fetch, describing what came back',
  // The verdict TYPE lives here, and the one construction site is reached only after simulation
  // AND (since the sweep) a balance check. Guarded by its own tests, not by optimism.
  'riskgate.ts': 'the would-succeed verdict type + its post-simulation construction site',
  // Carries the explanatory comment for the fail-closed initializer, not a literal verdict.
  'commands/project.ts': 'prose comment documenting why the initializer is fail-closed',
};

test('no NEW optimistic success verdict appears in cli/src without a justification', () => {
  const optimistic = /ok:\s*true|['"]would-succeed['"]/;
  const offenders: string[] = [];
  for (const file of allSourceFiles()) {
    const src = readFileSync(resolve(SRC_DIR, file), 'utf8');
    if (!optimistic.test(src)) continue;
    if (!(file in EARNED_SUCCESS_LITERALS)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files assert success by DEFAULT: ${offenders.join(', ')}.\n` +
      `A verdict must be earned, not initialized — a path that throws before the checks run would\n` +
      `otherwise leave a confident "ok"/"would-succeed" standing (see verify --remote --json, which\n` +
      `printed ok:true while exiting 1). Make the default fail-closed and set the verdict where the\n` +
      `evidence exists; if this site genuinely earns it, add it to EARNED_SUCCESS_LITERALS with why.`,
  );
});

// ── the lane flags the help advertises are the lane flags the parser accepts ──────────────────
//
// `--send` is the default lane and was documented by name in 25 help strings
// ("signing: --send hot/env key · --sign wallet page · --unsigned print tx") while being the one of
// the three the deploy allowlist rejected. Typing what the help showed produced
// `unrecognized flag(s): --send` — the stray-flag guard, whose entire purpose is catching flags that
// would otherwise be silently ignored, firing on the tool's own documentation. Found by using the CLI
// as a cold reader of its own `--help`, which is the only way this class shows up.

test('laneFromFlags: --send is the hot/env lane, and bare is the same lane', () => {
  assert.equal(laneFromFlags({send: 'true'} as Flags), 'send');
  assert.equal(laneFromFlags({} as Flags), 'send');
  assert.equal(laneFromFlags({sign: 'true'} as Flags), 'sign');
  assert.equal(laneFromFlags({unsigned: 'true'} as Flags), 'unsigned');
});

test('laneFromFlags: a lane named with an EMPTY value still selects that lane', () => {
  // `--sign=` parses to `''`. Resolving lanes by truthiness sent that caller to the hot/env key —
  // they asked for a browser approval and would have got an unattended signature from the env key
  // instead, which is the only direction of this bug that costs anything. Presence selects.
  assert.equal(laneFromFlags({sign: ''} as Flags), 'sign');
  assert.equal(laneFromFlags({unsigned: ''} as Flags), 'unsigned');
  assert.equal(laneFromFlags({send: ''} as Flags), 'send');
});

test('laneFromFlags: two lane flags is refused, not silently resolved by precedence', () => {
  // The precedence order is an implementation detail. An agent assembling flags from two help lines
  // gets `--send --sign`, and silently picking the wallet page means a browser wait it reads as a
  // hang — so the refusal names all three lanes and what each does.
  for (const flags of [{send: '', sign: ''}, {send: '', unsigned: ''}, {sign: '', unsigned: ''}, {send: '', sign: '', unsigned: ''}]) {
    assert.throws(() => laneFromFlags(flags as Flags), /pick ONE signing lane/);
  }
});

test('every deploy family allowlist accepts the three lane flags its help documents', async () => {
  const {DEPLOY_FLAGS, DEPLOY_SERIES_FLAGS, DEPLOY_CODE_FLAGS} = await import('../src/commands/deploy.js');
  for (const [name, set] of [
    ['DEPLOY_FLAGS', DEPLOY_FLAGS],
    ['DEPLOY_SERIES_FLAGS', DEPLOY_SERIES_FLAGS],
    ['DEPLOY_CODE_FLAGS', DEPLOY_CODE_FLAGS],
  ] as Array<[string, Set<string>]>) {
    for (const lane of ['send', 'sign', 'unsigned']) {
      assert.ok(set.has(lane), `${name} rejects --${lane}, which its own help advertises`);
    }
  }
});

// ── the dry-run simulation must never turn a preview into a failure ──────────
// `--dry-run` gained an eth_call simulation. It is a BONUS on top of the preview, so every way it can
// fail — an unknown chain, no network, no signer, a target with no code — must degrade to a printed
// "unknown", never an throw. The test above already covers the unknown-chain case implicitly (it
// would throw inside makePublicClient); this states the invariant on purpose so a future refactor
// that moves the client construction out of the guard fails here.
test('gatedSend: --dry-run still succeeds offline, against an unknown chain, WITH a signer set', async () => {
  const result = await gatedSend(preparedTx(), {'dry-run': 'true'} as Flags, {
    chainKey: 'not-a-real-chain',
    expectedSigner: '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as Address,
  });
  assert.equal(result, null); // previewed and stopped — the simulation could not run, and that is fine
});

test('gatedSend: --dry-run --json emits the prepared transaction and simulation as data', async () => {
  const lines: string[] = [];
  const prior = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await gatedSend(preparedTx(), {'dry-run': 'true', json: 'true'} as Flags, {
      chainKey: 'not-a-real-chain',
      expectedSigner: '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as Address,
    });
  } finally {
    console.log = prior;
  }
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]!);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.sent, false);
  assert.equal(payload.transaction.op, 'test.op');
  assert.equal(payload.transaction.fields.foo, 'bar');
  assert.equal(payload.simulation.status, 'unknown');
});

// ── simulateDryRun's affordability check: the honest three-state answer ──────
//
// A funded on-chain sweep hit a dry run that reported `"status": "would-succeed"` for a send whose
// real gas need was 49% above what the preview ever looked at — because the preview never checked
// whether the signer could PAY, only whether the call's logic would revert. These exercise the fix
// against a fake client (no network, no live RPC) that stands in for `pinGas`'s own gas selection —
// the exact function the real send uses — so "would-succeed" here means what a real send would do.

const SIGNER = '0x0248A8d137bdAd8ed91D5Bf9eddcDC09d095b13C' as Address;

/** A minimal fake satisfying every client method `simulateDryRun` calls (`getCode`, `estimateGas` via
 *  `pinGas`, `getGasPrice`, `getBalance`). Defaults describe an ordinary, affordable, already-deployed
 *  target; each test overrides only what it's exercising. */
function fakeClient(overrides: {
  getCode?: PublicClient['getCode'];
  estimateGas?: PublicClient['estimateGas'];
  getGasPrice?: PublicClient['getGasPrice'];
  getBalance?: PublicClient['getBalance'];
}): PublicClient {
  return {
    getCode: async () => '0x6080604052' as Hex,
    estimateGas: async () => 100_000n,
    getGasPrice: async () => 1_000_000_000n, // 1 gwei
    getBalance: async () => parseEther('10'),
    ...overrides,
  } as unknown as PublicClient;
}

async function dryRunSimulation(tx: PreparedTx, client: PublicClient): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const prior = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await gatedSend(tx, {'dry-run': 'true', json: 'true'} as Flags, {chainKey: 'sepolia', expectedSigner: SIGNER, client});
  } finally {
    console.log = prior;
  }
  return JSON.parse(lines[0]!).simulation;
}

test('dry run: sufficient balance → would-succeed, carrying the REAL gas/cost (not gasFloor) so the send it previews can be trusted', async () => {
  const simulation = await dryRunSimulation(preparedTx(), fakeClient({}));
  assert.equal(simulation.status, 'would-succeed');
  // pinGas trusts a plausible estimate plus 25% headroom — the exact number `makeHotSender` would
  // send with, not a re-derived guess.
  assert.equal(simulation.estimatedGas, String((100_000n * 125n) / 100n));
  assert.ok(BigInt(simulation.balanceWei as string) >= BigInt(simulation.estimatedCostWei as string));
});

test('dry run: insufficient balance → would-revert, naming "insufficient funds" with the real numbers, never would-succeed', async () => {
  const simulation = await dryRunSimulation(preparedTx(), fakeClient({getBalance: async () => 1n}));
  assert.equal(simulation.status, 'would-revert');
  assert.match(simulation.reason as string, /insufficient funds/i);
  assert.match(simulation.reason as string, /short by/i);
  assert.equal(simulation.balanceWei, '1');
  assert.ok(BigInt(simulation.estimatedCostWei as string) > 1n);
});

test('dry run: an estimate that never clears the transaction\'s own provable floor is "unknown", never collapsed into would-succeed or would-revert', async () => {
  // A non-zero gasFloor with an estimate that stays under it forever is exactly the refusal a real
  // send makes (GasEstimateBelowFloorError, execute.ts's pinGas) — this proves the preview reports
  // the SAME "cannot be determined safe" rather than guessing either way.
  const tx = preparedTx({gasFloor: `0x${(1_000_000).toString(16)}` as Hex});
  const simulation = await dryRunSimulation(tx, fakeClient({estimateGas: async () => 10n}));
  assert.equal(simulation.status, 'unknown');
  assert.match(simulation.reason as string, /below the/i);
  assert.equal(simulation.estimatedGas, undefined);
  assert.equal(simulation.estimatedCostWei, undefined);
});
