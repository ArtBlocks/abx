/**
 * Remote-service conformance — the assertion set behind `abx remote <name|url> --conformance`
 * (see `commands/service.ts`'s `cmdRemoteConformance`). A third party can self-certify a hosted
 * resolver against the published CLI with no repository checkout.
 *
 * `scripts/e2e-remote-resolver.sh` runs the CLI command against the reference container and greps
 * stdout for the literal `✓ conformant`. Keep {@link verdictLine} and
 * {@link formatAssertion}'s prefixes stable.
 *
 * Dogfoods the SDK's `AbxServiceClient` — the same client the CLI drives against a remote resolver
 * — so passing here means the real tooling interoperates with the target service, per
 * `site/content/docs/using-abx/remote-services.mdx`.
 *
 * Tiers (each unlocks with the inputs given — a bare URL with no token still runs the always-tier,
 * which is enough to self-certify the public surface with zero setup):
 *   always              descriptor served + required fields; unauthenticated write refused; the
 *                       read-plane's error taxonomy; every DECLARED interface's routes exist
 *   token               authed GET /v1/projects; the artifact registry refuses bound/referenced
 *                       output mismatches
 *   token + address     the full write loop: register → (poll to live) → status → reindex →
 *   + chainId           deregister. Needs a contract the service can actually replay, so point it
 *                       at one you own — this is the one tier that persists (then removes) state
 *                       on the target, which is why it stays opt-in behind BOTH flags together (a
 *                       token alone is not enough to reach it).
 *
 * A 403 anywhere in the loop reports as legitimate provider scoping (the token isn't authorized for
 * that contract), never a conformance failure.
 */
import {AbxServiceClient, AbxServiceError, CONTROL_PLANE_INTERFACE, TOKEN_API_INTERFACE, type IndexStatus, type ServiceDescriptor} from '@artblocks/abx-sdk';

export type AssertionStatus = 'pass' | 'fail' | 'note';

export interface Assertion {
  status: AssertionStatus;
  message: string;
}

export interface ConformanceOptions {
  baseUrl: string;
  /** Omit to run only the unauthenticated (always) tier. */
  token?: string;
  /** Which chain to probe when the descriptor doesn't pin one down. Required (with `address`) to
   *  unlock the register→deregister loop. */
  chainId?: number;
  /** A contract THIS token may register/deregister — unlocks the full write loop. Needs `chainId` too. */
  address?: string;
  fromBlock?: string;
  /** The register-loop's poll-to-`live` budget (default 120s/2s) — tests shrink both. */
  awaitTimeoutMs?: number;
  awaitIntervalMs?: number;
}

export interface ConformanceReport {
  baseUrl: string;
  assertions: Assertion[];
  failures: number;
}

interface ProbeResult {
  status?: number;
  body?: {code?: string; error?: string; chains?: number[]; didYouMean?: string};
  networkError?: Error;
}

const ZERO_ADDRESS = '0x' + '0'.repeat(40);
// Every lifecycle-bearing status field (register/status responses) must be one of these five words.
const LIFECYCLE: readonly IndexStatus[] = ['queued', 'backfilling', 'live', 'stale', 'failed'];

/** One ✓/✗/· line. Nested sub-bullets carry their own leading spaces in `message` (unchanged from
 *  the original script), so the indentation is intentional, not a formatting bug. */
export function formatAssertion(a: Assertion): string {
  const prefix = a.status === 'pass' ? '✓' : a.status === 'fail' ? '✗' : '·';
  return `  ${prefix} ${a.message}`;
}

/** The final line — kept byte-stable: `scripts/e2e-remote-resolver.sh` greps for '✓ conformant'. */
export function verdictLine(report: ConformanceReport): string {
  return report.failures ? `\n✗ ${report.failures} conformance failure(s)\n` : '\n✓ conformant\n';
}

