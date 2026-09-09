/**
 * Scaffolding + environment commands: `doctor` (check key/RPC/balance/factory/storage — and offer
 * to install/resync the agent skill), `mint-page` (a self-contained Next.js minting app),
 * `scaffold-renderer` (copy the Solidity on-chain-renderer starting point), and `skill` (install
 * the version-locked abx agent skill into a coding agent).
 */
import {cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join as joinPath, resolve as resolvePath, sep} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {
  type Address,
  isCurrentFactory,
  isCurrentOneOfOneEditionFactory,
  makePublicClient,
  type PublicClient,
  makeWalletClient,
  oneOfOneImageAbi,
  probeRpcEndpoints,
  resolveChain,
  rpcEnvVar,
  resolveRpcUrls,
  redactRpcUrl,
} from '@artblocks/abx-sdk';
import {arweaveAddress, probeStorageBackend, resolveBackend} from '@artblocks/abx-storage';
import {formatEther} from 'viem';
import {
  CHAIN,
  activeBackendId,
  arweaveKeyFilePath,
  factoryAddress,
  faucetHint,
  fixedPriceMinterAddress,
  fixedPriceMinter1155Address,
  oneOfOneEditionFactoryAddress,
  loadArweaveJwk,
  storageOptions,
} from '../config.js';
import {CliError} from '../errors.js';
import {type Flags, parseFlags, positionalArgs} from '../flags.js';
import {detectTokenKind, type TokenKindInfo} from '../kind.js';
import {PUBLIC_RPC, mintPageArtifact} from '../mintpage.js';
import {bold, c, dim, findCliPackageRoot, findRepoRoot, g, info, ok, step, warn} from '../output.js';
import {declinesSkillInstall} from '../prompt.js';
import {listConfiguredRemotes, misnamedRemoteVars, probeRemoteCredential, selfTokenMigrationWarning} from '../remote.js';
import {copyScaffold, SCAFFOLD_ANCHOR} from '../scaffold.js';
import {
  AGENT_SKILL_PARENTS,
  LEGACY_SKILL_DIR_NAMES,
  SKILL_DIR_NAME,
  binaryProvenance,
  checkForCliUpdate,
  compareVersions,
  installedSkillCopies,
  installedLegacySkillCopies,
  readCliVersion,
  readSkillName,
  readSkillVersion,
  skillRefreshCommands,
} from '../update-check.js';

// ── doctor ────────────────────────────────────────────────────────────────--
/**
 * Doctor's "want me to fix that?" for a missing or stale skill. Three lanes, deliberately:
 *   `--fix`      install without asking (CI, scripts, an agent running doctor for someone)
 *   interactive  name the exact directories, then ask — Enter accepts, since doctor's whole job is
 *                getting setup right and this is the one check whose fix is a local file copy
 *   non-TTY      change NOTHING and print how to do it; a diagnostic must never mutate a
 *                scripted environment just because nobody was there to say no
 * Honors `--global` / `--agent` so the fix can target the same place an explicit install would.
 */
