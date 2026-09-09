/**
 * Remote-resolver resolution — which service `--remote` means, and whose credential drives it.
 * The HTTP client itself lives in the SDK (`AbxServiceClient`, speaking the /v1 control plane from
 * site/content/docs/using-abx/remote-services.mdx); this module owns the CLI conventions around it:
 *
 *   --remote <name>   a NAMED remote — `ABX_REMOTE_<NAME>_URL` + `ABX_REMOTE_<NAME>_TOKEN` in .env
 *                     (same env-name normalization as ABX_RPC_URLS_<CHAIN>). "self" is just a name
 *                     under this SAME convention — the node YOU run reads ABX_REMOTE_SELF_URL/_TOKEN
 *                     with zero special-casing below. A managed provider's per-account API key lives
 *                     under its own name — and deliberately NEVER falls back to ABX_REMOTE_SELF_TOKEN,
 *                     so your node-admin secret can't silently go to a third party.
 *                     `abx` is the built-in first-party name: https://services.abx.io plus
 *                     ABX_SERVICES_API_KEY. It needs no URL pasted into project configuration.
 *   --remote <url>    an ad-hoc URL — token from --remote-token or ABX_REMOTE_SELF_TOKEN (the local
 *                     client credential for a node you run; `abx deploy-resolver` generates it).
 *   --remote          bare: the self-host default — ABX_PUBLIC_BASE_URL (the URL baked on-chain,
 *                     else ABX_RESOLVER_URL) + ABX_REMOTE_SELF_TOKEN.
 *
 * Every token here authorizes indexing/metadata control only — never on-chain signing — so the
 * "no signing key on the host" rule is intact. (`--remote-token`, not `--token`: `--token` already
 * means a token ID across the owner ops.)
 *
 * The RESOLVER's own env var — what gates ITS control plane, server-side (packages/token-api/src/
 * control-plane.ts) — is unchanged: still `ABX_RESOLVER_ADMIN_TOKEN`. Only the CLIENT-side lookup
 * for a self-run node moved to the named-remote grammar above; `abx deploy-resolver` prints the exact
 * command that carries the value across the name boundary (fly secrets set ABX_RESOLVER_ADMIN_TOKEN
 * from your local ABX_REMOTE_SELF_TOKEN).
 */

import {
  AbxIndexTimeoutError,
  AbxServiceClient,
  AbxServiceError,
  envSuffix,
  indexProgress,
  isAccepted,
  type Address,
  type IndexError,
  type IndexErrorClass,
  type IndexStatus,
  type ProvenanceResult,
  type RegisterProjectResult,
  type RemoteProjectStatus,
} from '@artblocks/abx-sdk';
import {CHAIN} from './config.js';
import {type Flags} from './flags.js';
import {bold, c, dim, g, info, ok, warn} from './output.js';

export const ABX_SERVICES_URL = 'https://services.abx.io';
export const ABX_SERVICES_API_KEY_VAR = 'ABX_SERVICES_API_KEY';

export type RemoteSource = 'url' | 'named' | 'builtin' | 'default';

export interface RemoteTarget {
  /** Base URL, trailing slashes stripped. */
  url: string;
  token?: string;
  /** The normalized remote name (named form only). */
  name?: string;
  source: RemoteSource;
  /** The env var that should hold this target's token — every error/skip message names it. */
  tokenVar: string;
  /** WHERE the token in hand actually came from. A 401 that blames the env var when the caller
   *  passed `--remote-token` makes the override look ignored — which is exactly the moment someone
   *  is testing a replacement key. */
  tokenFrom?: 'flag' | 'env';
}

/** How to refer to the credential this target is using, in an error the creator has to act on. */
export function tokenSourceLabel(t: RemoteTarget): string {
  return t.tokenFrom === 'flag' ? 'the token you passed with --remote-token' : t.tokenVar;
}

/**
 * Resolve the `--remote` flag value (undefined = local op → null). Pure: pass `env` in tests.
 * `tokenFlag` is `--remote-token` and wins over any env token for this invocation.
 */
