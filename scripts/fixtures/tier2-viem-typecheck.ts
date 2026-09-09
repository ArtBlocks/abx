/**
 * Fixture for tier2-packaged.sh's published-types check.
 *
 * This file is compiled with `tsc --noEmit` inside the tier2 CLEAN CONSUMER — a throwaway
 * `npm install` of our own packed tarballs, which resolves `viem` fresh from the registry
 * rather than from the repo's pinned lockfile. Every other tier2/tier1 check builds from
 * source against OUR lockfile's viem; this is the only place a viem type shift under a
 * semver-compatible bump (a generic's shape changing between minor/patch releases) would be
 * caught before a consumer hits it on a fresh install.
 *
 * Deliberately a representative SLICE of the public @artblocks/abx-sdk surface, not a
 * kitchen sink: one client factory, one function that takes viem's client/account types as
 * parameters (the part of the SDK genuinely generic over viem's own generics), and one
 * plain SDK-only type, so this stays fast enough to run on every dependabot bump.
 */
import type {Address, PublicClient, WalletClient, Account} from '@artblocks/abx-sdk';
import {makePublicClient, makeHotSender, getDeployment, type ClientOptions} from '@artblocks/abx-sdk';

// `PublicClient` is viem's own client type, re-exported verbatim by the SDK (see
// packages/sdk/src/index.ts). Annotating the return value with it — rather than letting it
// infer — is exactly what breaks if viem reshapes that generic between versions.
const opts: ClientOptions = {chainKey: 'sepolia-base'};
const client: PublicClient = makePublicClient(opts);

// `makeHotSender` takes viem's `WalletClient`/`Account`/`PublicClient` types as declared by
// the SDK's generated .d.ts — real generic-over-viem surface, not just a passthrough alias.
function typecheckOnly(wallet: WalletClient, account: Account, publicClient: PublicClient) {
  return makeHotSender({wallet, account, publicClient});
}

// A plain SDK-only type, to confirm the rest of the package's declarations still resolve
// alongside the viem-derived ones above.
const deployment = getDeployment(11155111);
const factory: Address | undefined = deployment.factory;

void client;
void typecheckOnly;
void factory;