export async function offerSkillInstall(flags: Flags, stale: boolean, indent: string): Promise<void> {
  const opts = {global: flags.global !== undefined, agent: flags.agent as string | undefined};
  const src = resolveBundledSkill();
  if (!src) return; // no bundled skill to install (dev checkout oddity) — the hint above still stands
  const verb = stale ? 'resync' : 'install';
  const dests = defaultSkillDests(opts);

  if (flags.fix === undefined) {
    if (!process.stdin.isTTY) {
      console.log(`${indent}${dim(`non-interactive — run \`abx doctor --fix\` (or \`abx skill install\`) to ${verb} it.`)}`);
      return;
    }
    const rl = createInterface({input: process.stdin, output: process.stdout});
    const answer = await new Promise<string>((resolve) => {
      // EOF (Ctrl-D) closes the interface WITHOUT firing the question callback — awaiting only the
      // callback would hang doctor forever. Treat a closed stream as a decline: the safe direction is
      // always "change nothing", never "write files because nobody answered".
      rl.once('close', () => resolve('n'));
      rl.question(`${indent}${verb} the abx skill into ${bold(dests)} now? [Y/n] `, resolve);
    });
    rl.close();
    if (declinesSkillInstall(answer)) {
      console.log(`${indent}${dim(`skipped — \`abx skill install\` when you want it.`)}`);
      return;
    }
  }
  console.log('');
  installSkillToDefaults(src, opts);
}

/**
 * The funding half of doctor's signing line. Split out because "is this wallet usable?" is not
 * `balance > 0`.
 *
 * `> 0n` is the wrong test: dust is not usable funding.
 *
 * So there are three states, not two. `DUST_FLOOR` is deliberately a readout threshold and NOT a
 * refusal — we do not estimate anyone's gas, and a cheap L2 deploy under it is the caller's call to
 * make. It only decides whether doctor hands over a faucet link.
 */
const DUST_FLOOR = 1_000_000_000_000_000n; // 0.001 ETH

export async function describeBalance(publicClient: PublicClient, address: Address): Promise<string> {
  const bal = await publicClient.getBalance({address});
  if (bal === 0n) return `empty — fund it (${faucetHint(CHAIN)})`;
  // Trimmed to 6 decimals: a wei-precise figure is unreadable at a glance and this line exists to
  // be glanced at. The exact number is one `cast balance` away for anyone who needs it.
  const eth = formatEther(bal);
  const short = eth.includes('.') ? `${eth.split('.')[0]}.${eth.split('.')[1].slice(0, 6).replace(/0+$/, '') || '0'}` : eth;
  if (bal < DUST_FLOOR) return `${short} ETH — too little to deploy; top it up (${faucetHint(CHAIN)})`;
  return `funded ${short} ETH`;
}

/** Actionable doctor detail for a configured remote whose credential is absent. */
export function describeMissingRemoteToken(name: string): string {
  return name.toLowerCase() === 'abx' ? 'no token — run abx auth login' : 'no token';
}

/** Continuation indent: aligns under a check/opt detail column. */
const CONT = ' '.repeat(17);

/**
 * Does every configured endpoint agree with itself about this wallet's nonce?
 *
 * `pending` is by definition >= `latest` on a coherent node. An endpoint that has not caught up with
 * its own head answers LOWER, and the first send of the next `abx` command re-uses a spent nonce —
 * silently, because a failed simulation means nothing is broadcast. Measured on `sepolia.base.org`;
 * never on the publicnode fallback. The write path floors at `max(pending, latest)` so this cannot
 * break a send any more — this names the endpoint instead of quietly routing around it.
 *
 * **Says "unknown" rather than passing on no evidence.** A wallet that has never sent reads 0/0
 * everywhere, which proves nothing about the endpoint — and a check that quietly goes green on no
 * signal is the same false green as an RPC answering `[]` because it pruned its logs.
 */
async function reportNonceCoherence(address: Address): Promise<void> {
  const urls = resolveRpcUrls(CHAIN);
  if (urls.length === 0) return;
  const behind: string[] = [];
  let sawAnyActivity = false;
  for (const url of urls) {
    const client = makePublicClient({chainKey: CHAIN, rpcUrl: url}); // one endpoint, no failover — we are testing THIS one
    try {
      const [pending, latest] = await Promise.all([
        client.getTransactionCount({address, blockTag: 'pending'}),
        client.getTransactionCount({address, blockTag: 'latest'}),
      ]);
      if (latest > 0 || pending > 0) sawAnyActivity = true;
      if (pending < latest) behind.push(`${redactRpcUrl(url)} (pending ${pending} < latest ${latest})`);
    } catch {
      // Unreachable endpoints are already the RPC check's business, not this one's.
    }
  }
  if (behind.length > 0) {
    console.log(`${CONT}${c.orange}⚠${c.reset}${dim(` nonce view is BEHIND its own head on: ${behind.join(', ')} — that endpoint can hand the next command a spent nonce. abx floors at max(pending, latest) so sends still work; put a coherent endpoint first in ${rpcEnvVar(CHAIN)} if you script against it directly`)}`);
  } else if (!sawAnyActivity) {
    console.log(`${CONT}${dim('nonce coherence: unknown — this wallet has sent nothing yet, so every endpoint reads 0 and the check has no signal')}`);
  }
}

export async function cmdDoctor(flags: Flags) {
  // Node goes in the header, not a check row: below the floor the CLI never reaches this function
  // (src/bin.ts refuses to start), so there is no failing state to render. It is here because
  // doctor's output is what people paste when reporting a problem, and the runtime is one of its
  // most useful diagnostic lines.
  console.log(bold('\n  abx doctor') + dim(`  ·  ${CHAIN}  ·  node ${process.version}`) + '\n');
  // Two visual tiers: PASS/FAIL checks (✓/✗) for things that are either working or broken, and an
  // "Optional" block (·) for path-dependent setup that is fine to be unset. We deliberately do NOT
  // use ⚠ for "unset but often fine" — that read as noise; ⚠ is reserved for a real gotcha (a
  // range-capped RPC). Labels are padded so both tiers align.
  // 16 = the longest label ('edition factory', 15) + a one-space gutter. It was 13, so that label
  // ran straight into its address (`edition factory0xe8b1…`) — unreadable on the one row whose
  // detail is a value you copy. Any label added here must fit, or this number moves.
  const check = (label: string, pass: boolean, detail = '') =>
    console.log(`  ${pass ? g('✓') : `${c.red}✗${c.reset}`} ${label.padEnd(16)}${detail ? dim(detail) : ''}`);
  const opt = (label: string, detail: string) => console.log(`  ${dim('·')} ${label.padEnd(16)}${dim(detail)}`);

  const hasKey = !!process.env.ABX_DEPLOYER_PK;

  // 1. Agent skill — FIRST and prominent. The primary way to use abx is to let a coding agent drive
  //    it, so a missing/stale skill is a ✗: not broken infra, but the main UX isn't set up. Its
  //    version lives in SKILL.md frontmatter (version-locked to this CLI). Notify-only — no exit code.
  const cliVersion = readCliVersion();
  const skillCopies = installedSkillCopies();
  const legacyCopies = installedLegacySkillCopies();
  const staleCopies = skillCopies.filter((copy) => compareVersions(cliVersion, copy.version) > 0);
  const staleSkills = [...new Set(staleCopies.map((copy) => copy.version))];
  const skillMissing = skillCopies.length === 0;
  const skillStale = !skillMissing && staleCopies.length > 0;
  const skillNeedsMigration = legacyCopies.length > 0;
  // Which copy, and the command that refreshes THAT copy — a bare `abx skill install` never touches
  // the global one, so naming it for a stale global copy printed a fix that could not clear the ✗.
  const skillFix = skillRefreshCommands([...staleCopies, ...legacyCopies]).join(' && ');
  const staleWhere = staleCopies.length === 1 ? ` (${staleCopies[0].scope}: ${staleCopies[0].path})` : '';
  if (skillNeedsMigration) {
    const where = legacyCopies.length === 1 ? ` (${legacyCopies[0].scope}: ${legacyCopies[0].path})` : ` (${legacyCopies.length} copies)`;
    check('agent skill', false, `legacy abx-self-host skill still active${where} — migrate: ${g(skillFix)}`);
    for (const copy of legacyCopies) console.log(`${CONT}${dim(`${copy.scope}: ${copy.path}`)}`);
    console.log(`${CONT}${dim('the installer archives the old folder outside the discovery tree; it does not delete customizations')}`);
  } else if (skillMissing) {
    check('agent skill', false, `not installed — run ${g('abx skill install')}`);
    console.log(`${CONT}${dim('(recommended: let a coding agent drive abx)')}`);
  } else if (skillStale) {
    check('agent skill', false, `v${staleSkills.join(', v')} behind CLI v${cliVersion}${staleWhere} — run ${g(skillFix)}`);
  } else {
    check('agent skill', true, `in sync (v${cliVersion})`);
  }
  // Offer to fix it here rather than only naming the command. `npm i -g` + `abx skill install` was a
  // two-step install flow where the second step is easy to skip and invisible when skipped (an agent
  // that never learned abx just... doesn't use it). Doctor is already the documented first run, so
  // this collapses the flow without an npm `postinstall` hook — which could not work anyway: npm runs
  // lifecycle scripts with cwd set to the installed package dir (so the skill would land inside
  // node_modules), pnpm gates install scripts by default, and writing to a user's ~/.claude on
  // install is the kind of side effect that belongs to the user, not to us.
  if ((skillMissing || skillStale) && !skillNeedsMigration) {
    await offerSkillInstall(flags, skillStale, CONT);
  }
  console.log('');

  // 2. Core environment (✓/✗). Signing-wallet balances are computed here (they need the RPC) but
  //    printed in the Optional block below, so buffer them.
  let signingOpt: string | null = null;
  let minter1155Opt: string | null = null;
  let forOpt: string | null = null;
  try {
    const publicClient = makePublicClient({chainKey: CHAIN});
    const bn = await publicClient.getBlockNumber();
    // Collapse the RPC report to one line (best endpoint + head), and only add a ⚠ when there is a
    // genuine problem — a range-capped-only set that will grind a resolver under load.
    const probes = await probeRpcEndpoints({chainKey: CHAIN});
    const usable = probes.filter((pr) => pr.verdict !== 'unusable');
    const best = probes.find((pr) => pr.verdict === 'best') ?? usable[0];
    if (usable.length > 0) {
      check('RPC', true, `${best.label} · head ${bn} · ${best.verdict === 'best' ? 'wide range + archive' : 'range-capped'}`);
      if (!probes.some((pr) => pr.verdict === 'best')) {
        console.log(`${CONT}${c.orange}⚠${c.reset}${dim(' every endpoint is getLogs-range-capped — add a wide-range archive RPC to ABX_RPC_URLS before running a resolver under load')}`);
      }
      // Name a REACHABLE endpoint that can't serve history — but ONLY when it would actually be asked.
      //
      // The hazard is ordering, not existence: the fallback transport tries endpoints IN ORDER and
      // rotates only on an *error*, so a pruning endpoint listed AHEAD of a good one still answers a
      // deep scan, with an empty and successful `[]`. That is worth a ⚠ every time. A pruning endpoint
      // sitting BEHIND a healthy archive endpoint is never consulted for history and is not a problem
      // the reader can act on — and firing anyway made `doctor` look alarming on a clean setup. Three
      // separate eval rooms flagged the noise; one called it "a poor first impression for an already-
      // nervous creator". `probeRpcEndpoints` preserves `resolveRpcUrls` order, so the index IS the
      // consultation order.
      const bestIdx = probes.findIndex((pr) => pr.verdict === 'best');
      for (const [i, pr] of probes.entries()) {
        if (pr.verdict !== 'unusable' || !pr.reachable) continue;
        if (bestIdx !== -1 && i > bestIdx) continue; // shadowed by a healthy archive endpoint ahead of it
        console.log(`${CONT}${c.orange}⚠${c.reset}${dim(` ${pr.label} is listed ahead of a full-archive endpoint and can't reconstruct an older project: ${pr.reason ?? 'no archive-depth logs'}. Put a full-archive endpoint FIRST in ${rpcEnvVar(CHAIN)} — the fallback transport rotates on error only, so this one answers a deep scan with an empty, successful []`)}`);
      }
    } else {
      check('RPC', false, `${CHAIN} — no endpoint usable for reconstruction; add a wide-range archive RPC to ABX_RPC_URLS`);
    }

    const factory = factoryAddress();
    if (factory) {
      const code = await publicClient.getCode({address: factory as Address});
      if (!code || code === '0x') check('factory', false, `${factory} — no code on ${CHAIN}; \`abx deploy\` redeploys`);
      else if (await isCurrentFactory(publicClient, factory as Address)) check('factory', true, factory);
      else check('factory', false, `${factory} — older/incompatible; \`abx deploy\` redeploys`);
    } else {
      check('factory', false, 'none yet — `abx demo` deploys one');
    }

    // The edition twin — same shape as the 721 `factory` check above (isCurrent* probe, same
    // pass/fail posture on "no code yet"). The other two edition factories (EditionImage/
    // EditionCode) and the two edition-related singletons that have no analogous check today
    // either (the 1155 minter, and — same as the 721 minter — no code-version probe to run) are
    // left to their own commands' own bootstrap (`abx deploy-series --copies` / `deploy-code
    // --copies` / `minter configure --token-id`) rather than duplicating a fourth/fifth check here.
    const editionFactory = oneOfOneEditionFactoryAddress();
    if (editionFactory) {
      const code = await publicClient.getCode({address: editionFactory as Address});
      if (!code || code === '0x') check('edition factory', false, `${editionFactory} — no code on ${CHAIN}; \`abx deploy --copies <n|open>\` redeploys`);
      else if (await isCurrentOneOfOneEditionFactory(publicClient, editionFactory as Address)) check('edition factory', true, editionFactory);
      else check('edition factory', false, `${editionFactory} — older/incompatible; \`abx deploy --copies <n|open>\` redeploys`);
    } else {
      check('edition factory', false, 'none yet — `abx deploy --copies <n|open>` deploys one');
    }

    // The shared edition sale singleton — Optional, not pass/fail: unlike the factory (a platform
    // allowlist anchor), a project that never sells through the shared minter has no reason to have
    // one deployed yet (same reason there is no equivalent 721 `fixedPriceMinter` check above).
    const minter1155 = fixedPriceMinter1155Address();
    if (minter1155) {
      const code = await publicClient.getCode({address: minter1155 as Address});
      minter1155Opt = code && code !== '0x' ? minter1155 : `${minter1155} configured but no code on ${CHAIN} — \`abx minter configure <addr> --token-id <n> …\` redeploys`;
    }

    if (hasKey) {
      const {account} = makeWalletClient({chainKey: CHAIN});
      signingOpt = `env key ${account.address} · ${await describeBalance(publicClient, account.address)}`;
      await reportNonceCoherence(account.address);
    }
    if (flags.for) {
      forOpt = `${flags.for} · ${await describeBalance(publicClient, flags.for as Address)}`;
    }
  } catch (err) {
    check('RPC', false, (err as Error).message);
  }

  // Storage backend — resolve it (catches missing config), then probe liveness/creds. The probe
  // is the fuller `probeStorageBackend` (packages/storage/probe.ts), not a bare `.health()` call —
  // for fs/ipfs that's the SAME check as before (reused, not reimplemented); for cloud it's now a
  // real PUT (API) + GET (public base) round trip — the only thing that catches the R2/S3
  // endpoint-vs-public-base trap `.health()` alone couldn't; arweave adds an identity+balance READ
  // (never a paid upload). Kept fast on purpose: only runs once a backend actually resolves, bounded
  // to 1.5s — the same budget `checkForCliUpdate` below uses for its own network check.
  const backendId = activeBackendId();
  try {
    const backend = resolveBackend(storageOptions());
    const h = await probeStorageBackend(storageOptions(), {timeoutMs: 1500});
    // Whether this backend can name a public URL for what it stores decides one thing operators hit
    // later: a REMOTE effects runner needs it (the resolver serves referenced output by redirect, so
    // it takes a URL and refuses bytes). Co-located rendering doesn't care — hence a note, not a fail.
    const publishable = backend.locator
      ? 'can publish to a remote resolver'
      : 'local-only — a remote effects runner needs cloud/ipfs/arweave (co-located rendering is fine)';
    check('storage', h.ok, `${backend.id} · ${h.detail} · ${publishable}`);
    // On failure, name BOTH URLs the cloud check touched — the R2/S3 endpoint-vs-public-base trap is
    // only diagnosable with both hosts on screen, not a bare "fetch failed".
    if (!h.ok && (h.putUrl || h.publicUrl)) {
      console.log(`${CONT}${dim(`put ${h.putUrl ?? '(none)'}  ·  get ${h.publicUrl ?? '(none)'}`)}`);
    }
  } catch (err) {
    check('storage', false, `${backendId} · ${(err as Error).message}`);
  }

  // 2b. Version & provenance — the 3-class drift ladder the skill has long taught in prose
  //     ("Resolve the CLI before you install anything"), now checked instead of just explained.
  //     `checkForCliUpdate` is already bounded to a ~1.5s network timeout + a 6h disk cache (see
  //     update-check.ts), so this never adds a meaningful wait — same budget the RPC probe above uses.
  console.log(`\n  ${dim('Version & provenance:')}`);
  const provenance = binaryProvenance();
  if (provenance === 'npx') {
    check('binary', false, 'running via npx — can silently keep serving a stale cached copy after an upgrade');
    console.log(`${CONT}${dim('install instead: `npm install --save-dev @artblocks/abx-cli` (project-local) or `-g` (machine-wide)')}`);
  } else {
    // Say WHAT is running, not how the command was invoked.
    check('binary', true, provenance === 'source' ? 'running the source checkout (not an npm install)' : 'npm install');
  }
  const latest = await checkForCliUpdate(cliVersion);
  if (latest) check('npm', false, `v${cliVersion} → v${latest} available — npm i -g @artblocks/abx-cli@latest`);
  else check('npm', true, `v${cliVersion} (or offline — checked at most every 6h)`);
  if (skillNeedsMigration) check('skill ver', false, `legacy skill name remains active — ${skillFix}`);
  else if (skillMissing) check('skill ver', false, 'no installed skill to compare — abx skill install');
  else if (skillStale) check('skill ver', false, `v${staleSkills.join(', v')} behind CLI v${cliVersion}${staleWhere} — ${skillFix}`);
  else check('skill ver', true, `v${cliVersion} matches the CLI`);

  // 3. Optional — path-dependent setup. Unset is fine; these say WHEN you'll need each, so an unset
  //    value never reads as a warning.
  console.log(`\n  ${dim('Optional — depends how you deploy:')}`);
  if (signingOpt) opt('signing', signingOpt);
  else opt('signing', 'no env key → sign in your browser wallet (--sign). Preflight yours: `abx doctor --for 0x<addr>`. Set ABX_DEPLOYER_PK for the unattended hot lane.');
  if (forOpt) opt('wallet --for', forOpt);
  const baseUrl = process.env.ABX_PUBLIC_BASE_URL;
  if (baseUrl) opt('resolver URL', baseUrl);
  else opt('resolver URL', 'ABX_PUBLIC_BASE_URL unset → needed for off-chain/resolver-served deploys; skip if fully on-chain (--onchain-image / --onchain-uri).');
  if (minter1155Opt) opt('1155 minter', minter1155Opt);
  else opt('1155 minter', 'none yet — `abx minter configure <addr> --token-id <n> …` on an edition deploys one');
  if (!process.env.ARWEAVE_JWK && existsSync(arweaveKeyFilePath())) {
    const jwk = loadArweaveJwk();
    opt('arweave key', `${jwk ? arweaveAddress(jwk) + ' ' : ''}holds upload credits — back it up: \`abx storage backup-key --out <path>\``);
  }
  // Named remotes: report what's configured, and — the part doctor was missing — flag a credential
  // stored under a name the CLI does NOT read. That fault presents as "it acts like I never gave it a
  // key", and until now it only surfaced from `abx remote <name>`, which a creator reaches later
  // (doctor is the thing they're told to run FIRST).
  // PROBE each named remote, don't just count it. Reporting "configured" for a credential the
  // service rejects is the same false green as an RPC that answers `[]` because it pruned its logs:
  // presence is not capability, and doctor is the command a creator is told to run FIRST — so the
  // 401 surfaced only later, from `abx remote <name>`, after they had already trusted this line.
  // One cheap authed call per remote, short timeout, and a failure here is never fatal to doctor.
  const remotes = listConfiguredRemotes();
  for (const r of remotes) {
    const name = r.name.toLowerCase();
    if (!r.hasToken) {
      opt('remotes', `${name} ${c.orange}(${describeMissingRemoteToken(name)})${c.reset}`);
      continue;
    }
    const verdict = await probeRemoteCredential(r.name);
    if (verdict.ok) opt('remotes', `${name} ${dim(verdict.detail)}`);
    else if (verdict.fatal) check('remotes', false, `${name} — ${verdict.detail}`);
    else opt('remotes', `${name} ${c.orange}${verdict.detail}${c.reset}`);
  }
  for (const bad of misnamedRemoteVars()) {
    check('remote key', false, `${bad.key} is set but is NOT read — the convention is ${bold(bad.suggestion)} (only _URL and _TOKEN). Rename it.`);
  }
  // The self-host default's credential moved to the named-remote grammar (ABX_REMOTE_SELF_TOKEN) —
  // the OLD var is never read now, so flag it here rather than let a creator discover it as a 401
  // that reads like a wrong key. Same condition `requireRemoteToken` hard-stops a real command on.
  const selfTokenMigration = selfTokenMigrationWarning();
  if (selfTokenMigration) check('self token', false, selfTokenMigration);

  console.log('');
}