export function resolveRemote(
  spec: string | undefined,
  tokenFlag?: string,
  env: NodeJS.ProcessEnv = process.env,
): RemoteTarget | null {
  if (spec === undefined) return null;
  const strip = (u: string) => u.replace(/\/+$/, '');

  // bare `--remote` — the self-host default (the resolver this project's on-chain URIs point at)
  if (spec === 'true' || spec === '') {
    const base = env.ABX_PUBLIC_BASE_URL ?? env.ABX_RESOLVER_URL;
    if (!base) {
      throw new Error(
        '`--remote` needs a target: pass `--remote <name>` (ABX_REMOTE_<NAME>_URL in .env), `--remote https://host`, or set ABX_PUBLIC_BASE_URL in .env',
      );
    }
    return {url: strip(base), token: tokenFlag ?? env.ABX_REMOTE_SELF_TOKEN, source: 'default', tokenVar: 'ABX_REMOTE_SELF_TOKEN', tokenFrom: tokenFlag ? 'flag' : 'env'};
  }

  // `--remote <url>` — ad-hoc URL, self-host credential conventions
  if (spec.includes('://')) {
    return {url: strip(spec), token: tokenFlag ?? env.ABX_REMOTE_SELF_TOKEN, source: 'url', tokenVar: 'ABX_REMOTE_SELF_TOKEN', tokenFrom: tokenFlag ? 'flag' : 'env'};
  }

  // The first-party provider has a stable, verified identity. Keep it out of standing agent docs
  // and generic URL config: a user stores only the credential, while an explicit URL remains the
  // escape hatch for local/staging services.
  if (envSuffix(spec) === 'ABX') {
    return {
      url: ABX_SERVICES_URL,
      token: tokenFlag ?? env[ABX_SERVICES_API_KEY_VAR],
      name: 'ABX',
      source: 'builtin',
      tokenVar: ABX_SERVICES_API_KEY_VAR,
      tokenFrom: tokenFlag ? 'flag' : 'env',
    };
  }

  // `--remote <name>` — a named remote (a managed provider, another node of yours, a staging box)
  const name = envSuffix(spec);
  const urlVar = `ABX_REMOTE_${name}_URL`;
  const tokenVar = `ABX_REMOTE_${name}_TOKEN`;
  const url = env[urlVar];
  if (!url) {
    throw new Error(
      `--remote ${spec}: no ${urlVar} in your .env. Set ${urlVar}=<the provider's base URL> (+ ${tokenVar}=<your API key>). ` +
        `(Meant a URL? Pass a scheme: --remote https://host)`,
    );
  }
  return {url: strip(url), token: tokenFlag ?? env[tokenVar], name, source: 'named', tokenVar, tokenFrom: tokenFlag ? 'flag' : 'env'};
}

/**
 * The OLD client-side var (`ABX_RESOLVER_ADMIN_TOKEN`) sitting unused in `.env` because the
 * self-host default's credential moved to the named-remote grammar (`ABX_REMOTE_SELF_TOKEN`) — a
 * silent fallback would mean an operator's `.env` never gets renamed, so this is the ONE place both
 * {@link requireRemoteToken} (the hard-stop for a real command) and `abx doctor` (the same fault,
 * surfaced before a command needs it) decide whether to flag it — sharing the check means they can
 * never drift on the condition. `null` when there's nothing to flag (old var absent, or the new one
 * is already set and simply wins).
 */
export function selfTokenMigrationWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.ABX_RESOLVER_ADMIN_TOKEN || env.ABX_REMOTE_SELF_TOKEN) return null;
  return (
    'ABX_RESOLVER_ADMIN_TOKEN is set but is no longer read for the self-host default — rename it to ' +
    'ABX_REMOTE_SELF_TOKEN (and, if you address it by name, ABX_REMOTE_SELF_URL).'
  );
}

/** The token, when the remote is the command's OBJECT (add/index/forget/render/migrate-dest) —
 *  a missing credential is a hard stop that names the exact var to set. */
