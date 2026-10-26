#!/usr/bin/env node
import {loadDotEnv} from '@artblocks/abx-sdk/node';
import {makePublicClient, readEnv} from '@artblocks/abx-sdk';
import {resolveBackend} from '@artblocks/abx-storage';
import {EffectRunner} from './harness.js';
import {renderEffect} from './render.js';

/**
 * The effect runner entrypoint — the deployed, long-running form (a creator runs this
 * beside their resolver during a drop; `docker compose` or a bare `pnpm abx-effects`).
 *
 * Config (env): ABX_RESOLVER_URL (required) · ABX_RPC_URL (recommended — augment hooks
 * + data-backed params need reads; a comma/whitespace-separated list gets the SDK's
 * fallback-transport failover across endpoints — the same primitive the CLI/indexer use via
 * `resolveRpcUrls` — a single URL behaves exactly as before) · ABX_EFFECTS_PORT (default 8788) ·
 * ABX_EFFECTS_INTERVAL_MS (default 300000 — the SAFETY FLOOR: the resolver's chain watcher
 * `POST /notify` is the primary trigger; the sweep only catches a missed ping / cold start) ·
 * ABX_EFFECTS_CONCURRENCY (default 1 — parallel renders while draining) ·
 * ABX_EFFECTS_TOKEN (gates /run + /notify — REQUIRED on a public runner) ·
 * ABX_ENVIRONMENT_ID (default web:any) ·
 * ABX_RESOLVER_ADMIN_TOKEN (optional — set it in the locator-bridge topology, where this runner
 * does NOT share the resolver's storage disk, so each render is PUBLISHED to the resolver's control
 * plane + run status is REPORTED to /v1/effect-status. Publishing is also what registers each
 * declared output in the resolver's artifact registry — the `artifacts` manifest's enumeration
 * surface — so every deployed runner should set it; the token-less co-located form is the CLI's
 * `abx effects`, which records rows into the shared store directly) ·
 * storage backend env (the custody home this runner uploads renders to).
 *
 * One-shot repair mode (the `abx render` escape hatch rides this):
 *   pnpm abx-effects --once <address> [tokenId…]
 */
const USAGE = `usage: abx-effects                              start the runner (HTTP on ABX_EFFECTS_PORT, default 8788, plus the sweep loop)
       abx-effects --once <address> [tokenId…]  render one project's missing work once and exit
       abx-effects --help | -h                  print this help

Configuration is read from the environment (and .env): ABX_RESOLVER_URL, ABX_RPC_URL, ABX_EFFECTS_PORT,
ABX_EFFECTS_INTERVAL_MS, ABX_EFFECTS_CONCURRENCY, ABX_EFFECTS_TOKEN, ABX_ENVIRONMENT_ID,
ABX_RESOLVER_ADMIN_TOKEN, and the storage backend settings. See https://docs.abx.io.`;

async function main(): Promise<void> {
  // Parse arguments before loading .env or building the runner, so --help and a typo never start
  // a server or touch storage.
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    return;
  }
  if (args.length && args[0] !== '--once') {
    console.error(`abx-effects: unknown argument '${args[0]}'\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  loadDotEnv();
  const resolverUrl = (readEnv('ABX_RESOLVER_URL') ?? 'http://localhost:8787').replace(/\/$/, '');
  // Unset ⇒ no client (this runner tolerates that — only augment hooks + data-backed params need
  // reads). Set ⇒ the SDK's makePublicClient, which gives a viem `fallback` transport across every
  // endpoint when the value holds more than one (comma/whitespace-separated) — a single URL is
  // still just `http(url)`, identical to before. An explicit `rpcUrls` override short-circuits the
  // SDK's own env resolution entirely, so this stays the ONE place ABX_RPC_URL is read.
  const rpcUrl = readEnv('ABX_RPC_URL');
  const client = rpcUrl ? makePublicClient({rpcUrls: rpcUrl.split(/[\s,]+/).filter(Boolean)}) : null;

  const runner = new EffectRunner({
    resolverUrl,
    client,
    storage: resolveBackend(),
    effects: [renderEffect()],
    environmentId: readEnv('ABX_ENVIRONMENT_ID') ?? 'web:any',
    // With a token, publish each render to the resolver's control plane (locator bridge) so a runner
    // that doesn't share the resolver's disk still lands the thumbnail. Omit ⇒ co-located shared store.
    adminToken: readEnv('ABX_RESOLVER_ADMIN_TOKEN'),
    concurrency: Number(readEnv('ABX_EFFECTS_CONCURRENCY') ?? 1),
    authToken: readEnv('ABX_EFFECTS_TOKEN'),
  });

  if (args[0] === '--once') {
    const [address, ...tokenIds] = args.slice(1);
    if (!address) throw new Error('usage: abx-effects --once <address> [tokenId…]');
    const stats = await runner.sweepProject(address, tokenIds.length ? tokenIds : undefined);
    console.log(`[effects] once: ran=${stats.ran} skipped=${stats.skipped} failed=${stats.failed}`);
    return;
  }

  const port = Number(readEnv('ABX_EFFECTS_PORT') ?? 8788);
  // 300s: the sweep is the SAFETY FLOOR (missed ping / cold start / new project), not the trigger —
  // the resolver's chain watcher POSTs /notify the moment settled state changes.
  const intervalMs = Number(readEnv('ABX_EFFECTS_INTERVAL_MS') ?? 300_000);
  runner.startHttp(port);
  runner.startLoop(intervalMs);
  console.log(
    `[effects] runner up — resolver=${resolverUrl} port=${port} sweep=${intervalMs}ms (safety floor) ` +
      `(the resolver's watcher POSTs /notify for immediacy; /run is the synchronous command lane)`,
  );
}

main().catch((err) => {
  console.error(`[effects] fatal: ${(err as Error).message}`);
  process.exit(1);
});