// ── mint-page — scaffold a Next.js mint site for a collection (fixed-price minter) ─────────────

/**
 * Refuse a mint-page target with NO minter lane. The generated page reads
 * `maxInvocations`/`paused` (or, for an edition, the per-id `totalSupply`/`maxSupply`) and mints
 * through a shared fixed-price minter — none of which a plain 1/1 (`OneOfOneImage`) has, since it
 * has no minter lane at all. Before this check, pointing `mint-page` at a 1/1 wrote a page that
 * compiled and ran fine, then sat on "Loading…" forever with no diagnostic.
 *
 * `kind` is the caller's `detectTokenKind` result — every kind EXCEPT `1of1` composes a minter lane
 * (Series/SeriesCode via `AbxFixedPriceMinter`; the three edition twins via its 1155 sibling — see
 * the parity plan's "deliberate asymmetry" note on why even `OneOfOneEdition`, unlike its 721
 * namesake, ships the sale stack). `undefined` means the probe itself couldn't run (RPC unreachable,
 * address has no code, etc.) — that must NOT refuse: offline/best-effort scaffolding is allowed,
 * same as the `name()` read a few lines above this call.
 */
export function assertMintableSeries(token: string, kind: TokenKindInfo | undefined): void {
  if (kind?.kind === '1of1') {
    throw new CliError(
      `${token} looks like a 1/1 (OneOfOneImage) — mint-page sells through a shared fixed-price minter, which needs a Series/EditionImage/EditionCode contract (or an edition of one work); a plain 1/1 has no minter lane.\n` +
        `  Deploy a Series instead: abx deploy-series --dir <folder> --count 1\n` +
        `  …or copies of one work: abx deploy --copies <n|open>`,
    );
  }
}

