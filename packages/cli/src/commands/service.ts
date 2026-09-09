/**
 * Service-facing commands: `serve` (the token API + dashboard), `deploy-resolver` /
 * `deploy-effects` (scaffold a hosted resolver / effect runner for a provider the operator owns),
 * `remote` (inspect a remote service), `migrate` (move a contract's off-chain state to another
 * resolver), and `effects` (co-located effect-runner mode).
 */
import {randomBytes} from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {join as joinPath, resolve as resolvePath} from 'node:path';
import {createInterface} from 'node:readline';
import {SqliteStore} from '@artblocks/abx-indexer';
import {
  AbxServiceError,
  SERVICE_FEEDBACK_INTERFACE,
  type Address,
  type RegisterProjectBody,
  type ServiceDescriptor,
  buildMigrationPlan,
  envSuffix,
  isCodeProject,
  makePublicClient,
  probeRpcEndpoints,
  reconstructProject,
  resolveChain,
  verifyParity,
} from '@artblocks/abx-sdk';
import {assertPrivateEnvPath, saveEnvSecret, saveEnvSecrets} from './auth.js';
import {repinNodeCustody, resolveBackend} from '@artblocks/abx-storage';
import {DEFAULT_PORT, resolveBaseUrl, startChainWatcher, startTokenApiServer, watchIntervalMs} from '@artblocks/abx-token-api';
import {formatAssertion, runConformance, verdictLine} from '../conformance.js';
import {CHAIN, factoryAddress, localIndexer, loopbackBaseUrl, storageOptions, storageOverrides} from '../config.js';
import {type Flags} from '../flags.js';
import {
  allowLargeScan,
  assertPortFree,
  bold,
  c,
  dim,
  findRepoRoot,
  g,
  info,
  keepAlive,
  loadEffects,
  ok,
  printServing,
  requirePublishableBackend,
  resolveScanFloor,
  step,
  warn,
} from '../output.js';
import {type ResolverProvider, effectsArtifact, resolverArtifact} from '../provision.js';
import {
  describeRemoteError,
  listConfiguredRemotes,
  misnamedRemoteVars,
  remoteFlag,
  reportRemoteIndexing,
  requireRemoteToken,
  resolveRemote,
  rollUp,
  serviceClient,
  statusLabel,
} from '../remote.js';

/**
 * Ensure the LOCAL client credential for your own resolver exists, generating + persisting one to
 * `.env` (as `ABX_REMOTE_SELF_TOKEN` — the named-remote grammar's "self" entry) if not. The SAME
 * value also has to land on the resolver itself, under ITS OWN var name (`ABX_RESOLVER_ADMIN_TOKEN`,
 * server-side — see remote.ts's header comment for why the two names differ across that boundary);
 * the printed deploy steps carry it across. The token authorizes remote indexing control only
 * (never on-chain signing), and — like every other secret — lives ONLY in `.env`, never in a
 * tool-written file or chat. Returns {token, generated} so the caller can tell the operator what
 * happened without printing the secret itself.
 */
export function ensureAdminToken(): {token: string; generated: boolean} {
  const existing = process.env.ABX_REMOTE_SELF_TOKEN;
  if (existing) return {token: existing, generated: false};
  const token = randomBytes(24).toString('base64url');
  const envPath = resolvePath(process.cwd(), '.env');
  const line = `${existsSync(envPath) && readFileSync(envPath, 'utf8').endsWith('\n') === false ? '\n' : ''}ABX_REMOTE_SELF_TOKEN=${token}\n`;
  appendFileSync(envPath, line);
  process.env.ABX_REMOTE_SELF_TOKEN = token;
  return {token, generated: true};
}

/** Ensure an ABX_EFFECTS_TOKEN exists locally (generated + persisted to `.env` like the admin
 *  token) — it gates a PUBLIC runner's /run + /notify, and the resolver's watcher sends it. */
export function ensureEffectsToken(): {token: string; generated: boolean} {
  const existing = process.env.ABX_EFFECTS_TOKEN;
  if (existing) return {token: existing, generated: false};
  const token = randomBytes(24).toString('base64url');
  const envPath = resolvePath(process.cwd(), '.env');
  const line = `${existsSync(envPath) && readFileSync(envPath, 'utf8').endsWith('\n') === false ? '\n' : ''}ABX_EFFECTS_TOKEN=${token}\n`;
  appendFileSync(envPath, line);
  process.env.ABX_EFFECTS_TOKEN = token;
  return {token, generated: true};
}

const LOOPBACK_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

export interface EffectsTarget {
  resolverUrl: string;
  adminToken: string | undefined;
  /** True when `--resolver-port` explicitly declared co-location (no `--remote`). */
  localOnly: boolean;
  /** Set when a token is about to be used against what looks like the runner's own loopback
   *  `abx serve` — that publish will always 404, so the caller should warn with this text. */
  loopbackTokenWarning: string | undefined;
}

/**
 * Pure decision logic behind `cmdEffects`'s resolver target — split out so the
 * `--resolver-port`/stale-token interaction (see {@link cmdEffects}) is unit-testable without
 * spinning up a chain client or an HTTP server.
 */
export function resolveEffectsTarget(flags: Flags, env: NodeJS.ProcessEnv = process.env): EffectsTarget {
  const effectsRemote = remoteFlag(flags);
  // --resolver-port is the explicit "this is MY OWN co-located `abx serve`, just not on the default
  // port" declaration. Passing this flag skips token lookup even if a stale
  // ABX_REMOTE_SELF_TOKEN remains from an unrelated remote run.
  const resolverPort = flags['resolver-port'] !== undefined ? Number(flags['resolver-port']) : undefined;
  const localOnly = resolverPort !== undefined && !effectsRemote;
  const resolverUrl = (
    effectsRemote?.url ??
    (resolverPort !== undefined ? `http://localhost:${resolverPort}` : undefined) ??
    env.ABX_RESOLVER_URL ??
    resolveBaseUrl()
  ).replace(/\/$/, '');
  // Token optional BY DESIGN: no token = the co-located topology (shared store, no publish lane).
  // A named remote brings its own token; otherwise the self-host env token (ABX_REMOTE_SELF_TOKEN) —
  // unless --resolver-port just declared this co-located explicitly, in which case that stale token
  // (if any) is ignored rather than silently forcing a publish attempt against a plain `abx serve`
  // that will never implement the control plane it authenticates.
  const adminToken = effectsRemote?.token ?? (localOnly ? undefined : env.ABX_REMOTE_SELF_TOKEN);
  const loopbackTokenWarning =
    adminToken && !effectsRemote && LOOPBACK_URL.test(resolverUrl)
      ? `ABX_REMOTE_SELF_TOKEN is set, so this run will try to PUBLISH to ${resolverUrl} over the control plane — but that looks ` +
        `like your own loopback \`abx serve\`, which never implements it and will 404 on the first render. If you want ` +
        `CO-LOCATED rendering here (no token, shared store), pass --resolver-port <n> to point at it explicitly, or unset ` +
        `ABX_REMOTE_SELF_TOKEN for this shell.`
      : undefined;
  return {resolverUrl, adminToken, localOnly, loopbackTokenWarning};
}

