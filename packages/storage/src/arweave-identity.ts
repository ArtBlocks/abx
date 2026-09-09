import {createHash, generateKeyPairSync} from 'node:crypto';

/**
 * An Arweave wallet key (RSA JWK). For the Turbo provider the **same key signs uploads
 * AND owns the prepaid upload credits** — so it's a (low-stakes) asset to back up: lose it
 * and any leftover credits are stranded on an address no one holds.
 *
 * Arweave keys are RSA-4096 with `e = 65537`, which is exactly what Node's `crypto` emits —
 * so we can **generate an identity and derive its address with zero dependencies**, and only
 * reach for the optional Turbo SDK at actual upload / top-up time.
 */
export interface ArweaveJwk {
  kty: string;
  n: string; // modulus (base64url) — the public "owner"
  e: string; // public exponent (base64url, 65537)
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
}

/** Mint a fresh Arweave identity (RSA-4096, e=65537) — dep-free, via Node crypto. */
export function generateArweaveJwk(): ArweaveJwk {
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 4096, publicExponent: 0x10001});
  return privateKey.export({format: 'jwk'}) as ArweaveJwk;
}

/** The Arweave address for a key: `base64url(sha256(modulus))`. Pure derivation — no network. */
export function arweaveAddress(jwk: Pick<ArweaveJwk, 'n'>): string {
  if (!jwk?.n) throw new Error('not an Arweave JWK (missing modulus `n`).');
  const modulus = Buffer.from(jwk.n, 'base64url');
  return createHash('sha256').update(modulus).digest('base64url');
}