export async function cmdMintPage(address: string | undefined, flags: Flags) {
  const usage = 'abx mint-page <token> [--dir mint-page] [--name "…"] [--rpc <public-url>] [--minter-contract 0x..]';
  const token = address;
  if (!token || !token.startsWith('0x')) {
    console.error(`usage: ${usage}\n`);
    process.exitCode = 1;
    return;
  }
  const publicClient = makePublicClient({chainKey: CHAIN});

  // Kind decides which shared minter (721 `AbxFixedPriceMinter` vs its 1155 `…1155` sibling) and
  // which purchase shape (one project-wide sale vs a per-`(token,id)` sale with a quantity) the
  // generated page needs. A probe failure (RPC unreachable, no code at the address) is left
  // `undefined` and does NOT refuse — matches the best-effort name() read below.
  let kind: TokenKindInfo | undefined;
  try {
    kind = await detectTokenKind(publicClient, token as Address);
  } catch {
    warn(`could not confirm ${token}'s kind (RPC unreachable?) — continuing without the check.`);
  }
  assertMintableSeries(token, kind);
  const isEdition = !!kind?.isEdition;

  const minter = isEdition ? fixedPriceMinter1155Address(flags['minter-contract']) : fixedPriceMinterAddress(flags['minter-contract']);
  if (!minter) {
    throw new Error(
      `no shared ${isEdition ? 'edition ' : ''}fixed-price minter known for ${CHAIN} — run ` +
        `\`abx minter configure ${token}${isEdition ? ' --token-id <n>' : ''} …\` first (it deploys + records one), ` +
        `or set ${isEdition ? 'ABX_FIXED_PRICE_MINTER_1155' : 'ABX_FIXED_PRICE_MINTER'}.`,
    );
  }
  const chain = resolveChain(CHAIN);
  const rpcUrl = flags.rpc && flags.rpc !== 'true' ? flags.rpc : PUBLIC_RPC[chain.id];
  if (!rpcUrl) {
    throw new Error(
      `no public RPC known for ${CHAIN} (chainId ${chain.id}) — pass --rpc <public-keyless-url> (it is embedded in the public site, so it must not contain a secret key).`,
    );
  }

  // Default the display name from the token's on-chain name (read-only); --name overrides.
  let collectionName = flags.name && flags.name !== 'true' ? flags.name : '';
  if (!collectionName) {
    try {
      collectionName = (await publicClient.readContract({
        address: token as Address,
        abi: oneOfOneImageAbi,
        functionName: 'name',
      })) as string;
    } catch {
      collectionName = 'ABX Collection';
    }
  }

  const art = mintPageArtifact({
    token,
    minter,
    chainId: chain.id,
    chainName: chain.name,
    rpcUrl,
    collectionName,
    explorer: chain.blockExplorers?.default?.url,
    isEdition,
  });
  const dir = flags.dir && flags.dir !== 'true' ? flags.dir : 'mint-page';
  const outDir = resolvePath(dir);

  console.log(bold('\n  ABX Self-Host Toolkit — mint page'));
  info(`collection ${bold(collectionName)}  ${dim(token)}${isEdition ? dim(`  · ${kind!.label} (edition)`) : ''}`);
  info(`minter ${minter}  ${dim('· ' + chain.name + ' · reads via ' + rpcUrl)}`);
  if (isEdition) info(dim('edition purchase shape: token id + quantity, price × qty — no minted-tokens gallery in this v1 page (see the README).'));
  step('Write the mint-page artifact (self-contained Next.js app — reads chain directly, no backend)');
  for (const f of art.files) {
    const dest = joinPath(outDir, f.path);
    mkdirSync(joinPath(dest, '..'), {recursive: true});
    writeFileSync(dest, f.content);
    info(`wrote ${joinPath(dir, f.path)}`);
  }

  step(`Next steps (run from ${bold(dir)}/)`);
  art.steps.forEach((s, i) => console.log(`    ${g(`${i + 1}.`)} ${s}`));

  step('Customize — this is a starting point');
  info('Plain React + one CSS file; ask the agent for a bespoke layout per drop. ETH sales + injected wallet by default;');
  info('the README covers RainbowKit (multi-wallet), ERC-20 (add an approve step), and RPC/gallery notes.');
  warn('The RPC in .env.local is PUBLIC (may rate-limit). Never put a secret-keyed RPC in a NEXT_PUBLIC_ var — it ships to the browser.');
  console.log('');
}

