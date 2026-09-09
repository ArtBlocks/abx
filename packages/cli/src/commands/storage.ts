/**
 * `abx storage` — stateless byte-custody commands: show the resolved-effective config, check
 * whether a locator is actually retrievable yet (not just accepted), upload one file and print
 * its locator, and Turbo (arweave) balance/topup. See `abx storage --help` for the sub-commands.
 */
import {copyFileSync, existsSync, readFileSync, statSync} from 'node:fs';
import {basename, resolve as resolvePath} from 'node:path';
import {contentIdFromLocator, makeWalletClient} from '@artblocks/abx-sdk';
import {
  arweaveAddress,
  arweaveFunding,
  contentTypeFromPath,
  locatorStatus,
  probeStorageBackend,
  resolveBackend,
  turboBalanceForAddress,
  uploadAndLocate,
} from '@artblocks/abx-storage';
import {
  CHAIN,
  arweaveKeyFilePath,
  backendResolution,
  ensureArweaveIdentityForUpload,
  loadArweaveJwk,
  noteArweavePlan,
  storageOptions,
  storageOverrides,
} from '../config.js';
import {type Flags, isDryRun, parseFlags, warnStrayFlags} from '../flags.js';
import {bold, c, dim, g, info, ok, warn} from '../output.js';

// ── storage ────────────────────────────────────────────────────────────────--
// Storage is STATELESS — there's no config file. A backend is chosen per command via flags
// (`--backend …`) or declared in .env (ABX_STORAGE_BACKEND, …); secrets are env-only. `show`
// prints the resolved-effective config with provenance so there's never a hidden choice.
/**
 * `abx storage backup-key [--out <path>]` — back up the managed Turbo/Arweave key. It signs uploads
 * AND holds prepaid credits, so losing it strands the credits. Low-stakes (a few $ of credit), but
 * we still COPY the file rather than print it — a key pasted into a terminal / agent log is leaked.
 * With no `--out`, just report where it lives and how to back it up.
 */
export async function cmdStorageBackupKey(flags: Flags) {
  const src = arweaveKeyFilePath();
  if (process.env.ARWEAVE_JWK) {
    info('Turbo identity comes from ARWEAVE_JWK (env), not a managed file — back up that env value yourself.');
    return;
  }
  if (!existsSync(src)) {
    throw new Error(`no managed Arweave key yet at ${src} — it's created on your first Turbo upload (or set ARWEAVE_JWK / ABX_ARWEAVE_KEY_FILE to bring your own). Nothing to back up.`);
  }
  if (!flags.out) {
    const jwk = loadArweaveJwk();
    ok('Turbo/Arweave key — your storage credential');
    if (jwk) info(`  address ${g(arweaveAddress(jwk))} ${dim('(holds your prepaid upload credits)')}`);
    info(`  file    ${src}`);
    info(`  Back it up: ${bold('abx storage backup-key --out <path>')} ${dim('(copies the file; the key is never printed)')}`);
    info(`  ${dim('Low-stakes — only a few $ of upload credit — but lose it and those credits are stranded.')}`);
    return;
  }
  const dest = resolvePath(flags.out);
  if (existsSync(dest)) throw new Error(`refusing to overwrite ${dest} — choose a new path for the backup.`);
  copyFileSync(src, dest);
  ok(`backed up your Turbo/Arweave key → ${dest}`);
  info(`  ${dim(`Keep it private — it signs uploads + holds credits. Restore by setting ABX_ARWEAVE_KEY_FILE to it, or copying it back to ${src}.`)}`);
}

