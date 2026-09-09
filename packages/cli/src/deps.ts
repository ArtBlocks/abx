/**
 * The `--dep` flag grammar for `abx deploy-code` — the one CLI-local piece of the dependency
 * lane. Everything downstream of a parsed ref (registry-pointer resolution, setup-multicall leg
 * composition, the selection-time registry check) lives in `@artblocks/abx-sdk`'s `deps.ts`.
 */
import {parseDependencyRef, type ParsedDependencyRef} from '@artblocks/abx-sdk';

/**
 * Parse the accumulated `--dep` flag value (repeats comma-join — see flags.ts — and each
 * value may itself be comma-separated) into ordered refs. Order is load-bearing: the first
 * ref becomes dependency index 0 — the runtime, by convention.
 */
export function parseDepFlag(value: string | undefined): ParsedDependencyRef[] {
  if (value === 'true') throw new Error('--dep needs a ref: name@version (e.g. p5@1.0.0) or 0x… (an on-chain data contract)');
  // `--dep none` (or empty) means ZERO dependencies — the explicit "no libraries" sentinel (a
  // dependency-free vanilla-JS or renderer-only drop). Without this, "none" was parsed as a registry
  // ref literally named "none" → a bogus setDependency leg + a "not found on registry" warning.
  if (value === 'none') return [];
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== 'none')
    .map(parseDependencyRef);
}