// ── flags ─────────────────────────────────────────────────────────────────--
// parseFlags + the Flags type live in flags.ts (unit-testable; repeatable flags like --dep
// accumulate comma-joined there).

// ── skill: install the abx agent skill into the user's coding agent ───────────────────────
// The skill is the agentic half of the toolkit — the CLI is only useful once an agent knows how
// to drive it. It ships bundled inside the published package (packages/cli/skill/, created at
// prepack); in dev the same command reads the canonical copy straight from the repo. This is the
// CANONICAL install path precisely because the bundle is version-locked to the CLI it ships inside
// (the version lives in SKILL.md frontmatter — see update-check.ts). By default it writes to BOTH
// `.claude/skills` (Claude Code) and the neutral `.agents/skills` (Cursor · Codex · Gemini ·
// Copilot all read it), so one command covers the whole ecosystem; `--agent` narrows it. A separate
// git-based channel, `npx skills add ArtBlocks/abx --skill abx`, is not version-locked to a local
// CLI — prefer `abx skill install`.

/** Locate the skill folder: the bundled copy beside the compiled CLI (published), else the
 *  canonical repo copy (dev). Returns null if neither is present. */
export function resolveBundledSkill(): string | null {
  const here = fileURLToPath(import.meta.url);
  // `findCliPackageRoot()`, never a counted `..`, so this works from a published install.
  const pkgDir = findCliPackageRoot();
  const bundled = pkgDir ? joinPath(pkgDir, 'skill') : null;
  // Running from SOURCE (`pnpm abx`, tsx on packages/cli/src/**) means we're in the repo working
  // tree, where the canonical skill is the source of truth and `<pkg>/skill` is gitignored PREPACK
  // OUTPUT that may be arbitrarily old. Preferring the bundle there is actively destructive: a
  // leftover `skill/` from a months-old `npm pack` silently overwrote the canonical skill with a
  // copy 8 versions behind (and the drift check then reported the damage as if the user had caused
  // it). In the published layout there is no repo and no canonical copy, so the bundle is correct.
  const root = findRepoRoot();
  const canonical = root ? joinPath(root, '.claude', 'skills', SKILL_DIR_NAME) : null;
  // "Running from source" = this module IS the repo's own CLI source, checked by containment rather
  // than by pattern. Two earlier attempts at this were wrong in opposite directions:
  //   - `/[/\\]src[/\\][^/\\]+$/` required the module to sit DIRECTLY in `src/`, so it read false
  //     for everything under `src/commands/` — including this file. Combined with the package-root fix
  //     above, that would make a dev run prefer `<pkg>/skill`, the gitignored prepack output, over the
  //     canonical skill: exactly the "actively destructive" case the note below describes.
  //   - matching a bare `/src/` anywhere would read TRUE for any user whose project happens to live
  //     under a `src` directory (`~/src/my-drop/node_modules/@artblocks/abx-cli/...`).
  // Containment under the resolved repo's `packages/cli/src` is neither: it is exact, and it is
  // independent of how deep in `src/` this file sits.
  const cliSrc = root ? joinPath(root, 'packages', 'cli', 'src') + sep : null;
  const fromSource = !!cliSrc && here.startsWith(cliSrc);
  if (fromSource && canonical && existsSync(joinPath(canonical, 'SKILL.md'))) return canonical;
  // Published layout: <pkg>/skill, written by scripts/bundle-skill.mjs at prepack.
  if (bundled && existsSync(joinPath(bundled, 'SKILL.md'))) return bundled;
  if (canonical && existsSync(joinPath(canonical, 'SKILL.md'))) return canonical;
  return null;
}