export async function cmdStorage(rest: string[]) {
  const [sub, ...args] = rest;
  const flags = parseFlags(args);

  if (sub === 'set') {
    throw new Error(
      '`abx storage set` was removed — storage is now stateless (no config file). Choose a backend per command with ' +
        'flags (e.g. `abx deploy --backend ipfs --gateway https://…`), or declare defaults in .env ' +
        '(ABX_STORAGE_BACKEND, ABX_IPFS_GATEWAY, ABX_S3_BUCKET, ABX_ARWEAVE_PROVIDER, …). See `abx storage show`.',
    );
  }

  if (sub === 'balance' || sub === 'topup') {
    return cmdStorageFunding(sub, flags);
  }

  if (sub === 'upload') {
    return cmdStorageUpload(args[0], flags);
  }

  if (sub === 'backup-key') {
    return cmdStorageBackupKey(flags);
  }

  if (sub === 'status') {
    return cmdStorageStatus(args[0], flags);
  }

  // show (default) — the RESOLVED effective config + where each value came from. No persisted state.
  //
  // Per-command flags are honored here, exactly as `upload`/`status`/`balance` honor them. This used to
  // read env-only, so `abx storage show --backend ipfs --gateway <url>` reported `backend: fs` while its
  // OWN output said "choose per command: --backend … --gateway …" — advertising flags it then discarded.
  // That was invisible until every command grew an unknown-flag notice, which correctly called it out
  // (the flags really were ignored). Showing what a given set of flags WOULD resolve to is the whole
  // point of a resolution preview, and `backendResolution` already reports `source: 'flag'` for it.
  const overrides = storageOverrides(flags);
  const {backend, source} = backendResolution(overrides);
  const opts = storageOptions(overrides);
  const prov = (v: string | undefined, env: string, dflt: string) =>
    process.env[env] ? `${v} ${dim('(env ' + env + ')')}` : `${v ?? dflt} ${dim('(default)')}`;
  console.log(bold('\n  storage') + dim('  — resolved per-invocation; no config file, secrets in .env'));
  console.log(`    backend: ${g(backend)} ${dim('(' + (source === 'flag' ? '--backend' : source === 'env' ? 'env ABX_STORAGE_BACKEND' : 'default') + ')')}`);
  if (opts.cloud)
    info(`cloud: endpoint=${prov(opts.cloud.endpoint, 'ABX_S3_ENDPOINT', '-')} bucket=${prov(opts.cloud.bucket, 'ABX_S3_BUCKET', '-')} region=${prov(opts.cloud.region, 'ABX_S3_REGION', 'auto')} prefix=${prov(opts.cloud.prefix, 'ABX_S3_PREFIX', 'abx/content/')}`);
  if (opts.ipfs)
    info(`ipfs: mode=${prov(opts.ipfs.mode, 'ABX_IPFS_MODE', 'kubo')} gateway=${prov(opts.ipfs.gateway, 'ABX_IPFS_GATEWAY', '-')} apiUrl=${prov(opts.ipfs.apiUrl, 'ABX_IPFS_API_URL', '-')}`);
  if (opts.arweave) {
    info(`arweave: provider=${prov(opts.arweave.provider, 'ABX_ARWEAVE_PROVIDER', 'turbo')} gateway=${prov(opts.arweave.gateway, 'ABX_ARWEAVE_GATEWAY', 'https://arweave.net')}${opts.arweave.uploadUrl ? ` uploadUrl=${opts.arweave.uploadUrl}` : ''}`);
    if ((opts.arweave.provider ?? 'turbo') === 'turbo') {
      const jwk = loadArweaveJwk();
      if (jwk) info(`  identity ${arweaveAddress(jwk)} ${dim(`(holds upload credits — back up ${arweaveKeyFilePath()})`)}`);
      else info(`  ${dim('identity created on first upload; free under 100 KB. `abx storage balance` to view credits')}`);
    }
  }
  console.log(dim('\n    choose per command: --backend <fs|cloud|ipfs|arweave> [--gateway/--bucket/--region/…]  ·  or declare in .env'));
  console.log(dim('    secrets from env only: ABX_S3_ACCESS_KEY_ID · ABX_S3_SECRET_ACCESS_KEY · PINATA_JWT · ARWEAVE_UPLOAD_TOKEN · ARWEAVE_JWK'));

  // --check goes beyond "is this CONFIGURED" to "does a write actually reach the URL a token
  // would bake on-chain." cloud gets a real PUT (API) + GET (public base) round trip — the only
  // check that catches the R2/S3 endpoint-vs-public-base trap; ipfs/fs reuse their own health()
  // (gateway/API reachability, dir writability — no upload); arweave adds a balance READ, never a
  // paid upload. Exit code is meaningful: 0 ok, 1 any ✗ — so a script can gate a launch on this.
  if (flags.check !== undefined) {
    console.log(dim('\n    checking — a real read/write against the resolved config (no paid upload, no ipfs pin)…'));
    try {
      const result = await probeStorageBackend(opts);
      if (result.ok) {
        ok(`${result.backend}: ${result.detail}`);
      } else {
        warn(`${result.backend}: ${result.detail}`);
        if (result.putUrl) info(`  put  ${result.putUrl}`);
        if (result.publicUrl) info(`  get  ${result.publicUrl}`);
        process.exitCode = 1;
      }
    } catch (err) {
      warn(`${backend}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log('');
}

/**
 * `abx storage status <locator>` — is it **retrievable** yet, not just accepted?
 *
 * The gap this closes: an upload service answers "accepted" the moment it holds your bytes, a gateway
 * answers "serving" only once they reach it, and on Arweave that runs to minutes. Two independent
 * integrators built their own version of this check eight days apart; the second saw 32/32 renders
 * 404 on `arweave.net` while 22/32 already served elsewhere and the uploader said `CONFIRMED`. The
 * expensive part is what a creator does next: a placeholder on a fresh drop reads as a failed render,
 * so you re-run `abx render --force` and re-upload everything for nothing.
 */
export const STORAGE_STATUS_FLAGS = new Set<string>(['json', 'gateway', 'backend', 'primary-only', 'timeout']);

export async function cmdStorageStatus(locator: string | undefined, flags: Flags) {
  if (!locator || locator.startsWith('--')) {
    console.error(
      'usage: abx storage status <locator> [--json] [--gateway <url>] [--primary-only]\n' +
        '  <locator> — ar://<txid> · ipfs://<cid> · an https:// gateway URL · or a bare txid/CID\n',
    );
    process.exitCode = 1;
    return;
  }
  warnStrayFlags(flags, STORAGE_STATUS_FLAGS, 'storage status');
  const jsonMode = flags.json !== undefined;
  // The gateway that matters is the one a baked locator resolves through, so default to the active
  // backend's configured gateway rather than a hardcoded host — otherwise the verdict is about a
  // gateway this project will never use.
  const opts = storageOptions(storageOverrides(flags));
  const configured =
    (flags.gateway as string | undefined) ?? opts.arweave?.gateway ?? opts.ipfs?.gateway ?? undefined;

  const status = await locatorStatus(locator, {
    gateway: configured,
    primaryOnly: flags['primary-only'] !== undefined,
    timeoutMs: flags.timeout === undefined ? undefined : Number(flags.timeout),
  });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    // A program's whole reason to call this is to gate on it, so the verdict is also the exit code:
    // 0 = ready, 1 = not yet. `until abx storage status <loc> --json; do sleep 10; done` just works.
    if (status.readiness !== 'ready') process.exitCode = 1;
    return;
  }

  const probeLine = (p: typeof status.primary, label: string) => {
    const verdict = p.serving
      ? `${g('serving')}`
      : p.status !== null
        ? `${c.orange}${p.status}${c.reset}`
        : `${c.orange}no response${c.reset}`;
    const size = p.bytes !== null ? dim(` · ${p.bytes < 1024 ? `${p.bytes} B` : `${(p.bytes / 1024).toFixed(1)} KB`}`) : '';
    const type = p.contentType ? dim(` · ${p.contentType.split(';')[0]}`) : '';
    const why = p.error ? dim(` · ${p.error}`) : '';
    console.log(`    ${label} ${bold(p.gateway)} → ${verdict}${size}${type} ${dim(`${p.ms}ms`)}${why}`);
  };

  console.log(`\n  ${bold('storage status')} ${dim(`— ${status.network} · ${status.id.length > 60 ? status.id.slice(0, 60) + '…' : status.id}`)}`);
  probeLine(status.primary, dim('your gateway '));
  for (const a of status.alternates) probeLine(a, dim('also         '));

  console.log('');
  if (status.readiness === 'ready') {
    ok(`${bold('ready')} — your gateway serves these bytes. Safe to reference in a token.`);
  } else if (status.readiness === 'propagating') {
    const where = status.alternates.filter((a) => a.serving).map((a) => a.gateway).join(', ');
    warn(
      `${bold('propagating')} — the data is provably on the network (${where} serves it) but ${bold(status.primary.gateway)} hasn't caught up.`,
    );
    info('Waiting is the fix. Do NOT re-render or re-upload — the bytes are already stored, and a second upload just pays twice.');
    if (status.network === 'arweave') {
      info(`To serve sooner from a gateway that already has it, set ${bold('ABX_ARWEAVE_GATEWAY')} before the upload that bakes the locator ${dim('(it cannot be repaired afterwards — the gateway is part of the stored value).')}`);
    }
  } else {
    // Never call this "propagating": from outside, a settling locator and a wrong one look the same.
    warn(`${bold('not retrievable')} — no gateway probed is serving it.`);
    // One exception worth reading the statuses for. Gateways answer 404 for "I don't have these
    // bytes" (settling and wrong are identical there) but 400 for "that isn't a valid id at all".
    // Every probe agreeing on a non-404 client error is real evidence, and it matters because the
    // inverse mistake — waiting out a typo — costs more than a needless re-upload.
    const probes = [status.primary, ...status.alternates];
    const answered = probes.filter((p) => p.status !== null);
    const allInvalid = answered.length > 0 && answered.every((p) => p.status! >= 400 && p.status! < 500 && p.status !== 404);
    if (allInvalid) {
      info(`every gateway rejected the id itself (${answered.map((p) => p.status).join(', ')}), not merely "don't have it" — so this is very likely a ${bold('malformed locator')} (truncated txid/CID, or a stray character), not propagation. Re-check the value you stored; waiting will not fix it.`);
    } else {
      info('Two causes, and this check cannot tell them apart: it is still settling (wait and re-run — minutes on Arweave), or the locator is wrong (a truncated txid/CID, or the upload never completed).');
    }
  }
  console.log(`\n  ${dim('gate a script on this:')} ${bold(`abx storage status ${locator} --json`)} ${dim('(exit 0 only when ready)')}\n`);
  if (status.readiness !== 'ready') process.exitCode = 1;
}

/**
 * `abx storage upload <path> [--backend ipfs|arweave|cloud]` — upload one file to a durable
 * backend and print the **locator** to point at. This is the missing first half of the data-plane
 * attach flow (`abx attach` takes a URI it assumes you already have): it hands you an `ipfs://` /
 * `ar://` (content-addressed) or `<publicBase>/<key>` (cloud) URI, then prints the ready-to-run
 * `abx attach` line. Reuses the exact upload path a deploy uses (resolve backend → put → locator),
 * so the locator is identical to what a deploy would bridge.
 */
export async function cmdStorageUpload(path: string | undefined, flags: Flags) {
  if (!path || path.startsWith('--')) {
    console.error('usage: abx storage upload <path> [--backend ipfs|arweave|cloud] [--key <name>] [--json]\n  uploads one file and prints its locator (the URI `abx attach` wants); --json emits it as data.\n');
    process.exitCode = 1;
    return;
  }
  const abs = resolvePath(path);
  // Stat BEFORE reading — a raw `readFileSync` on a missing path or a directory throws a bare
  // Node errno (ENOENT / "EISDIR: illegal operation on a directory, read") that names neither the
  // mistake nor the fix. This command uploads exactly one file (it exists to hand `abx attach` a
  // locator for one asset); a directory has no locator to return, so name that up front instead of
  // crashing partway through. Directory content is NOT pre-uploaded by this command at all — it is
  // uploaded by the deploy commands themselves as part of building the collection (`abx deploy-series
  // --dir <folder>` for a media Series, `abx deploy-code --code-dir <folder>` for a code/generator
  // build), so there is no standalone "upload this folder" step to point at.
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new Error(`no file at ${abs} — check the path (abx storage upload <path>).`);
  }
  if (stat.isDirectory()) {
    throw new Error(
      `${abs} is a directory — \`abx storage upload\` takes a single FILE and hands back a locator for it. ` +
        'A folder of media is uploaded by the deploy command that builds the collection, not as a separate ' +
        'pre-upload step: `abx deploy-series --dir <folder> …` (a multi-token image Series) or ' +
        '`abx deploy-code --code-dir <folder> …` (a code/generator build). If you want a locator for one file ' +
        'in this folder, pass that file\'s path instead.',
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(abs));
  } catch (err) {
    // e.g. EACCES on an unreadable file — same treatment: name the file and the fix, not the errno.
    throw new Error(`can't read ${abs}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message} — check its permissions.`);
  }
  const contentType = contentTypeFromPath(abs);
  const opts = storageOptions(storageOverrides(flags));
  const backend = resolveBackend(opts);
  if (backend.id === 'fs') {
    throw new Error(
      "the 'fs' backend has no public URL — an attached file must be reachable off this machine. " +
        'Upload with `--backend arweave` (pay-once permanent) or `--backend ipfs` (keep it pinned), or `--backend cloud` (your S3/R2).',
    );
  }
  const jsonMode = flags.json !== undefined;
  if (!jsonMode) noteArweavePlan(opts, bytes.length); // free-vs-credit readout for the arweave lane
  const name = (flags.key && flags.key !== 'true' ? flags.key : basename(abs)).replace(/^\/+/, '');

  // --dry-run: an upload is IRREVERSIBLE and can happen even keyless (Arweave's free tier under
  // 100 KB auto-creates an identity), so a "preview" that actually uploaded would surprise. Show
  // the plan (backend, size, declared type, locator shape) and upload nothing.
  if (isDryRun(flags)) {
    const shape = backend.publicBase ? `${backend.publicBase.replace(/\/+$/, '')}/${name}` : `<${backend.id}-gateway>/<root>/${name}`;
    console.log(`\n  ${bold('◆ storage upload')} ${dim('(dry run — nothing uploaded)')}`);
    console.log(`    ${dim('file'.padEnd(10))} ${basename(abs)} ${dim(`(${bytes.length} bytes, ${contentType})`)}`);
    console.log(`    ${dim('backend'.padEnd(10))} ${backend.id}`);
    // Name the IPFS mode, and say what an absent credential actually means. There is no silent
    // fallback to local `fs` (an earlier skill line wrongly claimed one) — without PINATA_JWT the
    // backend resolves to kubo against a LOCAL node, so a dry run that looked fine would fail at
    // upload for anyone not running one. A preview should surface that, not defer it to the failure.
    if (backend.id === 'ipfs' && !process.env.PINATA_JWT && !process.env.ABX_IPFS_MODE) {
      warn(`no ${bold('PINATA_JWT')} set → this resolves to a LOCAL IPFS node (kubo at ${process.env.ABX_IPFS_API_URL ?? 'http://127.0.0.1:5001'}). The real upload fails unless that node is running — set PINATA_JWT for the managed lane, or ${bold('--backend arweave')} for no-setup permanent storage.`);
    }
    console.log(`    ${dim('locator'.padEnd(10))} ${shape} ${dim('(filename preserved → declared type survives)')}`);
    const shapeForAttach =
      backend.id === 'ipfs' ? `ipfs://<cid>/${name}` : backend.id === 'arweave' ? `ar://<txid>/${name}` : shape;
    console.log(dim(`\n  Re-run without --dry-run to upload, then: `) + `${g(`abx attach <address> <key> ${shapeForAttach}`)}\n`);
    return;
  }
  // In --json mode nothing but the JSON may touch stdout; progress still goes out, on stderr.
  const progress = (line: string) => (jsonMode ? process.stderr.write(line + '\n') : console.log(line));
  progress(`  uploading ${bold(basename(abs))} ${dim(`(${bytes.length} bytes, ${contentType})`)} to '${backend.id}' …`);

  // The returned locator MUST carry the filename so the declared mimeType survives when attached
  // (the on-chain field has no MIME slot — the URL extension IS the declaration). uploadAndLocate
  // encapsulates the capability-based branch (cloud key / dir-wrap / bare fallback).
  const {locator, filenamePreserved, fallbackReason} = await uploadAndLocate(backend, name, {bytes, contentType});
  if (!filenamePreserved && fallbackReason) {
    const msg = `couldn't wrap the file with its name (${fallbackReason}) — the locator has no extension, so its declared type will be application/octet-stream when attached.`;
    if (jsonMode) process.stderr.write(`    ⚠  ${msg}\n`);
    else warn(msg);
  }

  // --json: the locator as data, not as prose. An integrator scraped this line, captured the ANSI
  // colour codes along with the URL, wrote the result into a STORED player URL, and only found out
  // when it 404'd in production. A value a program needs must be obtainable without parsing output.
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({locator, attachLocator: attachLocator(backend.id, locator), backend: backend.id, name, bytes: bytes.length, contentType, filenamePreserved}) + '\n',
    );
    return;
  }
  const forAttach = attachLocator(backend.id, locator);
  console.log(`  ${g('✓')} uploaded → ${bold(locator)}`);
  if (contentType === 'application/octet-stream') {
    warn(`no known extension on ${basename(abs)} → its declared type will be application/octet-stream when attached.`);
  }
  console.log(dim('\n  attach it to a token (pick any key):\n') + `    ${g(`abx attach <address> <key> ${forAttach}`)}\n`);
  if (forAttach !== locator) {
    console.log(
      dim(`  ${bold(forAttach)} — not the https URL above — is what attach wants: it stores the bare id, so a\n`) +
        dim(`  gateway change is later one ${bold('abx set-gateway')} tx instead of a re-attach.\n`),
    );
  }
}

