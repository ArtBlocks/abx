import type {Address, Hex} from 'viem';
import type {SeedSourceProbe, SeedSourceVerdict} from './ops.js';

/**
 * The SDK's error taxonomy — deliberately minimal. A caller that wants to react to a SPECIFIC
 * failure (retry a stale estimate, surface a revert's tx hash) should catch by TYPE, not by
 * parsing `.message`; every SDK-thrown error a caller is expected to distinguish extends this,
 * following the same `name` + typed-fields convention `AbxServiceError` already uses (service.ts).
 * This module stays small on purpose — it grows only when a real caller needs a new type to catch,
 * not as a speculative taxonomy of everything that could go wrong.
 */
export class AbxSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbxSdkError';
  }
}

/**
 * A sent transaction MINED with `status: 'reverted'`. Thrown by {@link makeHotSender} (and anything
 * else driving `SendTx`) instead of letting a revert masquerade as a "confirmed" send — carries the
 * tx hash so a caller can look it up on an explorer without re-parsing a message string.
 */
export class TxRevertedError extends AbxSdkError {
  readonly op: string;
  readonly txHash: Hex;
  constructor(op: string, txHash: Hex) {
    super(`${op} reverted (${txHash})`);
    this.name = 'TxRevertedError';
    this.op = op;
    this.txHash = txHash;
  }
}

/**
 * `pinGas`'s refusal: every estimate attempt came back below the transaction's PROVABLE gas floor
 * (`PreparedTx.gasFloor` — EVM code deposit at exactly 200 gas/byte, and nothing else is physics).
 * That is proof the node answering the estimate hasn't seen the target's deploy block yet, not that
 * the floor is wrong — see `pinGas` in `execute.ts` for the full reasoning. Carries both numbers so a
 * caller can decide to retry against a different RPC rather than re-parse the message.
 */
export class GasEstimateBelowFloorError extends AbxSdkError {
  readonly estimate: bigint;
  readonly floor: bigint;
  constructor(estimate: bigint, floor: bigint) {
    super(
      `Refusing to send: the RPC estimated ${estimate} gas for a transaction that provably needs at least ${floor} ` +
        `(storing ${floor / 200n} bytes on-chain costs 200 gas/byte in code deposit alone). An estimate below the floor means the node ` +
        `is answering from stale state — usually it has not seen the contract's deploy block yet, so the call looks like it is going to ` +
        `an empty account. Sending this would revert DeploymentFailed() and burn the gas. Retry in a few seconds, or use a different RPC.`,
    );
    this.name = 'GasEstimateBelowFloorError';
    this.estimate = estimate;
    this.floor = floor;
  }
}

/**
 * No signing key resolved. SINGLE env name: `ABX_DEPLOYER_PK` — thrown by {@link makeWalletClient}
 * and {@link envSigningKey} (clients.ts). Names the two retired names explicitly (`SEPOLIA_FUNDED_PK`
 * / `SEPOLIA_WALLET_PK`) rather than just omitting them, because a caller upgrading from an older
 * alpha has one of those set in their `.env` and would otherwise see a plain "no key found" with no
 * clue that the key IS there, just under a name the SDK no longer reads.
 */
export class MissingSigningKeyError extends AbxSdkError {
  constructor() {
    super(
      'No signing key found. Set ABX_DEPLOYER_PK in your .env. ' +
        '(SEPOLIA_FUNDED_PK and SEPOLIA_WALLET_PK are no longer read — rename the key to ABX_DEPLOYER_PK.)',
    );
    this.name = 'MissingSigningKeyError';
  }
}

/**
 * A registry-resolved dependency's on-chain bytes are gzip'd, and no `inflate` was supplied to
 * decompress them (`resolveRegistryDep`/`dependencyScriptTags`, deps.ts). SDK core carries no
 * `node:zlib` — it has to stay reachable from a browser bundle (see `test/browser-bundle.test.ts`)
 * — so decompression is an injected function rather than a direct call. Thrown instead of letting
 * the caller either crash on `opts.inflate(...)` being undefined or silently serve a broken
 * document; names the exact fix instead of a generic "cannot read properties of undefined".
 */
export class InflateRequiredError extends AbxSdkError {
  constructor() {
    super(
      "A registry-resolved dependency's on-chain bytes are gzip-compressed, but no `inflate` was " +
        'provided to decompress them. On a Node host, pass `nodeInflate` from `@artblocks/abx-sdk/node` ' +
        "(e.g. `dependencyScriptTags(client, state, {inflate: nodeInflate})`). In a browser, pass a " +
        'DecompressionStream-based implementation — SDK core carries no `node:zlib` so it never assumes one.',
    );
    this.name = 'InflateRequiredError';
  }
}