/** Locate the in-chain renderer Foundry scaffold: bundled beside the CLI (published), else the
 *  repo copy (dev). Same layout in both — it lives under the CLI package's `assets/`. */
export function resolveSolidityScaffold(): string | null {
  // Same fix as {resolveBundledSkill}: this had the identical counted-`..` bug, so
  // `abx scaffold-renderer` was broken on every published install too — unreported, found while
  // fixing the skill path.
  const pkgDir = findCliPackageRoot();
  const bundled = pkgDir ? joinPath(pkgDir, 'assets', 'renderer-scaffold') : null;
  if (bundled && existsSync(joinPath(bundled, 'foundry.toml'))) return bundled;
  const root = findRepoRoot();
  if (root) {
    const canonical = joinPath(root, 'packages', 'cli', 'assets', 'renderer-scaffold');
    if (existsSync(joinPath(canonical, 'foundry.toml'))) return canonical;
  }
  return null;
}

/** `abx scaffold-renderer [<dir>]` — write a ready-to-build Foundry project for the in-chain
 *  Solidity renderer lane (a seed + PostParam → SVG renderer + coherent traits + tests + a deploy
 *  script). abx doesn't compile/deploy Solidity — the creator runs forge, then hands the deployed
 *  address to `deploy-code --image-renderer`. Mirrors how deploy-resolver scaffolds an artifact. */