/**
 * `abx effects` — run the reference effect runner LOCALLY, in-process (the local counterpart to
 * `abx deploy-effects`, which scaffolds a HOSTED runner). This is what makes a param change / new
 * mint **auto-render** on your own machine: it sweeps every code project the resolver serves and
 * renders any still missing at the CURRENT inputsHash, then keeps sweeping. Co-located with a local
 * `abx serve` (same store) it needs no admin token; against a hosted resolver it publishes via the
 * admin token (locator bridge). Blocks like `serve` — background it. `--once` sweeps all projects a
 * single time and exits (vs `abx render <addr>` which is the per-project repair lane).
 */
export async function cmdEffects(flags: Flags): Promise<void> {
  const {resolverUrl, adminToken, loopbackTokenWarning} = resolveEffectsTarget(flags);
  if (loopbackTokenWarning) warn(loopbackTokenWarning);
  // Co-located (no admin token — we share the resolver's store): record each declared output into
  // the shared artifact registry so the resolver's `artifacts` manifest enumerates it. With an
  // admin token, the publish lane records rows on the hosted resolver instead.
  const localStore = adminToken ? null : new SqliteStore();
  if (adminToken) requirePublishableBackend(flags, 'abx effects against a remote resolver');
  const {EffectRunner, renderEffect} = await loadEffects();
  const runner = new EffectRunner({
    resolverUrl,
    client: makePublicClient({chainKey: CHAIN}),
    storage: resolveBackend(storageOptions(storageOverrides(flags))),
    effects: [renderEffect()],
    environmentId: process.env.ABX_ENVIRONMENT_ID ?? 'web:any',
    // Publish to the resolver's control plane when we DON'T share its store (hosted). Co-located
    // (same fs/backend) it's ignored. The token authorizes indexing/artifact control only, never signing.
    adminToken,
    concurrency: Number(flags.concurrency ?? process.env.ABX_EFFECTS_CONCURRENCY ?? 1),
    authToken: process.env.ABX_EFFECTS_TOKEN,
    recordArtifact: localStore ? (row) => localStore.putEffectArtifact(row) : undefined,
  });
  if (flags.once !== undefined) {
    const stats = await runner.sweepAll();
    const line = `effects once: ran=${stats.ran} skipped=${stats.skipped} failed=${stats.failed} ${dim(`(${resolverUrl})`)}`;
    if (stats.failed) warn(`${line}\n  ${dim(stats.errors[0] ?? 'see error above')}`);
    else ok(line);
    return;
  }
  const port = Number(flags.port ?? process.env.ABX_EFFECTS_PORT ?? 8788);
  // 300s: the sweep is the SAFETY FLOOR — the resolver's chain watcher POSTs /notify the moment
  // settled state changes, so the interval only catches a missed ping / cold start / new project.
  const intervalMs = Number(flags['interval-ms'] ?? process.env.ABX_EFFECTS_INTERVAL_MS ?? 300_000);
  runner.startHttp(port);
  runner.startLoop(intervalMs);
  console.log(`\n  ${g('●')} ${bold('effect runner up')}  ${dim(`resolver ${resolverUrl} · port ${port} · sweep ${intervalMs}ms (safety floor)`)}`);
  info('auto-renders every new mint + PostParam change: the resolver\'s chain watcher notifies this runner the moment settled state changes (set ABX_EFFECTS_URL=http://localhost:' + port + ' on the resolver). Needs a local Chromium (`npx playwright install chromium`).');
  info(`${dim('POST /notify enqueues (the watcher lane) · POST /run sweeps synchronously (the command lane). Ctrl-C to stop. Hosting it instead? ')}${bold('abx deploy-effects')}`);
  await new Promise<never>(() => {}); // block like `serve`
}

// ── serve ──────────────────────────────────────────────────────────────────--
export async function cmdServe(flags: Flags) {
  const port = Number(flags.port ?? process.env.ABX_PORT ?? DEFAULT_PORT);
  await assertPortFree(port, 'serve');
  const baseUrl = resolveBaseUrl(port);
  const indexer = localIndexer();
  // Surface the most-recently-reconstructed project (what you just deployed), not
  // an arbitrary one — the banner must match reality.
  const latest = [...indexer.listProjects()].sort((a, b) => b.reconstructedAt.localeCompare(a.reconstructedAt))[0];
  const {url} = await startTokenApiServer({indexer, port, baseUrl, storage: resolveBackend(storageOptions())});
  printServing(url, latest?.address as Address | undefined);
  // The chain watcher — ON by default: the resolver is the protocol's one chain consumer. Every
  // registered project's new events (external mints, foreign-tool param changes) auto-index here
  // and fan out ONE coarse notification per project to the effects layer (ABX_EFFECTS_URL). Tune
  // with ABX_WATCH_INTERVAL_MS; 0 disables (a purely static node).
  const interval = watchIntervalMs();
  if (interval > 0) {
    startChainWatcher({indexer, intervalMs: interval});
    // Reclaim SQLite free pages on a coarse cadence of its own. Bounded per pass and gated behind the
    // same `interval > 0` switch as the watcher: a node that isn't following the chain isn't growing
    // a freelist either, and a purely static node should stay untouched. It never runs inline with a
    // request — `node:sqlite`'s DatabaseSync is synchronous and shared with the token-api reads, so
    // unbounded reclamation on a serving path would block metadata responses. Pre-conversion stores
    // (created before auto_vacuum was set) no-op here until `abx vacuum convert` runs once.
    indexer.startVacuumMaintenance();
    const effectsUrl = process.env.ABX_EFFECTS_URL;
    console.log(`  ${dim('watching')}  chain every ${Math.round(interval / 1000)}s ${dim(`(auto-index${effectsUrl ? ` + notify effects → ${effectsUrl}` : ''}; ABX_WATCH_INTERVAL_MS=0 to disable)`)}`);
    // The watcher indexes regardless, but with no effects URL it has nowhere to send the "changed"
    // notification — so thumbnails will NOT auto-re-render. Say it plainly (not buried in dim text):
    // this is the #1 silent misconfig for a co-located resolver + runner. But ONLY warn when a CODE
    // project (the only kind with off-chain rendered stills) is actually registered — for a 1/1 or
    // image Series resolver there is nothing to render, so the warning is just noise (hosting-agent
    // finding: a plain resolver shouldn't nag about an effects runner it doesn't need).
    if (!effectsUrl && indexer.listProjects().some(isCodeProject)) {
      warn('ABX_EFFECTS_URL is not set — the watcher will auto-index changes but NOT auto-render thumbnails for your code project(s).');
      console.log(`           ${dim('run `abx effects` (local) or `abx deploy-effects` (hosted), then set ABX_EFFECTS_URL to its URL.')}`);
    }
  } else {
    console.log(`  ${dim('watching   OFF (ABX_WATCH_INTERVAL_MS=0) — state updates only on explicit add/index')}`);
  }
  keepAlive();
}