export async function runConformance(opts: ConformanceOptions): Promise<ConformanceReport> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const assertions: Assertion[] = [];
  const pass = (message: string) => assertions.push({status: 'pass', message});
  const failed = (message: string) => assertions.push({status: 'fail', message});
  const note = (message: string) => assertions.push({status: 'note', message});
  const scoped = (err: unknown) => err instanceof AbxServiceError && err.status === 403;
  const probeAddr = opts.address ?? ZERO_ADDRESS;

  const readJson = async (path: string): Promise<ProbeResult> => {
    try {
      const res = await fetch(base + path);
      return {status: res.status, body: (await res.json().catch(() => ({}))) as ProbeResult['body']};
    } catch (err) {
      return {networkError: err as Error};
    }
  };

  // ── tier 0: the descriptor ────────────────────────────────────────────────────
  const anon = new AbxServiceClient({baseUrl: base});
  let descriptor: ServiceDescriptor | null = null;
  try {
    descriptor = await anon.descriptor();
    pass('GET /.well-known/abx-service serves JSON');
  } catch (err) {
    failed(`no service descriptor: ${(err as Error).message}`);
  }
  if (descriptor) {
    Array.isArray(descriptor.interfaces) && descriptor.interfaces.length
      ? pass(`interfaces declared: ${descriptor.interfaces.join(' · ')}`)
      : failed('descriptor.interfaces missing/empty (required)');
    Array.isArray(descriptor.chains) && descriptor.chains.length
      ? pass(`chains declared: ${descriptor.chains.join(', ')}`)
      : failed('descriptor.chains missing/empty (required)');
    if (opts.chainId !== undefined) {
      descriptor.chains?.includes(opts.chainId)
        ? pass(`serves chain ${opts.chainId}`)
        : failed(`descriptor.chains does not include ${opts.chainId} — registrations for it should be refused`);
    }
    const controlPlane = descriptor.interfaces?.includes(CONTROL_PLANE_INTERFACE);
    if (controlPlane) {
      descriptor.auth?.scheme === 'bearer'
        ? pass('auth.scheme is "bearer"')
        : failed(`control plane declared but auth.scheme is ${JSON.stringify(descriptor.auth?.scheme)} (must be "bearer")`);
    } else {
      note(`control plane not declared (${CONTROL_PLANE_INTERFACE} absent) — register/list tiers will report accordingly`);
    }
    if (!descriptor.interfaces?.includes(TOKEN_API_INTERFACE)) note(`descriptor does not declare ${TOKEN_API_INTERFACE} — is this a resolver?`);
    if (descriptor.render?.attached) {
      note(`rendering is managed behind this service (effects: ${descriptor.render.effects ? descriptor.render.effects.map((e) => e.key).join(', ') : 'unverified'})`);
    }
  }

  // ── tier 0: unauthenticated writes must be refused ────────────────────────────
  const chainForProbe = opts.chainId ?? descriptor?.chains?.[0] ?? 1;
  try {
    await anon.registerProject({chainId: chainForProbe, address: probeAddr});
    failed('unauthenticated POST /v1/projects was ACCEPTED — the control plane must require a bearer token');
  } catch (err) {
    if (err instanceof AbxServiceError && err.status === 401) pass('unauthenticated register → 401');
    else if (err instanceof AbxServiceError && err.code === 'disabled') pass('control plane disabled on this node (404 code "disabled") — honest, conformant');
    else if (err instanceof AbxServiceError) failed(`unauthenticated register → ${err.status} ${err.code ?? ''} (expected 401, or 404 code "disabled")`);
    else failed(`unauthenticated register probe errored: ${(err as Error).message}`);
  }

  // ── tier 0: the read plane's error taxonomy ───────────────────────────────────
  // "No metadata came back" has three distinct causes, and a service that answers a bare 404 to all
  // of them is a trap: a client that hand-built a URL reads its own mistake as a provider outage and
  // files a bug against a working service. Each cause MUST be distinguishable by a machine `code` —
  // remote-services.md → "Three ways a read can miss".
  {
    // (a) a real route with the wrong shape — the observed mistake is dropping the tokenId off
    //     /t/{chainId}/{address}/{tokenId} while reaching for collection metadata.
    const shape = await readJson(`/t/${chainForProbe}/${probeAddr}`);
    if (shape.networkError) failed(`read-plane probe unreachable: ${shape.networkError.message}`);
    else if (shape.status === 400 && shape.body?.code === 'invalid_request') {
      pass('malformed token path → 400 invalid_request (not a bare 404)');
      /\/c\//.test(shape.body?.error ?? '') || shape.body?.didYouMean
        ? pass('  …and it points at /c/{chainId}/{address} for collection metadata')
        : note('  the 400 does not mention /c/{chainId}/{address} — SHOULD name the route that serves what the caller wanted');
    } else if (shape.status === 404) {
      failed(
        `malformed token path /t/${chainForProbe}/${probeAddr} → bare 404 ${JSON.stringify(shape.body?.code ?? null)} — ` +
          'MUST be 400 invalid_request naming the correct template; a 404 here is indistinguishable from "not indexed" and reads as an outage',
      );
    } else failed(`malformed token path → ${shape.status} ${shape.body?.code ?? ''} (expected 400 invalid_request)`);

    // (b) no such route on this node at all
    const unknown = await readJson('/abx-conformance-no-such-route');
    if (unknown.status === 404 && unknown.body?.code === 'unknown_route') pass('unknown path → 404 unknown_route');
    else if (unknown.status === 404) failed(`unknown path → 404 with code ${JSON.stringify(unknown.body?.code ?? null)} (expected "unknown_route")`);
    else if (!unknown.networkError) note(`unknown path → ${unknown.status} (expected 404 unknown_route)`);

    // (c) well-formed, right chain, contract not indexed here — the ONLY one of the three that is
    //     about the project. Skipped when --address names a contract the service may actually serve.
    if (!opts.address) {
      const missing = await readJson(`/c/${chainForProbe}/${probeAddr}`);
      if (missing.status === 404 && missing.body?.code === 'not_registered') pass('well-formed path, unindexed contract → 404 not_registered');
      else if (missing.status === 404) failed(`unindexed contract → 404 with code ${JSON.stringify(missing.body?.code ?? null)} (expected "not_registered")`);
      else if (!missing.networkError) note(`unindexed contract probe → ${missing.status} (expected 404 not_registered)`);
    }

    // (d) a chain this node doesn't serve — a request error, and the body says what IS served.
    const wrongChain = await readJson(`/t/999999999/${probeAddr}/0`);
    if (wrongChain.body?.code === 'unsupported_chain') {
      pass(`wrong chain → ${wrongChain.status} unsupported_chain`);
      Array.isArray(wrongChain.body?.chains)
        ? pass(`  …and carries the chains it does serve: ${wrongChain.body?.chains?.join(', ')}`)
        : note('  the unsupported_chain body omits `chains` — SHOULD carry the chain ids this node serves');
    } else if (!wrongChain.networkError) {
      failed(`wrong chain → ${wrongChain.status} ${JSON.stringify(wrongChain.body?.code ?? null)} (expected code "unsupported_chain")`);
    }
  }

  // ── tier 0: a declared interface means EVERY route it names answers ────────────
  // The interface ids are all-or-nothing. One provider declared `abx-token-api/v1` while `/verify`
  // had never been implemented, and nothing on either side caught it: the route answered a bare 404,
  // which reads to a client as "this service is broken". Omitting an interface is the honest way to
  // express partial support — declaring one and serving a subset is not.
  //
  // The assertion is deliberately narrow: a declared route may legitimately answer 404 `not_registered`
  // (nothing indexed there) or 400 `invalid_request`. What it must NOT answer is `unknown_route` or a
  // code-less 404 — those say the route itself doesn't exist.
  if (descriptor?.interfaces?.includes(TOKEN_API_INTERFACE)) {
    const routes: Array<[string, string]> = [
      [`/t/${chainForProbe}/${probeAddr}/0`, 'token metadata'],
      [`/t/${chainForProbe}/${probeAddr}/0/image`, 'token image'],
      [`/c/${chainForProbe}/${probeAddr}`, 'collection metadata'],
      [`/api/project/${chainForProbe}/${probeAddr}`, 'project state'],
      [`/api/project/${chainForProbe}/${probeAddr}/verify`, 'verify'],
    ];
    for (const [path, what] of routes) {
      const r = await readJson(path);
      if (r.networkError) {
        failed(`${what} (${path}) unreachable: ${r.networkError.message}`);
        continue;
      }
      // A `410 burned` is conformant, not a miss: the route exists and answered honestly about a
      // destroyed token (`remote-services.md` → the read-miss table). Only a 404 that says the ROUTE
      // is unknown fails here.
      if (r.status === 404 && (r.body?.code === 'unknown_route' || r.body?.code === undefined)) {
        failed(
          `${what} (${path}) → 404 ${r.body?.code ?? '(no code)'} — but this service declares ${TOKEN_API_INTERFACE}, ` +
            `which names that route. Implement it, or stop declaring the interface.`,
        );
      } else pass(`${what} route exists (${r.status}${r.body?.code ? ` ${r.body.code}` : ''})`);
    }
  }

  // ── tier 1: an authed token ───────────────────────────────────────────────────
  if (!opts.token) {
    note('no token — skipping the authed tiers');
    return {baseUrl: base, assertions, failures: assertions.filter((a) => a.status === 'fail').length};
  }

  const authed = new AbxServiceClient({baseUrl: base, token: opts.token});
  // A rejected credential makes the authed tiers UNASSESSABLE — it does not make the service
  // non-conformant. Before this was tracked, one stale key produced four confident "this service
  // accepts bytes it must refuse / is becoming an object store" failures, because every probe below
  // 401s and a 401 is not the 400 they assert on. That reads as an indictment of the operator, it is
  // the exact opposite of the guarantee this command exists to give (conformance is checkable from
  // OUTSIDE, before you sign up), and it left an agent choosing between believing five ✗ marks and
  // rationalizing them away. So: record the one true failure, then stop asking questions this
  // credential cannot answer.
  let tokenRejected = false;
  try {
    const projects = await authed.listProjects();
    pass(`GET /v1/projects with the token → ${projects.length} project(s) visible`);
  } catch (err) {
    if (err instanceof AbxServiceError && err.status === 401) {
      tokenRejected = true;
      failed('the provided token was rejected (401)');
    } else failed(`GET /v1/projects failed: ${(err as Error).message}`);
  }
  if (tokenRejected) {
    note(
      'skipping the authed tiers — they cannot be assessed with a rejected credential, and a 401 ' +
        'from every probe would look like a conformance failure of the SERVICE rather than of this key. ' +
        `Get a working key${descriptor?.auth?.signupUrl ? ` (provider recovery: ${descriptor.auth.signupUrl})` : ''} and re-run.`,
    );
    return {baseUrl: base, assertions, failures: assertions.filter((a) => a.status === 'fail').length};
  }

  // ── tier 1: the artifact registry is a POINTER registry ─────────────────────
  // `site/content/docs/protocol/effects.mdx → Bound vs referenced`. Which form is legal is fixed by the output's
  // binding, and BOTH mismatches must be refused: silently accepting media bytes makes every
  // conforming resolver an object store, and silently accepting a locator for `traits` records
  // something that can never stitch — a wrong answer served confidently. These probes are all
  // refusals, so a conformant service stores nothing as a result of them.
  if (descriptor?.interfaces?.includes(CONTROL_PLANE_INTERFACE)) {
    const publish = async (body: Record<string, unknown>): Promise<ProbeResult> => {
      try {
        const res = await fetch(base + '/v1/effect-artifacts', {
          method: 'POST',
          headers: {authorization: `Bearer ${opts.token}`, 'content-type': 'application/json'},
          body: JSON.stringify({chainId: chainForProbe, address: probeAddr, tokenId: '0', inputsHash: '0x' + 'ab'.repeat(32), ...body}),
        });
        return {status: res.status, body: (await res.json().catch(() => ({}))) as ProbeResult['body']};
      } catch (err) {
        return {networkError: err as Error};
      }
    };
    const refuses = async (label: string, body: Record<string, unknown>) => {
      const r = await publish(body);
      if (r.networkError) return failed(`${label}: unreachable (${r.networkError.message})`);
      if (r.status === 401) return note(`${label}: 401 — this token was rejected, so the probe says nothing about the service (fix the key, then re-run)`);
      if (r.status === 403) return note(`${label}: 403 — this token isn't authorized to write artifacts (provider scoping, not a failure)`);
      if (r.status === 400) return pass(`${label} → 400 ${r.body?.code ?? ''}`);
      if (r.status === 404 && r.body?.code === 'unknown_route') {
        return failed(`${label}: the artifact-registry route is missing, but this service declares ${CONTROL_PLANE_INTERFACE} (the routes ride it — there is no separate publish interface)`);
      }
      failed(`${label} → ${r.status} ${r.body?.code ?? ''} (expected 400; accepting this is how a resolver becomes an object store / serves traits that never stitch)`);
    };
    await refuses('bytes for a REFERENCED output (image)', {output: 'image', contentType: 'image/png', bytes_base64: Buffer.from([1, 2, 3]).toString('base64')});
    await refuses('a locator for a BOUND output (traits)', {output: 'traits', locator: 'ipfs://cid-conformance'});
    await refuses('bound content over the 64KB cap', {output: 'traits', bytes_base64: Buffer.alloc(64 * 1024 + 1, 0x41).toString('base64')});
    await refuses('a locator only the producer could resolve', {output: 'image', locator: 'http://localhost:8080/x.png'});
  }

  // ── tier 2: the full register → status → reindex → deregister loop ──────────
  if (!opts.address) {
    note('no address — skipping the register loop (point it at a contract you own on the served chain)');
  } else if (opts.chainId === undefined) {
    note('address given without a chainId — skipping the register loop');
  } else {
    const chainId = opts.chainId;
    const address = opts.address;
    try {
      const reg = await authed.registerProject({chainId, address, ...(opts.fromBlock ? {fromBlock: opts.fromBlock} : {})});
      // Either register shape is conformant: 200 with the completed summary, or 202 + a lifecycle
      // state with catch-up deferred. The SDK normalizes the HTTP status into `accepted`.
      if (reg.accepted) {
        LIFECYCLE.includes(reg.project?.status)
          ? pass(`register → 202 accepted (${reg.project.status}) — catch-up deferred`)
          : failed(`register → 202 but project.status is ${JSON.stringify(reg.project?.status)} (must be one of ${LIFECYCLE.join(' | ')})`);
      } else {
        reg.ok && (reg.mode === 'full' || reg.mode === 'incremental')
          ? pass(`register → 200 ok (${reg.mode}, ${reg.project?.eventCount ?? '?'} events)`)
          : failed(`register response missing ok/mode: ${JSON.stringify(reg)}`);
      }

      // DURABLE FIRST: whichever shape answered, the registration must be visible IMMEDIATELY — it
      // is persisted before catch-up, so a slow/failing chain RPC can never lose the add.
      const listed = await authed.listProjects();
      listed.some((p) => p.address?.toLowerCase() === address.toLowerCase())
        ? pass('registration is visible on the list right after register (durable before catch-up)')
        : failed('the project is NOT on GET /v1/projects right after register — the registration must be persisted before catch-up');

      let status = await authed.projectStatus(chainId, address);
      status.fromBlock !== undefined && 'toBlock' in status
        ? pass(`status → fromBlock ${status.fromBlock}, toBlock ${status.toBlock}`)
        : failed(`status response missing fromBlock/toBlock: ${JSON.stringify(status)}`);
      LIFECYCLE.includes(status.status)
        ? pass(`status → lifecycle '${status.status}'`)
        : failed(`status.status is ${JSON.stringify(status.status)} (must be one of ${LIFECYCLE.join(' | ')})`);
      if (!('headBlock' in status)) failed('status is missing headBlock — a client cannot compute lag / % complete without it');
      else if (status.headBlock) pass(`status → headBlock ${status.headBlock} (lag is computable)`);
      else note('status.headBlock is null — the field is there, but this service is not reporting head, so a client cannot show % complete');

      // Poll to a terminal state, exactly as the CLI does. A service that defers catch-up must
      // eventually reach `live` with nobody prompting it.
      if (status.status !== 'live' && status.status !== 'failed') {
        note(`'${status.status}' — polling to a terminal state…`);
        try {
          status = await authed.awaitIndexed(chainId, address, {
            timeoutMs: opts.awaitTimeoutMs ?? 120_000,
            intervalMs: opts.awaitIntervalMs ?? 2_000,
          });
        } catch (err) {
          failed(`never reached a terminal status: ${(err as Error).message}`);
        }
      }
      status.status === 'live'
        ? pass(`caught up → live (${status.eventCount} events, ${status.tokenCount} token(s))`)
        : status.status === 'failed'
          ? failed(`catch-up reported failed${status.error ? ` (${status.error.class})` : ''} — point address at a contract this service can replay`)
          : note(`still '${status.status}' — not a conformance failure, but slower than this fixture waits`);
      if (status.error && !['rpc_unavailable', 'rpc_rate_limited', 'not_abx_contract', 'internal'].includes(status.error.class)) {
        failed(`error.class is ${JSON.stringify(status.error.class)} — must be one of the closed set`);
      }
      if (status.error?.message && /https?:\/\//.test(status.error.message)) {
        failed('error.message contains a URL — it must be credential-free (a keyed RPC URL is a secret)');
      }

      // The accept path, on a project the service now actually serves: a referenced output's locator
      // is recorded and served by REDIRECT — never proxied, so the producer's egress stays its own.
      try {
        const key = (
          await authed.publishEffectArtifact({
            chainId,
            address,
            tokenId: '0',
            inputsHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
            output: 'image',
            contentType: 'image/png',
            locator: 'https://conformance.invalid/still.png',
          })
        ).key;
        pass(`artifact registry accepted a referenced locator (key ${String(key).slice(0, 10)}…)`);
        try {
          const served = await fetch(`${base}/t/${chainId}/${address}/0/data/render/image`, {redirect: 'manual'});
          if (served.status === 302 || served.status === 301) pass('  …and the read plane 302-redirects to it (no proxying)');
          else if (served.status === 404) note("  the artifact route 404s — the row addresses a different inputsHash than this token's current one (self-invalidation working as designed)");
          else failed(`  the artifact route answered ${served.status} — a registered locator MUST be served by redirect, never proxied`);
        } catch (err) {
          note(`could not probe the artifact read route: ${(err as Error).message}`);
        }
      } catch (err) {
        if (scoped(err)) note("403 on artifact publish — the token isn't authorized to write artifacts (provider scoping)");
        else failed(`publishing a referenced locator failed: ${(err as Error).message}`);
      }

      const re = await authed.reindexProject(chainId, address);
      re.ok ? pass(`reindex → ok (${re.accepted ? `202 ${re.project.status}` : re.mode})`) : failed(`reindex response missing ok: ${JSON.stringify(re)}`);

      const {removed} = await authed.removeProject(chainId, address);
      removed ? pass('deregister → removed') : failed('deregister reported not_registered for a project just registered');
      const second = await authed.removeProject(chainId, address);
      !second.removed ? pass('second deregister → not_registered (idempotent to retry)') : failed('second deregister claimed to remove again');
    } catch (err) {
      if (scoped(err)) note(`403 during the loop — the token isn't authorized for ${address} (provider scoping; not a conformance failure)`);
      else failed(`register loop failed: ${(err as Error).message}`);
    }
  }

  return {baseUrl: base, assertions, failures: assertions.filter((a) => a.status === 'fail').length};
}