export function cmdScaffoldRenderer(rest: string[], flags: Flags) {
  const positional = positionalArgs(rest);
  return cmdScaffoldSolidity(positional.length ? positional : ['my-renderer'], flags);
}

/** `abx scaffold solidity [<dir>]` — one Foundry workspace for ABX's actual Solidity extension
 * surfaces. Contracts stay role-separated: renderers, configure/transfer/augment hooks, and the
 * canonical 721/1155 minters from `abx-contracts`; there is no invented "minter hook" role. */
export function cmdScaffoldSolidity(rest: string[], flags: Flags) {
  const dir = resolvePath(rest[0] ?? 'my-abx-solidity');
  const src = resolveSolidityScaffold();
  if (!src) {
    throw new Error('bundled renderer scaffold not found (expected <pkg>/assets/renderer-scaffold). Reinstall @artblocks/abx-cli.');
  }
  if (existsSync(dir) && readdirSync(dir).length > 0 && flags.force === undefined) {
    throw new Error(`${dir} already exists and is not empty — pass a fresh path, or --force to write into it.`);
  }
  // Copy + assert it landed. Throws rather than printing a success banner over an empty directory —
  // the alpha.9→alpha.14 failure mode. See src/scaffold.ts for why this is not inline.
  copyScaffold(src, dir, SCAFFOLD_ANCHOR);
  ok(`ABX Solidity workspace → ${dir}`);
  step('One workspace, separate deployable roles — use only the extension surfaces your project needs');
  info(`${bold('src/MyRenderer.sol')} + ${bold('MyTraits.sol')} cover on-chain rendering; ${bold('src/MyHooks.sol')} covers configure, transfer, and augment hooks as separate contracts. Canonical 721/1155 fixed-price minters and interfaces come from the pinned ${bold('abx-contracts')} package.`);
  info('build + test + deploy it yourself with Foundry (abx does not compile/deploy Solidity):');
  console.log(`    ${g('cd')} ${basename(dir)}`);
  console.log(`    ${g('forge soldeer install')}   ${dim('# fetch abx-contracts + solady + forge-std (exact-pinned)')}`);
  console.log(`    ${g('forge test')}              ${dim('# MUST pass — the never-revert cases')}`);
  // `forge test` asserts; it never shows you the art. Preview writes the renderer's actual bytes to
  // preview-out/ so you can open them — the one step between "my tests pass" and "this looks right",
  // and the reason not to discover a broken SVG only after spending testnet gas. Local-EVM only: it
  // proves output, never production gas.
  console.log(`    ${g('forge script script/Preview.s.sol')}  ${dim('# LOOK at it — writes preview-out/<field>.svg|json')}`);
  console.log(`    ${g('forge script script/Deploy.s.sol --rpc-url <rpc> --private-key <key> --broadcast')}`);
  info('then wire only the roles you chose:');
  console.log(`    ${g('abx deploy-code --image-renderer <MyRenderer> --attributes-renderer <MyTraits> --onchain-uri --schema palette:HexColor:TokenOwner --name "…" --symbol …')}`);
  console.log(`    ${g('abx set-param-hooks <token> --configure <addr> --augment <addr> --transfer <addr>')}`);
  info(`full walkthrough: ${bold(`${basename(dir)}/README.md`)} · extension contracts remain separate so authority is visible and independently omittable.`);
}

/** @deprecated Public compatibility alias for the renderer-only command from earlier CLI releases. */
export const resolveRendererScaffold = resolveSolidityScaffold;

/** Human label for each skills-parent dir — which agents pick the skill up from there. */
export const SKILL_PARENT_LABELS: Record<string, string> = {
  '.claude/skills': 'Claude Code',
  '.agents/skills': 'Cursor · Codex · Gemini · Copilot',
};

/** Resolve which skills-parent dirs `install` should write to. No `--agent` → the whole-ecosystem
 *  default (Claude Code + the neutral `.agents/skills` everyone else reads). `--agent a,b` narrows
 *  to those agents' dirs (de-duped, since several share `.agents/skills`). */
export function resolveInstallParents(agentFlag: string | undefined): string[] {
  if (!agentFlag || agentFlag === 'true') return ['.claude/skills', '.agents/skills'];
  const parents = new Set<string>();
  for (const raw of agentFlag.split(',')) {
    const a = raw.trim().toLowerCase();
    const parent = AGENT_SKILL_PARENTS[a];
    if (!parent) {
      throw new Error(
        `unknown --agent '${a}'. Use one of: ${Object.keys(AGENT_SKILL_PARENTS).join(', ')} (or omit --agent to install for every agent).`,
      );
    }
    parents.add(parent);
  }
  return [...parents];
}

