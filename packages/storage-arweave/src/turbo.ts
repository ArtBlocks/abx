import {createHash} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';

/**
 * ArDrive Turbo (Arweave) uploader implementation — split out of `@artblocks/abx-storage` so a
 * default `@artblocks/abx-cli` / `@artblocks/abx-storage` install never installs it.
 * `@ardrive/turbo-sdk` depends on `x402-fetch` -> `x402` -> `wagmi`, which drags in the
 * entire browser wallet-connector ecosystem (`@reown/appkit`, `@walletconnect/*`, `@metamask/sdk`,
 * `@coinbase/wallet-sdk`, `@base-org/account`, `porto`) that a Node CLI never executes — hundreds of
 * megabytes a resolver, indexer, or fs/cloud/ipfs-only self-host never needed.
 *
 * `@artblocks/abx-storage`'s `ArweaveBackend` lazily `await import('@artblocks/abx-storage-arweave')`s
 * this module — only when the `turbo` provider actually needs to sign an upload / check a balance /
 * open a top-up, never for retrieval (get/locator/health) and never merely because `arweave` is the
 * configured backend. Install this package explicitly to use it:
 *
 * ```bash
 * npm install @artblocks/abx-storage-arweave
 * ```
 *
 * Deliberately has NO dependency on `@artblocks/abx-storage` — that would recreate the exact cycle
 * this split exists to avoid (storage -> this package -> storage). Its public types below
 * ({@link TurboIdentity}, {@link ArweaveUploader}, {@link ArweaveFunding}) are declared locally,
 * structurally identical to `@artblocks/abx-storage`'s own types of the same names (see that
 * package's `arweave.ts`) — TypeScript's structural typing makes them interchangeable at the one
 * call site that matters (`ArweaveBackend`'s dynamic import) without either package importing the
 * other's declarations. Likewise `arweaveAddress`/`turboIdentityAddress` below duplicate (rather
 * than import) storage's pure, dependency-free derivations of the same two names — a handful of
 * lines of protocol-fixed math, not worth a package edge.
 */

/** Minimal Arweave wallet key (RSA JWK) shape Turbo's `authenticated({privateKey, token: 'arweave'})`
 *  needs to sign — structurally identical to `@artblocks/abx-storage`'s `ArweaveJwk`. */