/**
 * The locator `abx attach` should be handed for an uploaded file.
 *
 * The backends return an UPLOAD-gateway https URL, because that is the production-safe form an NFT
 * `image` needs. `attach` reads the scheme to pick the on-chain representation, so handing it that
 * https URL stores the attachment as a plain `url` — the gateway host welded into the value, no
 * `set-gateway` repoint, exactly the coupling the ipfs/arweave representations exist to avoid. An
 * agent followed this command's own printed next step and silently downgraded the attachment.
 *
 * So for the two content-addressed backends we hand back the scheme form (`ipfs://<cid>/<name>`,
 * `ar://<txid>/<name>`) and keep the https URL as the browsable one. `cloud` is unchanged: an https
 * CDN locator IS its address, with no identity underneath to separate out.
 */
export function attachLocator(backendId: string, locator: string): string {
  if (backendId !== 'ipfs' && backendId !== 'arweave') return locator;
  const contentId = contentIdFromLocator(backendId, locator);
  if (!contentId) return locator;
  return `${backendId === 'ipfs' ? 'ipfs' : 'ar'}://${contentId}`;
}

/**
 * `abx storage balance` / `abx storage topup --usd <n>` — dispatch to the active provider's
 * funding capability. Generic verbs, provider chosen in config: Turbo exposes prepaid credits;
 * a provider without funding (http-bundler) gets a clear "fund the wallet directly" instead.
 */