export function requireRemoteToken(t: RemoteTarget, env: NodeJS.ProcessEnv = process.env): string {
  if (t.token) return t.token;
  if (t.source === 'builtin') {
    throw new Error(
      `remote 'abx' needs ${ABX_SERVICES_API_KEY_VAR} in your private .env, or --remote-token. ` +
        `Run \`abx auth login\` for the browser-approved flow (manual fallback: ${ABX_SERVICES_URL}/signup).`,
    );
  }
  if (t.source === 'named') {
    // The likeliest cause of "URL but no token" is a near-miss var name, and the value is sitting
    // right there in .env — so name it instead of letting them diff strings by eye.
    const nearMiss = misnamedRemoteVars(env).find((v) => v.suggestion === t.tokenVar);
    throw new Error(
      `remote '${t.name}' has a URL but no token — set ${t.tokenVar} in your .env (the API key the provider issued), or pass --remote-token.` +
        (nearMiss ? `\n  Found ${nearMiss.key} in your env — that name isn't read; rename it to ${t.tokenVar}.` : ''),
    );
  }
  // The self-host default/URL lane used to read ABX_RESOLVER_ADMIN_TOKEN directly. It's now just
  // the named remote called "self" — no special-casing, same grammar as any other name — so the OLD
  // var is never read here. No silent fallback: point at both new vars, once, by name.
  const migration = selfTokenMigrationWarning(env);
  if (migration) throw new Error(`${migration} Or pass --remote-token.`);
  throw new Error(
    `remote ops need ${t.tokenVar} in your .env — it must match the token set on the resolver ` +
      '(`abx deploy-resolver` generates one and wires both sides). Or pass --remote-token.',
  );
}

/** Every named remote configured in the env (`ABX_REMOTE_<NAME>_URL`). The normalized name is
 *  canonical — the env convention is lossy, so enumeration reads the env, never inverts it. */