export interface ArweaveJwkLike {
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

/**
 * A Turbo signing identity: what signs uploads AND (for the prepaid Turbo path) whose credits pay.
 * Turbo is multi-chain, so an identity is one of:
 *  - **arweave** — a JWK (the CLI-managed default in `@artblocks/abx-storage`).
 *  - **ethereum** — an EVM private key (the `.env` hot lane).
 *  - **ethereum-remote** — a browser wallet reached via a `signMessage` callback (the `--sign` lane).
 */
export type TurboIdentity =
  | {kind: 'arweave'; jwk: ArweaveJwkLike}
  | {kind: 'ethereum'; privateKey: string}
  | {kind: 'ethereum-remote'; address: string; signMessage: (message: Uint8Array) => Promise<string>};

/** Funding capability for a credits-backed Arweave provider — structurally identical to
 *  `@artblocks/abx-storage`'s `ArweaveFunding`. */
export interface ArweaveFunding {
  /** The wallet that HOLDS the credits (an Arweave address) — what a top-up funds. */
  address(): Promise<string>;
  /** Remaining prepaid balance: raw `winc` (Winston credits) + a `credits` ≈ winc/1e12 display. */
  balance(): Promise<{winc: string; credits: string}>;
  /** Open a fiat (card, via Stripe) top-up of `usd` dollars; returns the checkout URL. */
  topup(opts: {usd: number}): Promise<{url: string; winc: string}>;
}

/** An Arweave byte uploader — structurally identical to `@artblocks/abx-storage`'s
 *  `ArweaveUploader`. */
export interface ArweaveUploader {
  upload(bytes: Uint8Array, contentType: string): Promise<{id: string}>;
  readonly funding?: ArweaveFunding;
}

const withHexPrefix = (k: string): `0x${string}` => (k.startsWith('0x') ? (k as `0x${string}`) : (`0x${k}` as `0x${string}`));
const stripHexPrefix = (k: string): string => (k.startsWith('0x') ? k.slice(2) : k);

/** The Arweave address for a JWK: `base64url(sha256(modulus))`. Pure derivation, no network —
 *  duplicated from `@artblocks/abx-storage`'s `arweave-identity.ts` (see the module doc). */
function arweaveAddress(jwk: Pick<ArweaveJwkLike, 'n'>): string {
  const modulus = Buffer.from(jwk.n, 'base64url');
  return createHash('sha256').update(modulus).digest('base64url');
}

/** The credit-holding / signing address for an identity — Arweave `base64url(sha256(n))` or an
 *  EVM `0x…`. Pure derivation, no network — duplicated from `@artblocks/abx-storage`'s
 *  `turboIdentityAddress` (see the module doc). */
function turboIdentityAddress(id: TurboIdentity): string {
  switch (id.kind) {
    case 'arweave':
      return arweaveAddress(id.jwk);
    case 'ethereum':
      return privateKeyToAccount(withHexPrefix(id.privateKey)).address;
    case 'ethereum-remote':
      return id.address;
  }
}

const WINC_PER_CREDIT = 1e12;
/** winc -> a trimmed decimal `credits` display — duplicated (not imported) from
 *  `@artblocks/abx-storage`'s private helper of the same math (see the module doc). */
const wincToCredits = (winc: unknown): string => {
  const n = Number(winc) / WINC_PER_CREDIT;
  return n.toFixed(6).replace(/\.?0+$/, '') || '0';
};

/** Coerce a Turbo `uploadFile` response to text. It's normally an object, but the idempotent
 *  "already uploaded" path returns a plain string (which JSON/stream layers may surface as a
 *  char-indexed object) — Object.values(...).join('') recovers it either way. */
function turboResponseText(res: unknown): string {
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') {
    if ('id' in res && (res as {id?: unknown}).id) return String((res as {id: unknown}).id);
    try {
      return Object.values(res as Record<string, unknown>).join('');
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * The Arweave data-item id from a Turbo `uploadFile` response. Normally `res.id`; but Turbo
 * **deduplicates identical bytes** — a re-upload of the same data item (same signer + tags + bytes →
 * same deterministic id) returns a plain-text `"Data item with ID <id> has already been uploaded to
 * this service!"` instead of the usual JSON. Both are success: the bytes ARE on Turbo. We extract
 * the 43-char base64url txid so idempotent re-uploads (retries, redeploys, duplicate images in a
 * series) resolve to the real locator instead of throwing. Returns null if no id is present.
 */
export function turboUploadId(res: unknown): string | null {
  if (res && typeof res === 'object' && 'id' in res && (res as {id?: unknown}).id) {
    return String((res as {id: unknown}).id);
  }
  const m = turboResponseText(res).match(/\bID\s+([A-Za-z0-9_-]{43})\b/);
  return m ? m[1] : null;
}

/**
 * ArDrive Turbo uploader — the recommended Arweave path. Lazy-loads `@ardrive/turbo-sdk` /
 * `@dha-team/arbundles` only when an upload / balance / top-up actually runs, so merely
 * constructing (or importing) this class stays light. The signing {@link TurboIdentity} is
 * multi-chain: a JWK, an EVM private key, or a remote browser wallet — each both signs uploads and
 * holds the prepaid credits at its own address.
 */
export class TurboUploader implements ArweaveUploader {
  constructor(private readonly identity: TurboIdentity) {
    if (identity.kind === 'arweave' && !identity.jwk?.n) {
      throw new Error('Turbo needs an Arweave identity key (JWK).');
    }
    if (identity.kind === 'ethereum' && !identity.privateKey) {
      throw new Error('Turbo Ethereum identity needs a private key.');
    }
  }

  /**
   * `bigint-buffer` (reached transitively: turbo-sdk -> Solana support -> bigint-buffer) prints
   * `bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)` from its own
   * module body when its optional NATIVE bindings are absent. Nothing is wrong when it does: the
   * pure-JS fallback is correct and the upload/balance still succeeds. But it lands mid-command
   * (a sweep agent reported it as looking like a failure during `abx storage balance`) and it names
   * `npm run rebuild`, a script that does not exist in a creator's project — so it is pure noise
   * that only we can silence, at the one import that triggers it.
   *
   * Filtered as a PREFIX match on that single message, with `console.warn` restored in a `finally`
   * even if the import throws. Deliberately not a blanket silence: a real warning from turbo-sdk
   * still reaches the user.
   */
  private async sdk() {
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('bigint: Failed to load bindings')) return;
      original(...args);
    };
    try {
      return await import('@ardrive/turbo-sdk');
    } finally {
      console.warn = original;
    }
  }

  /** arbundles (the signing lib Turbo uses) — for `InjectedEthereumSigner`, which turbo-sdk does NOT
   *  re-export. Only reached on the remote-wallet upload path. */
  private async arbundles() {
    return import('@dha-team/arbundles');
  }

  private clientPromise?: Promise<unknown>;
  private client(): Promise<any> {
    return (this.clientPromise ??= this.buildClient());
  }

  /** Authenticate a Turbo client for the selected identity. Arweave uses the JWK directly; an EVM
   *  identity uses an arbundles `EthereumSigner` (local key) or `InjectedEthereumSigner` (remote
   *  wallet) — the SDK re-exports both, so no direct arbundles dependency. */
  private async buildClient(): Promise<any> {
    const m = await this.sdk();
    const id = this.identity;
    if (id.kind === 'arweave') {
      return m.TurboFactory.authenticated({privateKey: id.jwk as any, token: 'arweave'});
    }
    if (id.kind === 'ethereum') {
      const signer = new m.EthereumSigner(stripHexPrefix(id.privateKey));
      return m.TurboFactory.authenticated({signer, token: 'ethereum'});
    }
    // ethereum-remote: drive arbundles' own InjectedEthereumSigner via a provider shim that
    // round-trips each signMessage to the browser wallet. arbundles calls `signer.signMessage(msg)`
    // with a STRING challenge (setPublicKey → pubkey recovery, one prompt) and a Uint8Array per data
    // item, and expects back a `0x…` hex signature (it does `sig.slice(2)`). ethers'
    // signMessage(string) ≡ signMessage(utf8Bytes(string)), so normalizing to bytes is faithful.
    // NOTE: turbo-sdk re-exports EthereumSigner but NOT InjectedEthereumSigner — import it from
    // arbundles (the same package turbo signs with) directly.
    const {InjectedEthereumSigner} = await this.arbundles();
    const signMessage = id.signMessage;
    const provider = {
      getSigner: () => ({
        signMessage: (message: string | Uint8Array): Promise<string> =>
          signMessage(typeof message === 'string' ? new TextEncoder().encode(message) : Uint8Array.from(message)),
      }),
    };
    const signer = new InjectedEthereumSigner(provider as never);
    await signer.setPublicKey();
    return m.TurboFactory.authenticated({signer, token: 'ethereum'});
  }

  async upload(bytes: Uint8Array, contentType: string): Promise<{id: string}> {
    const turbo = await this.client();
    const {Readable} = await import('node:stream');
    const buf = Buffer.from(bytes);
    const res = await turbo.uploadFile({
      fileStreamFactory: () => Readable.from(buf),
      fileSizeFactory: () => buf.byteLength,
      dataItemOpts: {tags: [{name: 'Content-Type', value: contentType}]},
    });
    const id = turboUploadId(res);
    if (!id) throw new Error(`Turbo upload returned no transaction id (response: ${turboResponseText(res).slice(0, 200)})`);
    return {id};
  }

  readonly funding: ArweaveFunding = {
    address: async () => turboIdentityAddress(this.identity),
    balance: async () => {
      const turbo = await this.client();
      const {winc} = (await turbo.getBalance()) as {winc: unknown};
      return {winc: String(winc), credits: wincToCredits(winc)};
    },
    topup: async ({usd}) => {
      const [turbo, m] = await Promise.all([this.client(), this.sdk()]);
      const session = (await turbo.createCheckoutSession({amount: m.USD(usd), owner: turboIdentityAddress(this.identity)})) as {
        url?: string;
        winc?: unknown;
      };
      if (!session?.url) throw new Error('Turbo top-up returned no checkout URL');
      return {url: String(session.url), winc: String(session.winc ?? '')};
    },
  };
}