/** Read one line from stdin — piped input resolves immediately; a real TTY prompts and waits for
 *  Enter. No masking (a raw-mode hidden-input hack is more failure surface than this is worth) — the
 *  property this actually protects is "never a command-line argument" (shell history, `ps aux`,
 *  shoulder-surfing a process list), which piping alone already satisfies. */
function readLineFromStdin(prompt: string): Promise<string> {
  const rl = createInterface({input: process.stdin, output: process.stdin.isTTY ? process.stdout : undefined});
  return new Promise((resolveLine) => rl.question(prompt, (answer) => { rl.close(); resolveLine(answer.trim()); }));
}

/** `usage: ...` when {@link installRemoteToken}'s inputs don't even reach a file. */
const REMOTE_SET_USAGE = 'abx remote set <name> --url https://<host>   (pipe the token on stdin: echo "$TOKEN" | abx remote set <name> --url <url>)';

/**
 * The testable core of `abx remote set` — no stdin, no console: validate `name`/`url`, then write
 * both `ABX_REMOTE_<NAME>_URL` and `ABX_REMOTE_<NAME>_TOKEN` via the same safety rails `auth login`
 * uses (symlink/git-tracked/unignored refusal, atomic write, upsert-in-place on a re-run). Split out
 * so a test can point `envPath` at a temp file instead of `process.cwd()`.
 */