/**
 * A caller asked reconstruction to stop at the `"safe"` or `"finalized"` block tag
 * ({@link resolveBlockTag}, reconstruct.ts) and the RPC either rejected `eth_getBlockByNumber` for
 * that tag or answered with no block number. Thrown rather than silently falling back to `latest`:
 * the whole point of naming `safe`/`finalized` is the reorg-safety guarantee that tag carries, and a
 * quiet substitution would hand back a normal-looking reconstruction that scanned further than the
 * caller asked for — indistinguishable from success until a reorg proves it wrong. Some
 * chains/providers genuinely don't serve these tags: pre-merge chains have no post-merge finality,
 * and some non-archive or indexer-backed RPCs answer neither tag at all. Expected and actionable,
 * not a bug — names the fallback so a caller isn't stuck.
 */
export class BlockTagUnavailableError extends AbxSdkError {
  readonly tag: 'safe' | 'finalized';
  constructor(tag: 'safe' | 'finalized', cause?: unknown) {
    super(
      `This RPC doesn't support the "${tag}" block tag${cause instanceof Error ? ` (${cause.message})` : ''}. ` +
        `Reconstruction can't resolve a "${tag}" boundary here — use \`latest\` (the default) or an explicit ` +
        `block number instead, or point at an RPC that serves "${tag}" (most L1 mainnets and their public ` +
        `testnets do; some rollups and indexer-backed endpoints don't — \`abx doctor\` rates configured endpoints).`,
    );
    this.name = 'BlockTagUnavailableError';
    this.tag = tag;
  }
}

/** The bootstrap-or-refuse trust anchors / singletons `ensureFactory` & co. (anchors.ts) resolve —
 *  the 721 set (five) plus the ERC-1155 editions twins (`ensureOneOfOneEditionFactory`/
 *  `ensureEditionFactory`/`ensureEditionCodeFactory`). */
export type AnchorKind =
  | 'factory'
  | 'series-factory'
  | 'series-code-factory'
  | 'renderer'
  | 'seed-source'
  | 'one-of-one-edition-factory'
  | 'edition-factory'
  | 'edition-code-factory';

/**
 * A trust anchor {@link AnchorKind} that `ensureFactory`/`ensureSeriesFactory`/
 * `ensureSeriesCodeFactory` (anchors.ts) could not resolve to a usable address, with
 * `allowBootstrap` false — the caller must either point at a working one (override / env /
 * manifest) or opt in to deploying a private one. Carries structured `detail` + `address` instead
 * of a formatted sentence: the SDK doesn't know a UX's flag names or chain-key strings, so it never
 * composes the actual guidance text itself — that's the CLI's `refuseMissingFactory`, which catches
 * this and names the env var / `--bootstrap-factory` / the chain.
 */
export class AnchorUnavailableError extends AbxSdkError {
  readonly anchor: AnchorKind;
  readonly detail: 'no-code' | 'stale-version' | 'not-configured';
  readonly address?: Address;
  constructor(anchor: AnchorKind, detail: 'no-code' | 'stale-version' | 'not-configured', address?: Address) {
    super(`${anchor} trust anchor unavailable (${detail}${address ? `: ${address}` : ''})`);
    this.name = 'AnchorUnavailableError';
    this.anchor = anchor;
    this.detail = detail;
    this.address = address;
  }
}

/**
 * A candidate seed source that {@link probeSeedSource} found unusable — thrown by
 * `assertSeedSourceUsable` (ops.ts). Carries the whole probe (verdict + what was observed) rather
 * than a formatted sentence, same reason as {@link AnchorUnavailableError}: the SDK doesn't know
 * whether the caller got this address from a `--seed-source` flag, an env var, or a form field, so
 * it never composes the guidance itself.
 *
 * Worth catching by type: this is the ONE misconfiguration whose consequence is "every mint of the
 * collection reverts", and it is invisible on every read surface (`seedSource()` returns exactly
 * what was set; the `SeedSourceSet` event fires) — so a UX should treat it as a hard stop, not a
 * warning it can proceed past.
 */
export class SeedSourceUnusableError extends AbxSdkError {
  readonly verdict: SeedSourceVerdict;
  readonly address: Address;
  readonly probe: SeedSourceProbe;
  constructor(probe: SeedSourceProbe) {
    super(`seed source ${probe.address} is not usable (${probe.verdict}${probe.error ? `: ${probe.error}` : ''})`);
    this.name = 'SeedSourceUnusableError';
    this.verdict = probe.verdict;
    this.address = probe.address;
    this.probe = probe;
  }
}