export function listConfiguredRemotes(env: NodeJS.ProcessEnv = process.env): Array<{name: string; url: string; hasToken: boolean}> {
  const out: Array<{name: string; url: string; hasToken: boolean}> = [
    {name: 'ABX', url: ABX_SERVICES_URL, hasToken: !!env[ABX_SERVICES_API_KEY_VAR]},
  ];
  for (const [key, value] of Object.entries(env)) {
    const m = /^ABX_REMOTE_(.+)_URL$/.exec(key);
    if (!m || !value) continue;
    if (m[1] === 'ABX') continue;
    out.push({name: m[1], url: value.replace(/\/+$/, ''), hasToken: !!env[`ABX_REMOTE_${m[1]}_TOKEN`]});
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `ABX_REMOTE_*` vars that follow no recognized suffix — i.e. a typo. The convention has exactly two
 * suffixes (`_URL`, `_TOKEN`), and anything else (`_KEY`, `_APIKEY`, `_SECRET`) is silently ignored:
 * the CLI reports "no token" while the value sits right there in `.env`. Cheap to detect, so detect
 * it rather than leaving the creator to compare strings by eye.
 */
export function misnamedRemoteVars(env: NodeJS.ProcessEnv = process.env): Array<{key: string; suggestion: string}> {
  const out: Array<{key: string; suggestion: string}> = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith('ABX_REMOTE_') || key === 'ABX_REMOTE_TOKEN') continue;
    if (/_URL$/.test(key) || /_TOKEN$/.test(key)) continue;
    // Strip a trailing credential-ish word to recover the intended remote name.
    const name = key.replace(/^ABX_REMOTE_/, '').replace(/_(KEY|APIKEY|API_KEY|SECRET|PASS|PASSWORD|BEARER|AUTH)$/, '');
    out.push({key, suggestion: `ABX_REMOTE_${name}_TOKEN`});
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** The SDK service client bound to this target (call {@link requireRemoteToken} first when the
 *  operation needs auth). */
export function serviceClient(t: RemoteTarget): AbxServiceClient {
  return new AbxServiceClient({baseUrl: t.url, token: t.token});
}

/**
 * Is this named remote's stored credential actually accepted? One cheap authed read, so `doctor` can
 * report capability instead of mere presence.
 *
 * Doctor is the command a creator runs FIRST, and it used to print a clean `remotes: meridian` for a
 * key the service rejects — the 401 only surfaced later, from `abx remote <name>`, after they had
 * already trusted the line. Same class as an RPC that answers `[]` because it pruned its logs: an
 * empty success is not evidence of capability.
 *
 * Never throws and never blocks doctor for long: a short per-attempt timeout, and anything that is
 * not a definitive rejection is reported as a soft note rather than a ✗, because a slow or briefly
 * unreachable provider is not a misconfiguration the creator can act on.
 */
export async function probeRemoteCredential(
  name: string,
  timeoutMs = 4000,
): Promise<{ok: boolean; fatal: boolean; detail: string}> {
  const target = resolveRemote(name);
  if (!target) return {ok: false, fatal: false, detail: '(unresolved)'};
  try {
    // retryDelayMs 0: a 401 is definitive and never retries anyway, but an unreachable provider
    // would otherwise back off across four attempts and stall the one command that must stay quick.
    const client = new AbxServiceClient({baseUrl: target.url, token: target.token, timeoutMs, retryDelayMs: 0});
    const projects = await client.listProjects();
    return {ok: true, fatal: false, detail: `· ${projects.length} project(s) visible`};
  } catch (err) {
    if (err instanceof AbxServiceError && err.status === 401) {
      return {ok: false, fatal: true, detail: `token rejected (401) — fix or rotate ${tokenVarFor(name)}`};
    }
    if (err instanceof AbxServiceError && err.status === 403) {
      return {ok: false, fatal: false, detail: '(authorized key, scoped by the provider — not a misconfiguration)'};
    }
    return {ok: false, fatal: false, detail: `(unreachable right now: ${(err as Error).message.slice(0, 60)})`};
  }
}

/** The env var a named remote's token is read from — the one to name when it is rejected. */
export function tokenVarFor(name: string): string {
  if (name.toUpperCase() === 'ABX') return ABX_SERVICES_API_KEY_VAR;
  return `ABX_REMOTE_${name.toUpperCase()}_TOKEN`;
}

/**
 * Map a control-plane failure to an actionable CLI error. Keys off `AbxServiceError.code`/status,
 * never off message prose (the machine-code half of the interface spec):
 *   401 — the credential itself was rejected → name the var that supplied it.
 *   403 — credential fine, not authorized for this resource → provider scoping, don't retry.
 *   `disabled` — the node has no control-plane token configured at all.
 *   bare 404 on /v1 — no control plane at this URL (pre-/v1 node, or not an ABX service).
 */
export function describeRemoteError(err: unknown, t: RemoteTarget, label: string): Error {
  if (!(err instanceof AbxServiceError)) return err as Error;
  if (err.status === 0) {
    // Nothing answered. Say WHERE we asked and, for the bare form, which env var chose it — a lone
    // `fetch failed` leaves the creator with no idea which URL was even tried.
    const from =
      t.source === 'default'
        ? ' (bare `--remote` uses ABX_PUBLIC_BASE_URL, else ABX_RESOLVER_URL)'
        : t.source === 'named'
          ? ` (from ABX_REMOTE_${t.name}_URL)`
          : t.source === 'builtin'
            ? ' (built-in first-party ABX Services target)'
          : '';
    return new Error(`${label}: nothing responded at ${t.url}${from}. Is it running, and is that the right address?`);
  }
  if (err.status === 401) {
    return new Error(
      `${label}: 401 unauthorized — ${t.url} rejected ${tokenSourceLabel(t)}. ` +
        (t.tokenFrom === 'flag'
          ? `That value is wrong or stale — get a fresh key from the provider (${t.tokenVar} in .env is what a normal run reads).`
          : 'Fix or rotate the key (or pass --remote-token to test a replacement).'),
    );
  }
  if (err.status === 403) {
    return new Error(
      `${label}: 403 forbidden — the token is valid but not authorized for this project/chain (provider-side scoping, not a typo). ` +
        `Check the provider's dashboard and its descriptor (\`abx remote ${t.name ?? t.url}\`).`,
    );
  }
  if (err.code === 'not_registered') {
    // The likeliest cause when READING a remote (status/index/render) is that the bridge step was
    // never done — the service has no idea this contract exists. Name the fix, not the 404.
    return new Error(
      `${label}: ${t.url} doesn't have this project registered — it can't serve or report on a contract it was never told about. ` +
        `Register it: \`abx add <address> --remote ${t.name?.toLowerCase() ?? t.url}\`.`,
    );
  }
  if (err.code === 'disabled') {
    return new Error(`${label}: the resolver at ${t.url} has no control-plane token configured — it can't accept remote registrations. For your own node, set ABX_RESOLVER_ADMIN_TOKEN on it (\`abx deploy-resolver\` wires it).`);
  }
  if (err.status === 404 && !err.code) {
    return new Error(
      `${label}: ${t.url} has no /v1 control plane — an older resolver (redeploy it: \`abx deploy-resolver\`), or not an ABX service. ` +
        `Check: curl ${t.url}/.well-known/abx-service`,
    );
  }
  // A 5xx that volunteered a failure CLASS is the difference between "wait" and "something is
  // broken" — and it's the only thing a credential-free 500 body is allowed to tell us, so use it.
  if (err.class === 'rpc_rate_limited' || err.class === 'rpc_unavailable') {
    return new Error(
      `${label}: the service reached its chain RPC ${err.class === 'rpc_rate_limited' ? 'rate limit' : 'and got no answer'} (${err.class}) — ` +
        `not your credential and not your address. It retries with backoff; check progress with \`abx status <address> --remote ${t.name?.toLowerCase() ?? t.url}\`.`,
    );
  }
  return new Error(`${label}: ${err.message}`);
}

// The `--remote <name|url>` target (remote.ts owns the convention): a named remote's
// `ABX_REMOTE_<NAME>_URL/_TOKEN`, an ad-hoc URL, or bare `--remote` = the self-host default.
// Returns null for a local op (the default).
export function remoteFlag(flags: Flags): RemoteTarget | null {
  return resolveRemote(flags.remote, flags['remote-token'] as string | undefined);
}

/**
 * The factory-verification tri-state, said plainly. `null` means the check never ran (no factory
 * configured, or the configured one has no code on this chain — common on a local/dev chain), which
 * is NOT the same as the chain telling us this contract isn't a clone of it.
 */
export function canonicalLabel(isCanonical: boolean | null | undefined, provenance?: ProvenanceResult): string {
  if (isCanonical === true) {
    // Say WHICH generation stamped it, and its core version — "canonically ABX v2" is a thing a
    // consumer can repeat, and `abxVersion()` on the clone is where they can verify it themselves.
    const v = provenance?.coreVersion !== null && provenance?.coreVersion !== undefined ? ` — ABX v${provenance.coreVersion}` : '';
    if (provenance?.generation === 'prior') {
      return `${g('yes (factory-verified)')}${dim(`${v}, a PRIOR anchor generation — canonically ABX, deployed by a factory since replaced`)}`;
    }
    return g(`yes (factory-verified${v})`);
  }
  // "the configured factory" (singular) understated the check and misdirected the reader: since the
  // edition anchors were added, `detectCanonicalFactory` probes ALL SIX trust anchors (three 721 +
  // three ERC-1155) and only falls back to the 1/1 anchor when none of them claim the clone. So a
  // `false` means "no trust anchor this CLI knows deployed this", not "you configured the wrong one" —
  // and the usual real cause is a contract from a SUPERSEDED factory, or one deployed by hand.
  if (isCanonical === false) {
    return `${c.orange}NO — not a clone of any trust anchor this CLI knows${c.reset}${dim(' (a superseded factory, or deployed outside one — `abx doctor` lists the current anchors)')}`;
  }
  if (provenance && provenance.anchorsAnswered === 0) {
    return dim('not checked (no anchor answered — a coverage gap, not a verdict; retry or check the RPC)');
  }
  return dim('not checked (no canonical factory for this chain — `abx doctor` shows which)');
}

/** How a lifecycle state reads at a glance — the same word everywhere it's printed. */
export function statusLabel(s: IndexStatus): string {
  if (s === 'live') return g('live');
  if (s === 'failed') return `${c.orange}failed${c.reset}`;
  if (s === 'stale') return `${c.orange}stale${c.reset}`;
  return dim(s); // queued | backfilling — in progress, not a problem
}

/** `label   value` with only the label dimmed — status values carry their own color, and wrapping
 *  them in `info()` would fight it. */
export const statusRow = (label: string, value: string) => console.log(`    ${dim(label.padEnd(10))} ${value}`);

/**
 * What to DO about a failure class — whose problem it is and whether waiting is the answer.
 * The class alone told an agent enough to reason it out; it does not tell a creator, and "whose
 * problem is this" is the single question a failed catch-up has to answer.
 */
export function indexErrorAction(cls: IndexErrorClass): string {
  if (cls === 'rpc_rate_limited') return "the SERVICE's chain RPC is throttled — not your key, address, or chain. It retries on its own; if it stays this way, that's the operator's to fix.";
  if (cls === 'rpc_unavailable') return "the SERVICE can't reach its chain RPC — not your key, address, or chain. It retries on its own; if it stays this way, contact the operator.";
  if (cls === 'not_abx_contract') return 'the service found no ABX events at that address on this chain — check the address and that the service serves the right chain.';
  return 'the cause is in the service operator’s logs — nothing you can fix from here; contact them if it persists.';
}

/** The one wording for "registered, but catch-up failed" — shared by add/index so both say the same
 *  thing: what failed, whose problem it is, and that the registration survived. */
export function failedCatchUpMessage(address: Address, remote: RemoteTarget, err: IndexError | undefined, check: string): string {
  const cls = err?.class;
  return (
    `${address} is registered on ${remote.url}, but its catch-up FAILED` +
    `${cls ? ` (${cls}${err?.message ? `: ${err.message}` : ''})` : ''}.\n` +
    `  ${cls ? `→ ${indexErrorAction(cls)}\n  ` : ''}` +
    `The registration is durable and the service retries with backoff — watch it with ${bold(check + ' --watch')}.`
  );
}

/**
 * One human line for a status read: where it is, how far along, and why if it's unhappy.
 *
 * What "where" means depends on the state, so say the right thing rather than one number that reads
 * differently in each: a percentage is only honest while BACKFILLING (see indexProgress). A `live`
 * project's `toBlock` only advances when that project has events, so on a busy chain a perfectly
 * current project sits far below head — printing that as a ratio makes healthy look broken.
 */
export function statusLine(s: RemoteProjectStatus): string {
  const p = indexProgress(s);
  let where: string;
  if (p) where = `${s.toBlock}/${s.headBlock} ${dim(`(${p.percent}%)`)}`;
  else if (!s.toBlock) where = dim('not indexed yet');
  else if (s.status === 'live') where = `${g('caught up')} ${dim(`· scanned through block ${s.toBlock}`)}`;
  else if (s.status === 'stale') where = `${dim('not tracking head right now')} ${dim(`· scanned through block ${s.toBlock}${s.headBlock ? ` of ${s.headBlock}` : ''}`)}`;
  else where = dim(`scanned through block ${s.toBlock}`);
  const why = s.error ? `  ${c.orange}${s.error.class}${c.reset}${s.error.message ? dim(` — ${s.error.message}`) : ''}` : '';
  return `${statusLabel(s.status)}  ${where}${why}`;
}

/**
 * Report a register/reindex answer, whichever of the two conformant shapes the service used.
 *
 * A `200` already carries the counts. A `202` means the registration is durable and catch-up is still
 * running — so by default we poll to a terminal state and print the SAME summary line, giving the
 * human the "waits, then tells you what happened" UX without the service holding a socket open for
 * minutes. `--no-wait` stops at the 202 and names the command that checks later.
 */
export async function reportRemoteIndexing(
  remote: RemoteTarget,
  chainId: number,
  address: Address,
  r: RegisterProjectResult,
  flags: Flags,
  verb: string,
): Promise<void> {
  // A real ABX clone ALWAYS emits a spine (its extension registrations at minimum), so a caught-up
  // projection with zero events means the service scanned the wrong chain/floor or its RPC hasn't
  // served the logs — not that the project is empty. A ✓ there is the lie that produces an empty
  // dashboard (the same guard `reindexAfterDeploy` applies locally).
  const settledLine = (events: number, tail: string) => {
    if (events > 0) ok(`remote resolver ${verb} ${address}: ${tail}`);
    else warn(`${address} is registered and caught up on ${remote.url}, but with ${bold('0 events')} — it will serve nothing. Check the service covers ${CHAIN} and that its RPC serves logs from the deploy block.`);
  };
  if (!isAccepted(r)) {
    settledLine(r.project.eventCount, `${r.project.eventCount} events ${dim(`(${r.mode}, ${r.elapsedMs}ms)`)}`);
    return;
  }
  const spec = remote.name ? remote.name.toLowerCase() : remote.source === 'default' ? '' : remote.url;
  const check = `abx status ${address} --remote${spec ? ` ${spec}` : ''}`;
  // The registration is durable in EVERY branch here — but don't claim it "is catching up" when the
  // service already told us the catch-up failed. Two different sentences for two different facts.
  if (r.project.status === 'failed') {
    // Lead with the outcome, not the successful sub-step: a line starting "registered on …" reads
    // as success even with the failure later in the sentence.
    warn(`${bold('catch-up FAILED')} on ${remote.url} — nothing is being served yet ${dim('(the registration itself is durable; the service retries it)')}`);
  } else {
    info(`registered — ${r.project.status} ${dim('(the service accepted it and is catching up; the registration is durable)')}`);
  }
  // A known failure is not something to "not wait" for — we already have the answer, so report it as
  // one regardless of --no-wait (never a ✓ over a broken index).
  if (flags['no-wait'] !== undefined && r.project.status !== 'failed') {
    info(`not waiting (--no-wait). Check with ${bold(check)}`);
    return;
  }
  const label = `remote ${verb === 'indexed' ? 'add' : 'index'}`;
  if (r.project.status === 'failed') {
    // Fetch the class the register response may not have carried, so the "whose problem" line is
    // never missing on the path that reports the failure soonest.
    const st = await serviceClient(remote).projectStatus(chainId, address).catch(() => undefined);
    throw new Error(`${label}: ${failedCatchUpMessage(address, remote, st?.error ?? undefined, check)}`);
  }
  let shown = -100;
  let lastStatus: IndexStatus | undefined;
  try {
    const final = await serviceClient(remote).awaitIndexed(chainId, address, {
      onProgress: (s) => {
        const p = indexProgress(s);
        // Print on a state change or a meaningful step — a poll line every 3s is noise in a log an
        // agent has to read back.
        if (s.status !== lastStatus || (p && p.percent - shown >= 10)) {
          lastStatus = s.status;
          if (p) shown = p.percent;
          console.log(`      ${statusLine(s)}`);
        }
      },
    });
    if (final.status === 'failed') {
      throw new Error(`${label}: ${failedCatchUpMessage(address, remote, final.error, check)}`);
    }
    settledLine(final.eventCount, `${final.eventCount} events, ${final.tokenCount} token(s) ${dim('(live)')}`);
  } catch (err) {
    if (err instanceof AbxIndexTimeoutError) {
      warn(`${address} is still ${err.last?.status ?? 'catching up'} on ${remote.url} — nothing is lost, it just isn't done.`);
      info(`follow it with ${bold(check + ' --watch')}`);
      return;
    }
    // The service went away mid-wait (or rejected the poll). The registration still landed — say
    // which failure this is, in the same words every other remote command uses.
    if (err instanceof AbxServiceError) throw describeRemoteError(err, remote, `remote ${verb}: registered, but polling status`);
    throw err;
  }
}

/** "3 live, 1 backfilling, 1 failed (rpc_rate_limited)" — the one-line answer to "is my stuff ok?" */
export function rollUp(projects: Array<{status?: IndexStatus; error?: {class: string}}>): string {
  const counts = new Map<string, number>();
  for (const p of projects) {
    const k = p.status ?? 'unknown';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const classes = [...new Set(projects.filter((p) => p.error).map((p) => p.error!.class))];
  const parts = [...counts.entries()].map(([k, n]) => `${n} ${k}`);
  return `${parts.join(', ')}${classes.length ? ` ${dim(`(${classes.join(', ')})`)}` : ''}`;
}
