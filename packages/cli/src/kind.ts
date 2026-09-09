/**
 * Centralized token-kind detection — one shared probe for the six concrete ABX token types, from
 * three plain `eth_call`s (no events, no local index). Before this existed, the same "is this a
 * 721 or an edition, and which concrete type" question was answered by ad-hoc, slightly different
 * probes scattered across `commands/project.ts` (`state`), `commands/scaffold.ts`
 * (`assertMintableSeries`), and `ownerops.ts` (the `set-param-hooks` guard) — this gives it one
 * name and one place to live, so a new call site (mint/transfer/minter kind-awareness) doesn't
 * grow a fourth copy.
 *
 * The discriminator mirrors the SDK's `ProjectState.contractType` union (reconstruct.ts) exactly,
 * but this is a LIVE probe, not an event fold: `state`, `mint-page`, and the owner-op guards need a
 * snapshot with no local index and no getLogs scan.
 *
 *   ERC-165 0xd9b67a26 (ERC-1155)  → the edition family (OneOfOneEdition / EditionImage / EditionCode)
 *   maxInvocations()               → present on the multi-id twins (Series/SeriesCode, EditionImage/Code)
 *   the Params/ConfigurableParams surface (`paramHooks()`) → present only on the two code twins
 *
 * Every probe treats a genuine revert/no-data response as "getter absent", but propagates RPC and
 * transport failures. Conflating those cases silently downgraded a Series to `1of1` whenever a
 * public endpoint transiently failed `maxInvocations()`. A no-code address still makes every getter
 * truthfully absent, so the existence check lives HERE, once, ahead of the probes — every call site
 * inherits it and cannot forget it.
 */
import type {Address, PublicClient} from 'viem';
import {isMissingContractCapability, isRpcReadFailure} from './contract-read-error.js';

/** Mirrors the SDK's `ProjectState.contractType` (reconstruct.ts) — the 721 ladder and its
 *  ERC-1155 edition twin, one rung apart. */
export type TokenKind = '1of1' | 'series' | 'code' | '1of1-edition' | 'edition' | 'edition-code';

export interface TokenKindInfo {
  kind: TokenKind;
  /** The single fact most call sites actually branch on — true for the three ERC-1155 twins. */
  isEdition: boolean;
  /** The concrete contract name, for a readout ("EditionImage (edition) state"). */
  label: string;
}

/** ERC-165 id of ERC-1155 itself — what sorts a clone into the edition family (anchors.ts's
 *  `ERC1155_INTERFACE_ID`, restated here rather than imported: it's a fixed standard id, not SDK
 *  surface). */
const ERC1155_INTERFACE_ID = '0xd9b67a26' as const;

const KIND_PROBE_ABI = [
  {type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{type: 'bytes4'}], outputs: [{type: 'bool'}]},
  {type: 'function', name: 'maxInvocations', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'paramHooks', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}, {type: 'address'}, {type: 'address'}]},
] as const;

function capabilityMissOrThrow(client: PublicClient, address: Address, error: unknown): false {
  if (isMissingContractCapability(error)) return false;
  if (isRpcReadFailure(error)) {
    const chain = client.chain?.name ?? 'the active chain';
    throw new Error(
      `could not detect the token type for ${address} on ${chain} — the RPC answered block/code requests but failed eth_call ` +
        `(rate-limited or backend unhealthy). This is not a contract verdict; check the configured RPC URLs.`,
      {cause: error},
    );
  }
  throw error;
}

/**
 * Refuse to infer a kind for an address that holds no contract. Without this the three negative
 * probes below are indistinguishable from "nothing deployed here", and the ladder's `1of1` default
 * becomes a confident lie about a specific contract type (see the file docstring).
 *
 * Deliberately silent when the check itself can't run (an RPC hiccup → `getCode` throws): a network
 * blip must not become a "no contract" claim, so we fall through to the probes exactly as before and
 * let whatever the caller was doing surface its own error. Same stance as `assertContractExists`.
 */
async function assertHasCode(client: PublicClient, address: Address): Promise<void> {
  let code: string | undefined;
  try {
    code = await client.getCode({address});
  } catch {
    return; // can't tell — don't manufacture a verdict
  }
  if (code && code !== '0x') return;
  const chain = client.chain?.name ?? 'the active chain';
  throw new Error(
    `no contract at ${address} on ${chain} — so there is no token type to read. ` +
      `Check the address, and check the network: a contract that lives on another chain reads as empty here ` +
      `(the chain is picked with ABX_CHAIN; base-sepolia is the default). Owner ops run AFTER deploy.`,
  );
}