export function installRemoteToken(name: string, url: string, token: string, envPath: string): {urlVar: string; tokenVar: string} {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/i.test(name) || name.length > 40) {
    throw new Error('remote names use 1–40 letters, digits, and single hyphens, starting with a letter (for example: meridian or my-provider).');
  }
  const normalized = envSuffix(name);
  if (normalized === 'ABX') {
    throw new Error('"abx" is the built-in first-party remote — use `abx auth login` instead (OAuth device flow, no manual token to paste).');
  }
  if (normalized === 'TRUE') {
    throw new Error('"true" is reserved by the bare --remote flag; choose a descriptive provider name.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`--url https://<host> is required (a scheme and host are mandatory).\nusage: ${REMOTE_SET_USAGE}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`--url https://<host> is required (a scheme is mandatory, and it can't contain whitespace).\nusage: ${REMOTE_SET_USAGE}`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const cleanUrl = parsed.toString().replace(/\/$/, '');
  if (!token) {
    throw new Error(`no token read from stdin. Pipe it in: echo "$TOKEN" | abx remote set ${name} --url ${cleanUrl}`);
  }
  assertPrivateEnvPath(envPath);
  const urlVar = `ABX_REMOTE_${normalized}_URL`;
  const tokenVar = `ABX_REMOTE_${normalized}_TOKEN`;
  saveEnvSecrets(envPath, [
    {key: urlVar, value: cleanUrl, valuePattern: /^https?:\/\/\S+$/i},
    {key: tokenVar, value: token, valuePattern: /^[^\r\n]+$/},
  ]);
  return {urlVar, tokenVar};
}

// ── remote set ───────────────────────────────────────────────────────────────
// The third-party twin of `abx auth login`: that OAuth device flow only exists for the first-party
// `abx` remote. This gives other hosted metadata providers the same safe credential path: never a
// command-line argument and never printed.
export async function cmdRemoteSet(name: string | undefined, flags: Flags): Promise<void> {
  if (!name) {
    console.error(`usage: ${REMOTE_SET_USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const url = (flags.url as string | undefined) ?? '';
  const token = await readLineFromStdin(
    process.stdin.isTTY
      ? 'Paste the token, then press Enter (visible as you type — pipe it in instead if that matters to you): '
      : '',
  );
  const {urlVar, tokenVar} = installRemoteToken(name, url, token, resolvePath(process.cwd(), '.env'));
  ok(`saved ${urlVar} and ${tokenVar} to .env (the token is never printed by this command). Verify with: abx remote ${name.toLowerCase()}`);
}

// ── remote ────────────────────────────────────────────────────────────────--
// Inspect a remote service. Bare `abx remote` lists the named remotes configured in .env plus the
// self-host default pair (URLs + whether a token is set — never the secret itself). With a target,
// fetches its PUBLIC service descriptor (what it serves: interfaces, chains, auth, managed
// rendering) and — when a token resolves — lists the projects visible to that token, which makes
// this the one-command "is my provider key valid?" check. Read-only; registers nothing.
export async function cmdRemote(spec: string | undefined, flags: Flags) {
  if (flags.conformance !== undefined) return cmdRemoteConformance(spec, flags);
  if (!spec || spec.startsWith('--')) {
    const remotes = listConfiguredRemotes();
    console.log(`\n  ${bold('remote services')}  ${dim('(abx is built in; other names use ABX_REMOTE_<NAME>_URL/_TOKEN)')}`);
    for (const r of remotes) {
      console.log(`    ${g('●')} ${r.name.toLowerCase()}  ${dim(r.url)}  ${r.hasToken ? g('token set') : dim('no token')}`);
    }
    if (!remotes.find((r) => r.name === 'ABX')?.hasToken) {
      info(`first-party access: ${g('abx auth login')} (browser approval; the key is stored without being printed)`);
    }
    // A near-miss var reads as "no token" while the value is sitting in .env under the wrong name.
    for (const bad of misnamedRemoteVars()) {
      warn(`${bad.key} isn't a recognized remote var — the convention is ${bold(bad.suggestion)} (only _URL and _TOKEN are read).`);
    }
    const def = process.env.ABX_PUBLIC_BASE_URL ?? process.env.ABX_RESOLVER_URL;
    console.log(`\n  ${bold('self-host default')}  ${dim('(bare --remote)')}`);
    console.log(
      def
        ? `    ${g('●')} ${def}  ${process.env.ABX_REMOTE_SELF_TOKEN ? g('token set') : dim('no ABX_REMOTE_SELF_TOKEN')}`
        : dim('    none (set ABX_PUBLIC_BASE_URL in .env)'),
    );
    console.log('');
    return;
  }
  const target = resolveRemote(spec, flags['remote-token'] as string | undefined);
  if (!target) return;
  const client = serviceClient(target);
  console.log(`\n  ${bold(target.name ? `remote ${target.name.toLowerCase()}` : 'remote')} ${dim(`→ ${target.url}`)}`);
  let d: ServiceDescriptor;
  try {
    d = await client.descriptor();
  } catch (err) {
    // Two very different situations, and the fix differs — so don't nest the raw client error
    // (it repeats the URL and leaks `GET`/`fetch failed` at a creator).
    const status = err instanceof AbxServiceError ? err.status : -1;
    if (status === 0) {
      throw new Error(
        `nothing responded at ${target.url} — check the address. A provider gives you an https:// base ` +
          `(e.g. https://meta.provider.xyz); if it's your own node, is it running?`,
      );
    }
    throw new Error(
      `${target.url} answered, but serves no ABX service descriptor at /.well-known/abx-service. ` +
        `That's either an older self-hosted node (fine if it's yours — the remote commands still work against it) ` +
        `or not an ABX service at all. Verify the URL before registering anything with it.`,
    );
  }
  info(`service    ${d.service?.name ?? '—'} ${dim(d.service?.version ?? '')}`);
  info(`serves     ${(d.interfaces ?? []).join(' · ') || '—'}`);
  const chainId = resolveChain(CHAIN).id;
  const coversChain = (d.chains ?? []).includes(chainId);
  info(`chains     ${(d.chains ?? []).join(', ') || '—'}  ${coversChain ? g(`✓ covers ${CHAIN} (${chainId})`) : `${c.orange}⚠${c.reset} does NOT cover ${CHAIN} (${chainId}) — registrations will be refused`}`);
  if (d.baseUrl) {
    // `baseUrl` is the node's own "what I believe I serve from" echo — a real host advertising a
    // loopback address can never be reached by an external collector, and unlike a general
    // baseUrl-vs-queried-URL mismatch (which false-positives on the common custom-domain case, see
    // provider-mismatch heuristics), a bare loopback address is unambiguous: nothing
    // external ever resolves it, full stop.
    const loopback = loopbackBaseUrl(d.baseUrl);
    info(`base URL   ${d.baseUrl}${loopback ? `  ${c.orange}⚠${c.reset} ${dim('a loopback address — no external collector could ever reach this')}` : ''}`);
  }
  if (d.render?.attached) {
    const outputs = d.render.effects?.flatMap((e) => e.outputs.map((o) => `${e.key}/${o.key}`)).join(', ');
    info(`rendering  managed behind this service${outputs ? ` (${outputs})` : d.render.effects === null ? dim(' (attached — runner unverified right now)') : ''} — code drops need no effects runner here`);
  }
  if (d.interfaces?.includes(SERVICE_FEEDBACK_INTERFACE)) {
    info(`feedback   provider reports supported · preview with abx feedback --remote ${target.name?.toLowerCase() ?? target.url}`);
  }
  if (d.auth) {
    const onboarding =
      target.source === 'builtin'
        ? ` · authorize: abx auth login${d.auth.signupUrl ? ` · manual recovery: ${d.auth.signupUrl}` : ''}`
        : d.auth.signupUrl
          ? ` · provider onboarding/recovery: ${d.auth.signupUrl}`
          : '';
    info(`auth       bearer${onboarding}${d.auth.docsUrl ? ` · docs: ${d.auth.docsUrl}` : ''}`);
  } else {
    info(`auth       none advertised ${dim('(control plane disabled on this node)')}`);
  }
  if (!target.token) {
    // Same near-miss check the register path does — this is where someone lands FIRST when their
    // credential is set under a name the CLI doesn't read, so the hint has to be here too.
    const nearMiss = misnamedRemoteVars().find((v) => v.suggestion === target.tokenVar);
    if (nearMiss) warn(`${nearMiss.key} is set but is NOT read — the convention is ${bold(target.tokenVar)} (only _URL and _TOKEN). Rename it and re-run.`);
    else if (target.source === 'builtin') {
      info(dim(`no token resolved — run abx auth login; descriptor only until browser approval completes.`));
    } else if (target.source === 'named') {
      info(
        dim(
          `no token resolved — try abx auth login ${target.name?.toLowerCase()}; otherwise set ${target.tokenVar}. ` +
            `Descriptor only; can't list your projects.`,
        ),
      );
    } else info(dim(`no token resolved (set ${target.tokenVar} or pass --remote-token) — descriptor only; can't list your projects.`));
    console.log('');
    return;
  }
  try {
    const projects = await client.listProjects();
    ok(`token accepted — ${projects.length} project(s) visible to it`);
    for (const p of projects.slice(0, 10)) {
      console.log(
        `    ${g('●')} ${p.name ?? p.label ?? p.address}  ${dim(`${p.address} · ${p.tokenCount ?? '?'} token(s)`)}` +
          `${p.status ? `  ${statusLabel(p.status)}` : ''}${p.error ? ` ${c.orange}${p.error.class}${c.reset}` : ''}`,
      );
    }
    if (projects.length > 10) console.log(dim(`    … and ${projects.length - 10} more`));
    if (projects.some((p) => p.status)) info(rollUp(projects) + dim('  — one project in detail: abx status <address> --remote ' + (target.name?.toLowerCase() ?? target.url)));
  } catch (err) {
    throw describeRemoteError(err, target, 'remote list');
  }
  console.log('');
}

// ── remote --conformance ─────────────────────────────────────────────────--
// Self-certify a hosted resolver against the public remote-services contract, from the
// PUBLISHED CLI — no repo checkout needed (the assertions themselves live in ../conformance.ts).
// Folded into `remote` rather than a new top-level command (command-count
// discipline): `abx remote <name|url> --conformance [--remote-token <t>] [--chain-id <n>] [--address
// <a>] [--from-block <n>]`. Exits non-zero on any failed assertion — CI-gateable.
//
// Reuses the SAME --remote resolution as every other remote op: a bare URL + --remote-token needs
// zero .env setup, which is the point — a third party evaluating "can I host this?" runs this
// against their own node with nothing but the CLI and a token. The register→deregister loop (the
// one tier that writes anything) stays gated behind BOTH --address and --chain-id together, exactly
// as the script always required: exercising it against a service you don't own needs a contract you
// own to point it at, which is its own consent gate stacked on top of the token.
async function cmdRemoteConformance(spec: string | undefined, flags: Flags): Promise<void> {
  // A bare `--conformance` (no positional target) leaks the flag token itself into `spec` — argv
  // parsing keeps positionals raw (main.ts's `rest[0]`), so `abx remote --conformance` alone hands
  // this the literal string '--conformance'. Treat that the same as "no target given" and fall back
  // to the self-host default, exactly like `abx remote`'s own bare-mode check just above.
  const rawSpec = spec && !spec.startsWith('--') ? spec : undefined;
  const target = resolveRemote(rawSpec ?? 'true', flags['remote-token'] as string | undefined);
  if (!target) return; // unreachable — a defined spec always resolves or throws
  console.log(bold(`\n  abx remote --conformance`) + dim(` → ${target.url}`));
  info(
    `self-certifying against https://docs.abx.io/docs/using-abx/remote-services` +
      (target.token ? ' (token present — authed tiers included)' : ' (no token — unauthenticated tier only; pass --remote-token to unlock more)'),
  );
  console.log('');

  const chainId = flags['chain-id'] !== undefined ? Number(flags['chain-id']) : undefined;
  const report = await runConformance({
    baseUrl: target.url,
    token: target.token,
    chainId,
    address: flags.address as string | undefined,
    fromBlock: flags['from-block'] as string | undefined,
  });
  for (const a of report.assertions) console.log(formatAssertion(a));
  console.log(verdictLine(report));
  // The one exit-discipline every signing/writing surface follows (errors.ts): no process.exit()
  // mid-flow — a local failure sets exitCode and returns.
  if (report.failures) process.exitCode = 1;
}

// ── migrate ───────────────────────────────────────────────────────────────--
// Move a contract's OFF-CHAIN operator state from one resolver to another (e.g. fly.io →
// a droplet). The destination replays all ON-CHAIN state from chain itself; this bridges
// the rest — description / external_url / off-chain traits / image locators — by reading the
// SOURCE resolver's PUBLIC api. The two resolvers never talk: we read public endpoints + chain
// and write through the admin control plane. It does NOT cut over — after a clean migration the
// operator re-points DNS (custom domain) or the on-chain base URI (provider endpoint).
//
// ⚠ IF YOU EVER ADD A REDEPLOY-STYLE MIGRATION HERE — anything that deploys a NEW contract and
// re-points identity to it (plausible under the greenfield-redeploy stance) — it MUST read the
// source collection's creator-token status (`readCreatorTokenStatus`) and carry the enrollment +
// active validator into the new deploy's `transferValidator` InitParam. ERC-721C enrollment is
// deploy-time-only and PERMANENT, so a migration that forgets it silently converts an enforced
// collection into a plain ERC-721 — unrecoverable except by yet another redeploy. Corollary: a
// plain source collection must stay plain; do not "helpfully" enroll on migration. Today's
// migrate moves off-chain state only, so enrollment lives on the untouched contract and none of
// this applies — which is exactly why the trap is easy to walk into later.
export async function cmdMigrate(address: Address | undefined, flags: Flags) {
  // Both sides accept a named remote or a URL. Only the DESTINATION needs a credential — the
  // source is read via its PUBLIC api (the exit ramp works with zero provider cooperation).
  const fromTarget = typeof flags.from === 'string' ? resolveRemote(flags.from) : null;
  const toTarget = typeof flags.to === 'string' ? resolveRemote(flags.to, flags['remote-token'] as string | undefined) : null;
  if (!address || address.startsWith('--') || !fromTarget || !toTarget) {
    console.error('usage: abx migrate <address> --from <source-resolver name|url> --to <dest-resolver name|url> [--from-block N]\n');
    process.exitCode = 1;
    return;
  }
  requireRemoteToken(toTarget);
  const from = fromTarget.url;
  const to = toTarget.url;
  const chainId = resolveChain(CHAIN).id;
  allowLargeScan(flags);

  console.log(bold(`\n  abx migrate ${dim('— port off-chain state between resolvers (no cutover)')}`));
  info(`source ${from}`);
  info(`dest   ${to}`);

  // 1) Reconstruct on-chain truth locally (read-only) — for the token list + the image hash
  //    KEYS the served JSON doesn't expose. No persistence, no local registration written.
  step('Read the chain');
  const client = makePublicClient({chainKey: CHAIN});
  const reg = localIndexer().store.getRegistration(address);
  const factory = flags.factory ?? factoryAddress() ?? reg?.factory ?? undefined;
  // Resolve the scan floor like add/index — NEVER a silent genesis default. --from-block wins, else
  // the local registration's deploy block, else discover it on-chain (getCode binary search), else
  // refuse with guidance. A from-0 reconstruction of a real collection trips the getLogs cap on a
  // range-capped RPC — the exact wall a migrating creator hit before this.
  const scanFloor = await resolveScanFloor(address, reg?.fromBlock, flags);
  const local = await reconstructProject(client, {
    address,
    fromBlock: BigInt(scanFloor),
    factory: factory as Address | undefined,
  });
  ok(`${local.name ?? address}: ${local.tokens.length} token(s), ${local.eventCount} events on-chain`);

  // 2) Reconstruct the off-chain state from the SOURCE resolver's public API.
  step('Read the source resolver');
  const plan = await buildMigrationPlan(from, chainId, local);
  ok(`read ${plan.tokensRead} served token(s)`);
  info(
    `off-chain: ${plan.description ? 'description ✓' : 'no description'} · ` +
      `${plan.externalUrl ? 'external_url ✓' : 'no external_url'} · ` +
      `${plan.attributes?.length ?? 0} off-chain trait(s) · ` +
      `${Object.keys(plan.contentLocators).length} durable image locator(s) · ${plan.nodeCustody.length} source-only image(s)`,
  );

  // 3) Re-pin any source-only images to a DURABLE backend so the destination never points back at
  //    the soon-to-be-gone source host. Fetch → verify vs the on-chain hash → put → bridge the NEW
  //    locator. If no durable backend is configured, bridge nothing source-bound and report it.
  const repinnedTokens = new Set<string>();
  if (plan.nodeCustody.length) {
    step('Re-pin source-only images');
    const backend = resolveBackend(storageOptions(storageOverrides(flags)));
    const rp = await repinNodeCustody(plan.nodeCustody, backend);
    for (const [hash, loc] of Object.entries(rp.repinned)) plan.contentLocators[hash] = loc;
    rp.repinnedTokens.forEach((id) => repinnedTokens.add(id));
    if (rp.repinnedTokens.length)
      ok(`re-pinned ${rp.repinnedTokens.length} image(s) to '${backend.id}' (verified vs on-chain hash) — bridged to the destination`);
    if (rp.mismatched.length)
      warn(`${rp.mismatched.length} image(s) FAILED hash verification — NOT pinned (source bytes don't match the chain): token(s) ${rp.mismatched.map((n) => n.tokenId).join(', ')}`);
    if (rp.unreachable.length)
      warn(`${rp.unreachable.length} image(s) couldn't be fetched from the source: token(s) ${rp.unreachable.map((n) => n.tokenId).join(', ')} — is the source still up?`);
    if (rp.needsDurableBackend.length) {
      warn(`${rp.needsDurableBackend.length} source-only image(s) NOT migrated — backend '${backend.id}' has no durable locator: token(s) ${rp.needsDurableBackend.map((n) => n.tokenId).join(', ')}`);
      info(`re-run with a durable backend: ${g('abx migrate ' + address + ' --from ' + from + ' --to ' + to + ' --backend ipfs')} (or --backend arweave).`);
    }
  }

  // 4) Bridge it to the destination — one admin call registers + replays + enriches.
  step('Populate the destination');
  const locCount = Object.keys(plan.contentLocators).length;
  const body: RegisterProjectBody = {
    chainId,
    address,
    // The deploy block (locally known); if somehow absent, omit it so the destination derives it
    // rather than scanning from genesis (never bake a from-0 floor into a fresh resolver).
    fromBlock: local.deployBlock ?? flags['from-block'] ?? undefined,
    factory,
    label: flags.label,
    description: plan.description,
    externalUrl: plan.externalUrl,
    attributes: plan.attributes as RegisterProjectBody['attributes'],
    contentLocators: locCount ? plan.contentLocators : undefined,
    full: true, // first registration on the destination — replay from the deploy block
  };
  info(`${bold('REMOTE')} → ${to} ${dim('(control plane — chain replay + off-chain enrichment)')}`);
  let r;
  try {
    r = await serviceClient(toTarget).registerProject(body);
  } catch (err) {
    throw describeRemoteError(err, toTarget, 'migrate destination');
  }
  // Always wait here, even if the caller passed --no-wait: the parity check below reads the
  // destination's served metadata, and comparing a half-indexed projection would report a false
  // mismatch — worse than a slow migrate.
  await reportRemoteIndexing(toTarget, chainId, address, r, {}, 'indexed');

  // 5) Parity check — does the destination now serve the same metadata as the source? Sample a
  //    token we did NOT re-pin (a re-pinned image is durable-locator-on-dest vs old-host-on-source
  //    BY DESIGN — different there is correct, so comparing it would mislead).
  step('Verify parity');
  const sample =
    local.tokens.find((t) => t.lifecycle === 'live' && !repinnedTokens.has(t.tokenId)) ??
    local.tokens.find((t) => t.lifecycle === 'live') ??
    local.tokens[0];
  if (sample) {
    const par = await verifyParity(from, to, chainId, address, sample.tokenId);
    const mark = (ok_: boolean) => (ok_ ? g('✓') : `${c.red}✗${c.reset}`);
    const imgRepinned = repinnedTokens.has(sample.tokenId);
    console.log(
      `    token #${sample.tokenId}: ` +
        `${imgRepinned ? `${g('✓')} image ${dim('(re-pinned → durable; differs from source by design)')}` : `${mark(par.imageMatch)} image`}  ` +
        `${mark(par.descriptionMatch)} description  ${mark(par.attributesMatch)} attributes`,
    );
    if (!imgRepinned && !par.imageMatch) info(`source image ${par.sourceImage ?? '∅'}  →  dest image ${par.destImage ?? '∅'}`);
  } else {
    info('no minted tokens to compare yet');
  }

  // 6) Cut over — NOT done here; the operator re-points DNS or the on-chain base URI.
  step('Cut over (manual)');
  info('the destination now serves identical metadata. Point traffic at it ONE of two ways:');
  console.log(`    ${bold('• custom domain')} — re-point DNS to the new host. On-chain base URI unchanged: no tx, no gas.`);
  console.log(
    `    ${bold('• provider endpoint')} (e.g. *.fly.dev) — re-point the on-chain base URI: ` +
      `${g('abx set-token-uri ' + address + ' --uri <dest-base>')} (+ ${g('set-contract-uri')}). A wallet-signed tx.`,
  );
  info('keep the source running until DNS / base-URI propagates (source-only images were already re-pinned above, unless a warning said otherwise).');
}

/** DEV only: copy the minimal, buildable workspace source into the artifact dir so the emitted
 *  from-source Dockerfile has a self-contained build context — no node_modules, no repo access. */
export function vendorResolverSource(root: string, outDir: string): void {
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json']) {
    const src = joinPath(root, f);
    if (existsSync(src)) copyFileSync(src, joinPath(outDir, f));
  }
  cpSync(joinPath(root, 'packages'), joinPath(outDir, 'packages'), {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|dist|\.turbo)([/\\]|$)/.test(src),
  });
}