export async function cmdStorageFunding(sub: 'balance' | 'topup', flags: Flags) {
  const opts = storageOptions(storageOverrides(flags));
  if (opts.backend !== 'arweave') {
    throw new Error(`\`abx storage ${sub}\` applies to the arweave backend; the active backend is '${opts.backend}'. Re-run with \`--backend arweave\` (e.g. \`abx storage ${sub} --backend arweave\`), or set \`ABX_STORAGE_BACKEND=arweave\` in .env.`);
  }
  ensureArweaveIdentityForUpload(opts); // so there's an address to fund / read
  const funding = await arweaveFunding(opts.arweave!); // throws a clear reason if the provider has no balance
  const address = await funding.address();
  // The active identity determines what the address IS + how to read the fund note.
  const isEthLane = !!(opts.arweave?.ethSignerKey || opts.arweave?.remoteEth);
  const identityNote = isEthLane
    ? 'This is your Ethereum wallet acting as a Turbo identity (--storage-signer eth) — credits attach to this address.'
    : `This is your Turbo/Arweave key (${arweaveKeyFilePath()}), NOT your Ethereum wallet — credits attach to THIS key.`;

  if (sub === 'balance') {
    const {credits, winc} = await funding.balance();
    ok(`Turbo balance for ${g(address)}`);
    info(`  ${bold(credits)} credits ${dim(`(${winc} winc)`)}`);
    info(`  ${dim(identityNote)}`);
    // On the managed-key lane, ALSO show the creator's ETH wallet's Turbo balance (queryable by
    // address, no key) so "use my wallet's credits" is visible without a failed upload first.
    if (!isEthLane) {
      let wallet = flags.for as string | undefined;
      if (!wallet) try { wallet = makeWalletClient({chainKey: CHAIN}).account.address; } catch { /* no key */ }
      const wb = wallet ? await turboBalanceForAddress(wallet, 'ethereum') : null;
      if (wb && Number(wb.winc) > 0) {
        info(`  ${dim('↳ your ETH wallet')} ${g(wallet!)} ${dim('holds')} ${bold(wb.credits)} ${dim('Turbo credits — spend those with')} ${bold('--storage-signer eth')} ${dim('(no top-up needed).')}`);
      } else if (wallet) {
        info(`  ${dim(`↳ your ETH wallet ${wallet} has no Turbo credits either. (Pass --for <addr> to check a different wallet.)`)}`);
      }
    }
    info('  Under 100 KB always uploads free; credits cover larger files. One-time cost — no recurring fee.');
    return;
  }

  // topup
  const usd = Number(flags.usd);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error('top-up needs a positive --usd amount, e.g. `abx storage topup --usd 10`.');
  }
  const {url} = await funding.topup({usd});
  ok(`Turbo top-up: $${usd} → ${g(address)}`);
  info(`  ${dim(`Funds the address above — ${identityNote}`)}`);
  info('  Pay by card (Stripe) at the link below — one-time, funds permanent storage, no recurring fee:');
  console.log(`    ${url}`);
  info(`  ${dim('Link not opening? Fallback: go to')} ${bold('https://turbo-topup.com')} ${dim('and fund this exact address:')}`);
  console.log(`    ${g(address)}`);
  info('  Credits land on the address above and persist for future uploads. Re-check with `abx storage balance`.');
}