async function supportsErc1155(client: PublicClient, address: Address): Promise<boolean> {
  try {
    return (await client.readContract({address, abi: KIND_PROBE_ABI, functionName: 'supportsInterface', args: [ERC1155_INTERFACE_ID]})) as boolean;
  } catch (error) {
    return capabilityMissOrThrow(client, address, error);
  }
}

async function hasMaxInvocations(client: PublicClient, address: Address): Promise<boolean> {
  try {
    await client.readContract({address, abi: KIND_PROBE_ABI, functionName: 'maxInvocations'});
    return true;
  } catch (error) {
    return capabilityMissOrThrow(client, address, error);
  }
}

/** The Params/ConfigurableParams surface probe — `paramHooks()` exists only on SeriesCode/
 *  EditionCode (mirrors the exact check `ownerops.ts`'s `cmdSetParamHooks` already ran ad-hoc). */
async function hasConfigurableParams(client: PublicClient, address: Address): Promise<boolean> {
  try {
    await client.readContract({address, abi: KIND_PROBE_ABI, functionName: 'paramHooks'});
    return true;
  } catch (error) {
    return capabilityMissOrThrow(client, address, error);
  }
}

/**
 * Which of the six concrete ABX token types `address` is — the shared discriminator every command
 * that branches on kind should call instead of re-deriving its own probe. Three live `eth_call`s,
 * in the order that lets each short-circuit the next: ERC-165 first (edition family or not), then
 * `maxInvocations()` (multi-id or not), then the Params surface (code or not).
 */
export async function detectTokenKind(client: PublicClient, address: Address): Promise<TokenKindInfo> {
  await assertHasCode(client, address);
  const isEdition = await supportsErc1155(client, address);
  const capped = await hasMaxInvocations(client, address);
  if (isEdition) {
    if (!capped) return {kind: '1of1-edition', isEdition: true, label: 'OneOfOneEdition'};
    const code = await hasConfigurableParams(client, address);
    return code ? {kind: 'edition-code', isEdition: true, label: 'EditionCode'} : {kind: 'edition', isEdition: true, label: 'EditionImage'};
  }
  if (!capped) return {kind: '1of1', isEdition: false, label: 'OneOfOneImage'};
  const code = await hasConfigurableParams(client, address);
  return code ? {kind: 'code', isEdition: false, label: 'SeriesCode'} : {kind: 'series', isEdition: false, label: 'SeriesImage'};
}

/** Convenience for a call site that only needs the one boolean (is this an ERC-1155 edition, at
 *  all) — the cheapest single probe, so a guard that doesn't need the full breakdown doesn't pay
 *  for the other two calls. */
export async function isEditionContract(client: PublicClient, address: Address): Promise<boolean> {
  return supportsErc1155(client, address);
}

/** Human, one-line description of a kind — `"EditionImage (edition)"`, `"SeriesImage (series)"` —
 *  the shared phrasing for a readout header (`state`, `tokens`). */
export function describeKind(info: TokenKindInfo): string {
  return `${info.label} (${info.kind === '1of1' ? '1/1' : info.kind === '1of1-edition' ? 'edition' : info.kind})`;
}

/** The ConfigurableParams / PostParams surface — SeriesCode and EditionCode only. */
export function hasParamsSurface(info: TokenKindInfo): boolean {
  return info.kind === 'code' || info.kind === 'edition-code';
}

/**
 * Refuse a PostParams command (set-schema / configure-param / retire-param) against a contract
 * that does not compose ConfigurableParams — before any signing prompt, and as a capability
 * mismatch rather than a raw viem revert. Same probe `set-param-hooks` already ran.
 */
export async function assertHasParamsSurface(
  client: PublicClient,
  address: Address,
  what: string,
): Promise<TokenKindInfo> {
  const kind = await detectTokenKind(client, address);
  if (!hasParamsSurface(kind)) {
    throw new Error(
      `${address} exposes no PostParams — ${what} is a SeriesCode/EditionCode feature. ` +
        `${kind.label} has no configurable params.`,
    );
  }
  return kind;
}