export async function cmdDeployResolver(flags: Flags) {
  const provider = flags.provider as ResolverProvider | undefined;
  if (!provider || !['fly', 'render', 'vps'].includes(provider)) {
    throw new Error('abx deploy-resolver --provider <fly|render|vps> [--domain meta.you.xyz] [--app <name>] [--dir deploy] [--from-source]');
  }
  const domain = flags.domain;
  const app = flags.app ?? (domain ? domain.split('.')[0] : 'abx-resolver');
  const dir = flags.dir ?? 'deploy';

  // How the emitted image gets the ABX code: npm package (production, default) vs a source build
  // (DEV — pre-publish / local iteration). The dev switch is a flag or ABX_RESOLVER_SOURCE=1 (the
  // sandbox sets the env var so a local agent gets a buildable artifact without knowing the flag).
  const fromSource = flags['from-source'] !== undefined || process.env.ABX_RESOLVER_SOURCE === '1';
  let sourcePackages: string[] | undefined;
  let pnpmVersion: string | undefined;
  let repoRoot: string | null = null;
  if (fromSource) {
    repoRoot = findRepoRoot();
    if (!repoRoot) {
      throw new Error(
        '--from-source (dev) needs a source checkout — pnpm-workspace.yaml not found above the CLI. ' +
          'In production omit it (or unset ABX_RESOLVER_SOURCE) to get the self-contained npm-based image.',
      );
    }
    const pkgDir = joinPath(repoRoot, 'packages');
    sourcePackages = readdirSync(pkgDir)
      .filter((d) => existsSync(joinPath(pkgDir, d, 'package.json')))
      .map((d) => `packages/${d}`)
      .sort();
    try {
      pnpmVersion = (JSON.parse(readFileSync(joinPath(repoRoot, 'package.json'), 'utf8')).packageManager ?? '').split('@')[1] || undefined;
    } catch {
      /* fall back to the provisioner's pinned default */
    }
  }

  const art = resolverArtifact({provider, app, domain, chain: CHAIN, fromSource, sourcePackages, pnpmVersion});
  const outDir = resolvePath(joinPath(dir, provider));

  console.log(bold(`\n  ABX Self-Host Toolkit — provision resolver (${provider})`));
  info(fromSource ? `image: ${bold('from source')} ${dim('(DEV — builds from vendored workspace source; production uses the npm image)')}` : `image: ${bold('npm')} ${dim('(production — installs the published @artblocks/abx-cli; add --from-source for a local pre-publish build)')}`);
  info(`base URL: ${bold(art.baseUrl)} ${dim('— baked into ABX_PUBLIC_BASE_URL; the resolver serves its image/animation links from this')}`);

  // The resolver bakes ABX_RPC_URLS as a host secret and runs the getLogs-heavy reconstruction, so
  // vet the range NOW — a capped RPC under marketplace load is slow + rate-limit-prone (a top cause
  // of a hosted resolver that "won't index"). Best-effort: never block the scaffold on a probe.
  try {
    const probes = await probeRpcEndpoints({chainKey: CHAIN});
    const usable = probes.filter((pr) => pr.verdict !== 'unusable');
    if (usable.length === 0) warn(`no usable ${CHAIN} RPC in ABX_RPC_URLS — the resolver couldn't reconstruct. Add a wide-range archive endpoint before deploying (\`abx doctor\` rates them).`);
    else if (!probes.some((pr) => pr.verdict === 'best')) warn(`every ${CHAIN} RPC in ABX_RPC_URLS is getLogs-range-capped — a resolver under load will be slow + rate-limit-prone. Add a wide-range archive endpoint before baking it in (\`abx doctor\`).`);
    else info(`RPC range: ${g('✓')} a wide-range archive endpoint is available to bake into the resolver.`);
  } catch {
    /* probe is best-effort — never block scaffolding on it */
  }

  step('Write the deploy artifact (self-contained — Dockerfile + config, nothing to copy from a repo)');
  mkdirSync(outDir, {recursive: true});
  for (const f of art.files) {
    writeFileSync(joinPath(outDir, f.path), f.content);
    info(`wrote ${joinPath(dir, provider, f.path)}`);
  }
  if (fromSource && repoRoot) {
    // DEV only: vendor the workspace source INTO the artifact dir so the image builds pre-publish.
    // The CLI does this deterministically (it knows its own checkout) — the caller never touches
    // the repo, so the "everything comes from the CLI" contract still holds.
    vendorResolverSource(repoRoot, outDir);
    info(`vendored the workspace source into ${joinPath(dir, provider)}/ (root manifests + packages/, no node_modules)`);
  }

  step(`Next steps (run from ${bold(joinPath(dir, provider))}/ — they use your own cloud account)`);
  art.steps.forEach((s, i) => console.log(`    ${g(`${i + 1}.`)} ${s}`));

  if (domain) {
    step('DNS — one record points your domain at the host');
    info(art.dns ?? '');
    info(`re-point THIS record (not an on-chain tx) if you ever move hosts — the domain is the durable pointer.`);
  } else {
    info(`No --domain given — baked the platform hostname ${bold(art.baseUrl)} so the resolver works out of the box.`);
    if (provider === 'fly') info(`If ${bold('fly launch')} assigns a different app name (yours was taken), update it: ${bold('fly secrets set ABX_PUBLIC_BASE_URL=https://<real-app>.fly.dev')}`);
    info('For a portable setup, re-run with --domain meta.yourproject.xyz — moving hosts is then a DNS change, not an on-chain re-point.');
  }

  step('Admin token — lets you tell THIS resolver which contracts to index');
  const {generated} = ensureAdminToken();
  if (generated) {
    ok('generated ABX_REMOTE_SELF_TOKEN and saved it to your local .env (a secret — not printed, env-only).');
  } else {
    info('using the existing ABX_REMOTE_SELF_TOKEN from your .env.');
  }
  info('Set the SAME value on the resolver, as ABX_RESOLVER_ADMIN_TOKEN (the deploy steps above include the command) — its');
  info('own var name, server-side; your local copy is ABX_REMOTE_SELF_TOKEN, the named remote called "self". Authorizes');
  info('indexing control only — never on-chain signing, so the "no signing key on the host" rule holds.');

  step('Security posture');
  info(art.hardening);
  info('The host is READ-ONLY: it only serves + accepts admin index-control; no signing key lives on it.');

  step('Then deploy your NFT, and REGISTER it with this (remote) resolver');
  const url = art.baseUrl;
  info(`abx deploy --image <file> --name … --public-base-url ${url}   (or export ABX_PUBLIC_BASE_URL=${url})`);
  info(`the contract derives ${url}/t/${resolveChain(CHAIN).id}/{address}/{tokenId} from that base.`);
  info(`${bold('then')} abx add <clone> --remote   ${dim('# tell the remote resolver to index it — a LOCAL deploy does NOT')}`);
  info(dim(`prefer addressing it by name? add ABX_REMOTE_<NAME>_URL=${url} (+ ABX_REMOTE_<NAME>_TOKEN=<the same token>) to .env → abx add <clone> --remote <name>`));
  console.log('');
}