/** Copy the bundled skill folder to `dest`, replacing any prior copy so a re-install after an
 *  upgrade never leaves stale reference files behind.
 *
 *  Returns `'already-canonical'` when destination IS the source, having done nothing. That case is
 *  not hypothetical: in a dev checkout of the abx repo `resolveBundledSkill()` resolves to the
 *  canonical `.claude/skills/abx`, which is exactly where a cwd-relative install writes —
 *  so the `rmSync` below would delete the canonical skill, and the copy would then have no source.
 *  A self-destructing install is a bad way to learn that. */
export function installSkillTo(src: string, dest: string): 'installed' | 'already-canonical' {
  if (resolvePath(src) === resolvePath(dest)) return 'already-canonical';
  mkdirSync(joinPath(dest, '..'), {recursive: true});
  rmSync(dest, {recursive: true, force: true});
  cpSync(src, dest, {recursive: true});
  return 'installed';
}

/**
 * Move an old `abx-self-host` skill out of the discovery tree before installing `abx`.
 *
 * Never delete it: users may have customized the copy. A backup outside every `skills/` parent
 * prevents two overlapping skills from triggering while keeping the old bytes recoverable.
 * Return null when the path is absent or does not actually declare the legacy skill name.
 */
export function archiveLegacySkillDir(legacyDest: string, backupRoot: string): string | null {
  if (!existsSync(legacyDest)) return null;
  const legacyName = readSkillName(joinPath(legacyDest, 'SKILL.md'));
  if (!legacyName || !(LEGACY_SKILL_DIR_NAMES as readonly string[]).includes(legacyName)) return null;

  const version = readSkillVersion(joinPath(legacyDest, 'SKILL.md')) ?? 'unversioned';
  mkdirSync(backupRoot, {recursive: true});
  const stem = `${legacyName}-${version}`;
  let backup = joinPath(backupRoot, stem);
  for (let n = 2; existsSync(backup); n += 1) backup = joinPath(backupRoot, `${stem}-${n}`);
  renameSync(legacyDest, backup);
  return backup;
}

function archiveLegacySkillsIn(parentDir: string, backupRoot: string): void {
  for (const legacyName of LEGACY_SKILL_DIR_NAMES) {
    const legacyDest = joinPath(parentDir, legacyName);
    const existed = existsSync(legacyDest);
    const backup = archiveLegacySkillDir(legacyDest, backupRoot);
    if (backup) info(`archived legacy ${legacyDest} → ${backup}`);
    else if (existed) warn(`left ${legacyDest} in place: its SKILL.md does not declare a recognized legacy ABX skill name; review it manually to avoid duplicate triggers.`);
  }
}

/**
 * Install the bundled skill into the default per-agent parents (or `~` with `global`), reporting
 * each destination. Shared by `abx skill install` and `abx doctor`'s offer to fix a missing/stale
 * skill — one implementation, so the two can't drift on where the skill lands or what it prints.
 */
export function installSkillToDefaults(src: string, opts: {global?: boolean; agent?: string} = {}): string {
  const version = readSkillVersion(joinPath(src, 'SKILL.md')) ?? readCliVersion();
  const base = opts.global ? homedir() : process.cwd();
  const parents = resolveInstallParents(opts.agent);
  ok(`installed the abx skill v${version}${opts.global ? ' (global, ~)' : ''}:`);
  for (const parent of parents) {
    archiveLegacySkillsIn(joinPath(base, parent), joinPath(base, '.abx-skill-backups', parent.replace(/[^a-z0-9]+/gi, '-')));
    const dest = joinPath(base, parent, SKILL_DIR_NAME);
    const outcome = installSkillTo(src, dest);
    const label = SKILL_PARENT_LABELS[parent];
    const note = outcome === 'already-canonical' ? dim('  (already the canonical copy — left as is)') : label ? dim('  → ' + label) : '';
    console.log(`    ${g(joinPath(parent, SKILL_DIR_NAME))}${note}`);
  }
  info('restart your agent so it loads the skill, then ask it to launch an NFT with abx.');
  info(`the skill is version-locked to this CLI (v${version}); re-run ${g('abx skill install')} after upgrading so the two stay in sync.`);
  return version;
}

/** The default skill destinations, as a display string — what doctor's prompt has to name up front. */
export function defaultSkillDests(opts: {global?: boolean; agent?: string} = {}): string {
  const prefix = opts.global ? '~/' : './';
  return resolveInstallParents(opts.agent).map((p) => `${prefix}${p}`).join(' and ');
}

export async function cmdSkill(rest: string[], flags: Flags) {
  const sub = rest[0] ?? 'install';
  const src = resolveBundledSkill();
  if (!src) {
    throw new Error(
      `bundled skill not found (expected <pkg>/skill or .claude/skills/${SKILL_DIR_NAME}). ` +
        'Reinstall @artblocks/abx-cli, or install cross-agent with: npx skills add ArtBlocks/abx --skill abx',
    );
  }

  if (sub === 'path') {
    console.log(src);
    return;
  }

  if (sub === 'install') {
    const version = readSkillVersion(joinPath(src, 'SKILL.md')) ?? readCliVersion();

    // Escape hatch: --target <dir> writes the skill folder straight under <dir> (for an agent
    // whose skills dir we don't special-case, or a bespoke location).
    if (typeof flags.target === 'string' && flags.target !== 'true') {
      const target = resolvePath(flags.target);
      archiveLegacySkillsIn(target, joinPath(target, '.abx-skill-backups'));
      const dest = joinPath(target, SKILL_DIR_NAME);
      if (installSkillTo(src, dest) === 'already-canonical') {
        ok(`${dest} is already the canonical skill v${version} — nothing to install.`);
        return;
      }
      ok(`installed the abx skill v${version} → ${dest}`);
      info('restart your agent so it loads the skill, then ask it to launch an NFT with abx.');
      return;
    }

    installSkillToDefaults(src, {global: flags.global !== undefined, agent: flags.agent as string | undefined});
    return;
  }

  throw new Error('usage: abx skill <install|path> [--agent claude|cursor|codex|gemini|copilot] [--global] [--target <dir>]');
}