// ── deploy-effects: scaffold the render runner (the resolver's browser-bearing companion) ─────
// A code project's marketplace still is rendered off-chain, so SOMETHING must run the live view in a
// browser and hand the resolver the result. This scaffolds that runner (Playwright + Chromium) for
// Fly, wired to publish each render to the resolver's control plane (the locator bridge).
export async function cmdDeployEffects(flags: Flags) {
  const provider = (flags.provider as string | undefined) ?? 'fly';
  if (provider !== 'fly') {
    throw new Error(
      'abx deploy-effects currently scaffolds for --provider fly (on other hosts, run Dockerfile.effects beside the resolver with the same env). ' +
        'usage: abx deploy-effects --resolver-url https://<resolver> [--app <name>] [--dir deploy] [--interval-ms 300000] [--env-id web:any]',
    );
  }
  const resolverUrl = (flags['resolver-url'] as string | undefined) ?? process.env.ABX_RESOLVER_URL ?? process.env.ABX_PUBLIC_BASE_URL;
  if (!resolverUrl) {
    throw new Error(
      'abx deploy-effects needs the resolver URL — pass --resolver-url https://<resolver> (or set ABX_RESOLVER_URL / ABX_PUBLIC_BASE_URL). ' +
        'The runner reads token state from it and publishes each render back to it.',
    );
  }
  const cleanResolver = resolverUrl.replace(/\/$/, '');
  const app = (flags.app as string | undefined) ?? `${cleanResolver.replace(/^https?:\/\//, '').split(/[./]/)[0]}-effects`;
  const dir = (flags.dir as string | undefined) ?? 'deploy';
  const intervalMs = flags['interval-ms'] ? Number(flags['interval-ms']) : undefined;
  const environmentId = (flags['env-id'] as string | undefined) ?? process.env.ABX_ENVIRONMENT_ID;
  const storageBackend = process.env.ABX_STORAGE_BACKEND;
  // A HOSTED runner holds its own render bytes and hands the resolver a URL — that's the whole
  // topology (`site/content/docs/protocol/effects.mdx → Bound vs referenced`). The default `fs` writes to the
  // runner CONTAINER's disk, which nothing else can reach, so there is no URL to publish: the runner
  // now REFUSES to start on that config. Scaffolding it anyway would just deploy a container that
  // exits, so this is a hard stop rather than the warning it used to be.
  if (!storageBackend || storageBackend === 'fs') {
    throw new Error(
      `ABX_STORAGE_BACKEND is ${storageBackend ? "'fs'" : 'unset (defaults to fs)'} — a hosted runner can't serve renders off its own container disk, ` +
        `and it refuses to start without a backend that can name a public URL for what it stores.\n` +
        `  Set ABX_STORAGE_BACKEND to one of (equal options — pick on cost/ops):\n` +
        `    ${bold('cloud')} (alias s3)  S3 / R2 / B2 with ABX_S3_* + a public base\n` +
        `    ${bold('ipfs')}             Pinata or your own Kubo + a public gateway\n` +
        `    ${bold('arweave')}          pay-once permanent (<100KiB uploads are free)\n` +
        `  …then re-run. (Rendering on the resolver's own host instead? Use ${bold('abx effects')} co-located — no publish lane, no locator needed.)`,
    );
  }

  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    throw new Error('abx deploy-effects builds the runner from workspace source — run it from the ABX checkout (pnpm-workspace.yaml not found above the CLI).');
  }
  const pkgDir = joinPath(repoRoot, 'packages');
  const sourcePackages = readdirSync(pkgDir)
    .filter((d) => existsSync(joinPath(pkgDir, d, 'package.json')))
    .map((d) => `packages/${d}`)
    .sort();
  let pnpmVersion: string | undefined;
  try {
    pnpmVersion = (JSON.parse(readFileSync(joinPath(repoRoot, 'package.json'), 'utf8')).packageManager ?? '').split('@')[1] || undefined;
  } catch {
    /* fall back to the provisioner's pinned default */
  }

  const art = effectsArtifact({app, resolverUrl: cleanResolver, chain: CHAIN, intervalMs, environmentId, storageBackend, sourcePackages, pnpmVersion});
  const outDir = resolvePath(joinPath(dir, 'effects'));

  console.log(bold(`\n  ABX Self-Host Toolkit — provision effects runner (fly)`));
  info(`resolver: ${bold(cleanResolver)} ${dim('(reads token state + publishes renders here)')}`);
  info(`storage home: ${bold(storageBackend!)} ${dim('— the runner HOLDS the render bytes here and publishes their URL; the resolver redirects to it and never proxies')}`);

  step('Write the effects artifact (self-contained — Dockerfile.effects + fly.toml + vendored source)');
  mkdirSync(outDir, {recursive: true});
  for (const f of art.files) {
    writeFileSync(joinPath(outDir, f.path), f.content);
    info(`wrote ${joinPath(dir, 'effects', f.path)}`);
  }
  vendorResolverSource(repoRoot, outDir);
  info(`vendored the workspace source into ${joinPath(dir, 'effects')}/ (root manifests + packages/, no node_modules)`);

  step(`Next steps (run from ${bold(joinPath(dir, 'effects'))}/ — they use your own cloud account)`);
  art.steps.forEach((s, i) => console.log(`    ${g(`${i + 1}.`)} ${s}`));

  step('Admin token — the runner publishes renders to the resolver with it (index-control only, never signing)');
  const {generated} = ensureAdminToken();
  if (generated) ok('generated ABX_REMOTE_SELF_TOKEN and saved it to your local .env (a secret — not printed, env-only).');
  else info('using the existing ABX_REMOTE_SELF_TOKEN from your .env.');
  info('It MUST match ABX_RESOLVER_ADMIN_TOKEN on the resolver (`abx deploy-resolver` set the same value) — publishing is admin-gated.');

  step('Effects token — gates this PUBLIC runner\'s /run + /notify (the resolver\'s watcher sends it)');
  const eff = ensureEffectsToken();
  if (eff.generated) ok('generated ABX_EFFECTS_TOKEN and saved it to your local .env (a secret — not printed, env-only).');
  else info('using the existing ABX_EFFECTS_TOKEN from your .env.');
  info('Set it on BOTH apps (the steps above do): the runner enforces it; the resolver sends it with every notify.');

  step('Security posture');
  info(art.hardening);
  console.log('');
}
