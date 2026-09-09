/**
 * Mint-page scaffolding — a **self-contained** Next.js starter a creator stands up to sell a drop,
 * compatible with the shared {AbxFixedPriceMinter}. The sibling of `deploy-resolver`: a buildable
 * artifact the creator OWNS and customizes (with the agent's help), not a service we run.
 *
 * SELF-CONTAINED + BACKEND-FREE by design:
 *   - Reads live sale state (price · sold/allocation · paused · supply) straight from chain, and each
 *     token's image/name from `tokenURI(id)` — no server, no database. Fully-on-chain collections need
 *     nothing else; off-chain ones rely on their `tokenURI` resolving (same as any marketplace).
 *   - Wallet connect + mint use viem + the injected browser wallet (`window.ethereum`) — NO API keys,
 *     no WalletConnect projectId. The README shows how to swap in RainbowKit for multi-wallet.
 *   - Reads use a PUBLIC RPC (never the creator's keyed endpoint — that would leak a secret into a
 *     `NEXT_PUBLIC_` var); the mint tx uses the wallet's own RPC. Config rides `NEXT_PUBLIC_*` env vars,
 *     prefilled by the CLI into `.env.local`.
 *
 * V1 scope (deliberately minimal — customize from here): ETH sales, one mint per click, a paginated
 * gallery of minted tokens. ERC-20 sales (need an `approve` step) are flagged as a customization.
 *
 * Pure module: returns the artifact files + the exact next-step commands. The CLI writes the files and
 * prints the steps; `vercel` / `next dev` run in the creator's own account/machine — they own that step.
 */

import {readSdkVersion} from './update-check.js';

export interface MintPageOptions {
  /** The ABX token (collection) contract to sell. */
  token: string;
  /** The shared fixed-price minter for the chain — the 721 `AbxFixedPriceMinter`, or (when
   *  {@link isEdition}) its 1155 sibling `AbxFixedPriceMinter1155`. */
  minter: string;
  chainId: number;
  chainName: string;
  /** A PUBLIC read RPC (no API key — it is embedded in a NEXT_PUBLIC_ var / a public site). */
  rpcUrl: string;
  /** Display name for the collection (defaults from the token's on-chain name). */
  collectionName: string;
  /** Block explorer base (e.g. https://sepolia.etherscan.io), for a "view contract" link. */
  explorer?: string;
  /**
   * The target is an ERC-1155 edition (OneOfOneEdition/EditionImage/EditionCode) rather than a 721
   * Series/SeriesCode — sales are keyed `(token, id)`, so the generated page takes a token-id +
   * quantity input and pays `price × quantity`, instead of the 721 page's one project-wide sale.
   *
   * v1 scope (deliberately minimal — the 721 page's gallery/pagination is NOT ported): a purchase
   * of "copies" of one id doesn't have the 721 page's "one owner per token" gallery to show, and
   * building a per-id browsing UI is real design work this pass didn't take on. The purchase
   * controls (price, sold/allocation, per-id supply/cap, paused) are fully live from chain either
   * way — just without a tile grid underneath them.
   */
  isEdition?: boolean;
}

export interface MintPageArtifact {
  files: Array<{path: string; content: string}>;
  steps: string[];
}

/** Public, keyless RPCs safe to embed in a public site. Extend as chains are added.
 *  base-sepolia is the toolkit's DEFAULT chain — its absence here meant every default-chain
 *  deploy needed a manual --rpc just to scaffold its own mint page (integrator-reported). */
export const PUBLIC_RPC: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
  84532: 'https://sepolia.base.org',
};

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'abx';

// ── file contents ─────────────────────────────────────────────────────────────
// NOTE: emitted TS/TSX below uses single-quote strings + concatenation and avoids backticks and
// `${}` on purpose — so these Node template literals only interpolate SCAFFOLD-time values, never
// browser-runtime ones. Keep it that way when editing.

function packageJson(o: MintPageOptions): string {
  return JSON.stringify(
    {
      name: slug(o.collectionName) + '-mint',
      private: true,
      version: '0.1.0',
      scripts: {dev: 'next dev', build: 'next build', start: 'next start'},
      dependencies: {
        next: '^15.0.3',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
        viem: '^2.21.0',
        // Pinned to THIS CLI's own version, caret-ranged — the CLI and sdk version-bump together in
        // this repo's changesets flow, so "the version that scaffolded this app" is exactly the
        // floor that's guaranteed to have makePublicClient/readSaleConfig/the `/abi` subpath (this
        // refactor). INVARIANT: an sdk older than that will be missing one of those exports.
        '@artblocks/abx-sdk': '^' + readSdkVersion(),
      },
      devDependencies: {
        typescript: '^5.6.0',
        '@types/node': '^22.0.0',
        '@types/react': '^19.0.0',
        '@types/react-dom': '^19.0.0',
      },
    },
    null,
    2,
  );
}

const NEXT_CONFIG = `/** @type {import('next').NextConfig} */
// Images render via a plain <img> from data:/http(s) URIs, so the built-in optimizer is off
// (no per-domain allowlist to maintain). Customize freely.
const nextConfig = {images: {unoptimized: true}};
export default nextConfig;
`;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2020',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'preserve',
      incremental: true,
      plugins: [{name: 'next'}],
      paths: {'@/*': ['./*']},
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  },
  null,
  2,
);

const NEXT_ENV = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
// NOTE: This file should not be edited. See https://nextjs.org/docs/basic-features/typescript
`;

const GITIGNORE = `/node_modules
/.next
/out
.env.local
.DS_Store
*.log
.vercel
`;

function envFile(o: MintPageOptions): string {
  return (
    'NEXT_PUBLIC_CHAIN_ID=' +
    o.chainId +
    '\nNEXT_PUBLIC_CHAIN_NAME=' +
    o.chainName +
    '\n# PUBLIC, keyless RPC (embedded in the public site — never put a keyed endpoint here).\n' +
    'NEXT_PUBLIC_RPC_URL=' +
    o.rpcUrl +
    '\nNEXT_PUBLIC_TOKEN=' +
    o.token +
    '\nNEXT_PUBLIC_MINTER=' +
    o.minter +
    '\nNEXT_PUBLIC_COLLECTION_NAME=' +
    o.collectionName +
    '\nNEXT_PUBLIC_EXPLORER=' +
    (o.explorer ?? '') +
    '\n'
  );
}

const LIB_CONFIG = `// Config from NEXT_PUBLIC_* env (prefilled by \`abx mint-page\` into .env.local; set the same in Vercel).
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || '11155111');
export const CHAIN_NAME = process.env.NEXT_PUBLIC_CHAIN_NAME || 'Sepolia';
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
export const TOKEN = (process.env.NEXT_PUBLIC_TOKEN || '') as \`0x\${string}\`;
export const MINTER = (process.env.NEXT_PUBLIC_MINTER || '') as \`0x\${string}\`;
export const COLLECTION_NAME = process.env.NEXT_PUBLIC_COLLECTION_NAME || 'ABX Collection';
export const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER || '';
export const PAGE_SIZE = 12;
`;

const LIB_CHAIN = `import {defineChain} from 'viem';
import {CHAIN_ID, CHAIN_NAME, RPC_URL} from './config';

// A minimal viem chain built from config — no dependency on viem/chains matching the id.
export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
  rpcUrls: {default: {http: [RPC_URL]}},
});
`;

const LIB_ABI = `// Minter + token ABIs, sourced from the shared SDK instead of hand-typed here — one definition
// that tracks the deployed contracts (the ABX repo's 'pnpm sync-abis' regenerates it from the
// contracts themselves), so this file can never drift the way a hand-copied fragment can.
//
// name / totalSupply / maxInvocations / paused / tokenURI are identical fragments on every ABX
// Series contract type (Image or Code) — importing both and spreading is harmless (duplicate
// fragments, byte-identical shape) and keeps this working whichever Series type backs your
// collection, without this app needing to know which one it is.
// (A rename re-export — 'export {x as y} from …' — of a subpath import tripped up Next's bundler
// here; a plain import + local const assignment is the form that survives the production build.)
import {abxFixedPriceMinterAbi, seriesImageAbi, seriesCodeAbi} from '@artblocks/abx-sdk/abi';

export const minterAbi = abxFixedPriceMinterAbi;
export const tokenAbi = [...seriesImageAbi, ...seriesCodeAbi] as const;
`;

// The edition twin of LIB_ABI — same reasoning (one SDK-sourced definition, never hand-typed), the
// 1155 sale singleton + the narrowest-common-superset edition token ABI (covers OneOfOneEdition/
// EditionImage/EditionCode — see the SDK's ops.ts for why one ABI serves the whole family).
const LIB_ABI_EDITION = `// Minter + token ABIs for an EDITION target (ERC-1155 copies) — see the non-edition lib/abi.ts's
// twin for the "why sourced from the SDK, never hand-typed" note.
import {abxFixedPriceMinter1155Abi, oneOfOneEditionAbi} from '@artblocks/abx-sdk/abi';

export const minterAbi = abxFixedPriceMinter1155Abi;
export const tokenAbi = oneOfOneEditionAbi;
`;

const LIB_META = `// Read a token's image + name from tokenURI(id), directly from chain. Handles data: URIs
// (on-chain tokens) and http/ipfs/ar locators (off-chain custody). No backend.
//
// The read client is the SDK's browser-safe makePublicClient, given an EXPLICIT rpcUrls list —
// never env resolution (there is no server .env in a static site, and the SDK's own
// ABX_RPC_URLS/ABX_CHAIN conventions would silently no-op in a browser bundle anyway; an explicit
// override short-circuits that lookup entirely). One URL behaves exactly like a plain http()
// transport; paste a comma-separated NEXT_PUBLIC_RPC_URL to get the same fallback-transport
// failover the CLI/indexer get. Its attached chain metadata is the SDK's own default and is
// informational only for these plain reads — the WALLET's chain (used for the mint tx) is the one
// built in ./chain from your real NEXT_PUBLIC_CHAIN_ID/NAME, unaffected by this.
//
// Gateway + data: URI parsing go through the SAME sdk helpers the CLI/indexer use
// (gatewayUrlFor/resolveGatewayBase, parseDataUri) instead of a hand-rolled 'ipfs://'-slicing body —
// one implementation of "how to read a locator" instead of this app quietly re-deriving its own.
import {makePublicClient, gatewayUrlFor, resolveGatewayBase, parseDataUri} from '@artblocks/abx-sdk';
import {RPC_URL, TOKEN} from './config';
import {tokenAbi} from './abi';

export const publicClient = makePublicClient({rpcUrls: RPC_URL.split(',').map((u) => u.trim()).filter(Boolean)});

export function toGateway(u: string): string {
  if (!u) return '';
  if (u.startsWith('ipfs://')) return gatewayUrlFor('ipfs', u.slice(7), resolveGatewayBase('ipfs'));
  if (u.startsWith('ar://')) return gatewayUrlFor('arweave', u.slice(5), resolveGatewayBase('arweave'));
  return u;
}

async function fetchJson(uri: string): Promise<any> {
  const parsed = parseDataUri(uri);
  if (parsed) {
    const text = parsed.base64 ? atob(parsed.body) : decodeURIComponent(parsed.body);
    return JSON.parse(text);
  }
  const res = await fetch(toGateway(uri));
  return res.json();
}

export interface TokenMeta {
  id: number;
  name: string;
  image: string;
}

export async function readTokenMeta(id: number): Promise<TokenMeta> {
  const uri = (await publicClient.readContract({address: TOKEN, abi: tokenAbi, functionName: 'tokenURI', args: [BigInt(id)]})) as string;
  const json = await fetchJson(uri);
  return {id, name: json.name || '#' + id, image: toGateway(json.image || '')};
}
`;

const APP_LAYOUT = `import './globals.css';
import type {ReactNode} from 'react';
import {COLLECTION_NAME} from '../lib/config';

export const metadata = {title: COLLECTION_NAME + ' — Mint', description: 'Mint ' + COLLECTION_NAME};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

const APP_GLOBALS = `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: #0b0b0f;
  color: #e8e8ea;
}
.wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font-size: 28px; margin: 0 0 4px; }
.muted { color: #9a9aa2; }
.card { background: #15151c; border: 1px solid #26262f; border-radius: 14px; padding: 20px; }
.row { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; }
button {
  font: inherit; font-weight: 600; cursor: pointer;
  background: #6d5efc; color: #fff; border: 0; border-radius: 10px; padding: 12px 20px;
}
button:disabled { background: #2a2a35; color: #6b6b75; cursor: not-allowed; }
button.ghost { background: transparent; border: 1px solid #3a3a46; color: #e8e8ea; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-top: 20px; }
.tile { background: #15151c; border: 1px solid #26262f; border-radius: 12px; overflow: hidden; }
.tile img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: #0e0e13; }
.tile .label { padding: 10px 12px; font-size: 14px; }
.pager { display: flex; gap: 10px; align-items: center; justify-content: center; margin-top: 24px; }
a { color: #a99bff; }
.stat { font-size: 15px; }
.stat b { color: #fff; }
.pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.pill.open { background: #12351f; color: #57d98a; }
.pill.closed { background: #351212; color: #e88; }
`;

const APP_PAGE = `import Mint from './mint-client';
export default function Page() {
  return <Mint />;
}
`;

// The whole UI in one client component: live sale state + paginated gallery + connect/mint.
const APP_MINT_CLIENT = `'use client';
import {useCallback, useEffect, useState} from 'react';
import {createWalletClient, custom, formatEther} from 'viem';
import {chain} from '../lib/chain';
import {readSaleConfig, type SaleConfig} from '@artblocks/abx-sdk';
import {CHAIN_ID, CHAIN_NAME, COLLECTION_NAME, EXPLORER, MINTER, PAGE_SIZE, TOKEN} from '../lib/config';
import {minterAbi, tokenAbi} from '../lib/abi';
import {publicClient, readTokenMeta, type TokenMeta} from '../lib/meta';

const ZERO = '0x0000000000000000000000000000000000000000';

export default function Mint() {
  const [sale, setSale] = useState<SaleConfig | null>(null);
  const [supply, setSupply] = useState(0);
  const [maxInv, setMaxInv] = useState(0);
  const [paused, setPaused] = useState(false);
  const [account, setAccount] = useState<string>('');
  const [page, setPage] = useState(0);
  const [tiles, setTiles] = useState<TokenMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    setSale(await readSaleConfig(publicClient, MINTER, TOKEN));
    const [ts, mx, pz] = await Promise.all([
      publicClient.readContract({address: TOKEN, abi: tokenAbi, functionName: 'totalSupply'}),
      publicClient.readContract({address: TOKEN, abi: tokenAbi, functionName: 'maxInvocations'}),
      publicClient.readContract({address: TOKEN, abi: tokenAbi, functionName: 'paused'}),
    ]);
    setSupply(Number(ts));
    setMaxInv(Number(mx));
    setPaused(Boolean(pz));
  }, []);

  useEffect(() => {
    refresh().catch((e) => setMsg(String(e)));
  }, [refresh]);

  // Load the visible page of minted tokens (newest first). Only this page's tokenURIs are fetched.
  useEffect(() => {
    let live = true;
    (async () => {
      const ids: number[] = [];
      const start = page * PAGE_SIZE;
      for (let i = 0; i < PAGE_SIZE; i++) {
        const id = supply - 1 - start - i;
        if (id < 0) break;
        ids.push(id);
      }
      const metas = await Promise.all(ids.map((id) => readTokenMeta(id).catch(() => ({id, name: '#' + id, image: ''}))));
      if (live) setTiles(metas);
    })();
    return () => {
      live = false;
    };
  }, [page, supply]);

  async function connect() {
    const eth = (window as any).ethereum;
    if (!eth) {
      setMsg('No injected wallet found — install MetaMask (or another browser wallet).');
      return;
    }
    const accts = (await eth.request({method: 'eth_requestAccounts'})) as string[];
    setAccount(accts[0] || '');
    try {
      await eth.request({method: 'wallet_switchEthereumChain', params: [{chainId: '0x' + CHAIN_ID.toString(16)}]});
    } catch (e) {
      /* user can switch manually; the mint call will surface a wrong-network error */
    }
  }

  async function mint() {
    if (!sale) return;
    const eth = (window as any).ethereum;
    if (!eth || !account) return connect();
    setBusy(true);
    setMsg('');
    try {
      const wallet = createWalletClient({account: account as any, chain, transport: custom(eth)});
      // The buyer's terms guard: the tx commits to the terms this page is SHOWING
      // (paymentToken + price). If the owner re-configures the sale in between, the minter reverts
      // SaleTermsChanged instead of charging the new price / pulling a different token.
      const hash = await wallet.writeContract({address: MINTER, abi: minterAbi, functionName: 'purchase', args: [TOKEN, sale.paymentToken, sale.price], value: sale.price, account: account as any, chain});
      setMsg('Minting… tx ' + hash.slice(0, 10) + '…');
      await publicClient.waitForTransactionReceipt({hash});
      setMsg('Minted! ✦');
      setPage(0);
      await refresh();
    } catch (e: any) {
      const text = e && e.shortMessage ? e.shortMessage : String(e && e.message ? e.message : e);
      // Refresh on EITHER stale-terms signal. SaleTermsChanged is the guard firing (the price rose,
      // or the payment token changed). WrongPayment is the ETH lane's exact-value check firing, which
      // is what a price CUT looks like: the guard is a ceiling so it passes, then the exact-value
      // equality fails because V1 has no refunds. Matching only the first left this page wedged after
      // a price cut — every retry failed until the buyer reloaded.
      if (/SaleTermsChanged|WrongPayment/.test(String(e && (e.message || e)))) {
        await refresh().catch(() => {});
        setMsg('The sale terms changed — nothing was charged. The price above is refreshed; review it and mint again.');
      } else {
        setMsg(text);
      }
    } finally {
      setBusy(false);
    }
  }

  const isEth = !sale || sale.paymentToken === ZERO;
  const soldOut = !!sale && (sale.sold >= sale.allocation || (maxInv > 0 && supply >= maxInv));
  const pages = Math.max(1, Math.ceil(supply / PAGE_SIZE));
  const canMint = !!sale && sale.configured && !paused && !soldOut && isEth && !busy;

  return (
    <main className="wrap">
      <div className="row" style={{marginBottom: 20}}>
        <div>
          <h1>{COLLECTION_NAME}</h1>
          <div className="muted">
            {EXPLORER ? <a href={EXPLORER + '/address/' + TOKEN} target="_blank" rel="noreferrer">contract ↗</a> : TOKEN}
            {' · '}
            {CHAIN_NAME}
          </div>
        </div>
        {account ? <span className="muted">{account.slice(0, 6) + '…' + account.slice(-4)}</span> : <button className="ghost" onClick={connect}>Connect wallet</button>}
      </div>

      <div className="card">
        <div className="row">
          <div className="stat">
            {sale ? <>Price <b>{isEth ? formatEther(sale.price) + ' ETH' : sale.price.toString() + ' units'}</b></> : 'Loading…'}
            {sale ? <> &nbsp;·&nbsp; Sold <b>{sale.sold.toString()}/{sale.allocation.toString()}</b></> : null}
            {maxInv > 0 ? <> &nbsp;·&nbsp; Supply <b>{supply}/{maxInv}</b></> : null}
            {' '}
            <span className={'pill ' + (paused || soldOut ? 'closed' : 'open')}>{soldOut ? 'sold out' : paused ? 'paused' : 'open'}</span>
          </div>
          <button onClick={mint} disabled={!canMint}>
            {busy ? 'Minting…' : soldOut ? 'Sold out' : paused ? 'Paused' : !isEth ? 'ERC-20 — see README' : account ? 'Mint' : 'Connect & mint'}
          </button>
        </div>
        {msg ? <div className="muted" style={{marginTop: 12}}>{msg}</div> : null}
        {sale && !sale.configured ? <div className="muted" style={{marginTop: 12}}>No sale configured yet for this collection.</div> : null}
      </div>

      <div className="grid">
        {tiles.map((t) => (
          <div className="tile" key={t.id}>
            {t.image ? <img src={t.image} alt={t.name} /> : <div style={{aspectRatio: '1', background: '#0e0e13'}} />}
            <div className="label">{t.name}</div>
          </div>
        ))}
      </div>
      {supply === 0 ? <p className="muted" style={{textAlign: 'center', marginTop: 24}}>No tokens minted yet — be the first.</p> : null}

      {pages > 1 ? (
        <div className="pager">
          <button className="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Prev</button>
          <span className="muted">Page {page + 1} / {pages}</span>
          <button className="ghost" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>Next</button>
        </div>
      ) : null}
    </main>
  );
}
`;

// The edition twin of APP_MINT_CLIENT — a token-id + quantity purchase against the shared 1155
// minter (sales are keyed (token, id)), price × quantity computed live. No gallery/pagination (see
// MintPageOptions.isEdition's own scope note) — the purchase controls are the whole page.
const APP_MINT_CLIENT_EDITION = `'use client';
import {useCallback, useEffect, useState} from 'react';
import {createWalletClient, custom, formatEther} from 'viem';
import {chain} from '../lib/chain';
import {readSaleConfig1155, type SaleConfig1155} from '@artblocks/abx-sdk';
import {CHAIN_ID, CHAIN_NAME, COLLECTION_NAME, EXPLORER, MINTER, TOKEN} from '../lib/config';
import {minterAbi, tokenAbi} from '../lib/abi';
import {publicClient} from '../lib/meta';

const ZERO = '0x0000000000000000000000000000000000000000';

export default function Mint() {
  const [tokenId, setTokenId] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [sale, setSale] = useState<SaleConfig1155 | null>(null);
  const [supply, setSupply] = useState(0);
  const [maxSupply, setMaxSupply] = useState(0);
  const [paused, setPaused] = useState(false);
  const [account, setAccount] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async (id: number) => {
    const [s, ts, ms, pz] = await Promise.all([
      readSaleConfig1155(publicClient, MINTER, TOKEN, BigInt(id)),
      publicClient.readContract({address: TOKEN, abi: tokenAbi, functionName: 'totalSupply', args: [BigInt(id)]}),
      publicClient.readContract({address: TOKEN, abi: tokenAbi, functionName: 'maxSupply', args: [BigInt(id)]}),
      publicClient.readContract({address: TOKEN, abi: tokenAbi, functionName: 'paused'}),
    ]);
    setSale(s);
    setSupply(Number(ts));
    setMaxSupply(Number(ms));
    setPaused(Boolean(pz));
  }, []);

  useEffect(() => {
    refresh(tokenId).catch((e) => setMsg(String(e)));
  }, [tokenId, refresh]);

  async function connect() {
    const eth = (window as any).ethereum;
    if (!eth) {
      setMsg('No injected wallet found — install MetaMask (or another browser wallet).');
      return;
    }
    const accts = (await eth.request({method: 'eth_requestAccounts'})) as string[];
    setAccount(accts[0] || '');
    try {
      await eth.request({method: 'wallet_switchEthereumChain', params: [{chainId: '0x' + CHAIN_ID.toString(16)}]});
    } catch (e) {
      /* user can switch manually; the mint call will surface a wrong-network error */
    }
  }

  async function mint() {
    if (!sale) return;
    const eth = (window as any).ethereum;
    if (!eth || !account) return connect();
    setBusy(true);
    setMsg('');
    try {
      const wallet = createWalletClient({account: account as any, chain, transport: custom(eth)});
      const value = sale.price * BigInt(quantity);
      // The buyer's terms guard, edition-shaped: the tx commits to the terms this page is SHOWING
      // and bounds the TOTAL (price × quantity, the same number attached as ETH), so an owner who
      // re-configures the sale mid-click gets SaleTermsChanged instead of charging more.
      const hash = await wallet.writeContract({
        address: MINTER,
        abi: minterAbi,
        functionName: 'purchase',
        args: [TOKEN, BigInt(tokenId), BigInt(quantity), sale.paymentToken, value],
        value,
        account: account as any,
        chain,
      });
      setMsg('Minting… tx ' + hash.slice(0, 10) + '…');
      await publicClient.waitForTransactionReceipt({hash});
      setMsg('Minted! ✦');
      await refresh(tokenId);
    } catch (e: any) {
      const text = e && e.shortMessage ? e.shortMessage : String(e && e.message ? e.message : e);
      // Both stale-terms signals — see the single-token lane above for why WrongPayment belongs here.
      if (/SaleTermsChanged|WrongPayment/.test(String(e && (e.message || e)))) {
        await refresh(tokenId).catch(() => {});
        setMsg('The sale terms changed — nothing was charged. The price above is refreshed; review it and mint again.');
      } else {
        setMsg(text);
      }
    } finally {
      setBusy(false);
    }
  }

  const isEth = !sale || sale.paymentToken === ZERO;
  const remaining = maxSupply > 0 ? Math.max(0, maxSupply - supply) : null;
  const soldOut = !!sale && (sale.sold >= sale.allocation || (remaining !== null && remaining <= 0));
  const canMint = !!sale && sale.configured && !paused && !soldOut && isEth && !busy && quantity > 0;
  const totalPrice = sale ? sale.price * BigInt(quantity) : 0n;

  return (
    <main className="wrap">
      <div className="row" style={{marginBottom: 20}}>
        <div>
          <h1>{COLLECTION_NAME}</h1>
          <div className="muted">
            {EXPLORER ? <a href={EXPLORER + '/address/' + TOKEN} target="_blank" rel="noreferrer">contract ↗</a> : TOKEN}
            {' · '}
            {CHAIN_NAME}
            {' · edition (ERC-1155)'}
          </div>
        </div>
        {account ? <span className="muted">{account.slice(0, 6) + '…' + account.slice(-4)}</span> : <button className="ghost" onClick={connect}>Connect wallet</button>}
      </div>

      <div className="card">
        <div className="row" style={{marginBottom: 14}}>
          <label className="muted">
            Token ID
            <input
              type="number"
              min={0}
              value={tokenId}
              onChange={(e) => setTokenId(Math.max(0, Number(e.target.value) || 0))}
              style={{marginLeft: 8, width: 90}}
            />
          </label>
          <label className="muted">
            Quantity
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
              style={{marginLeft: 8, width: 90}}
            />
          </label>
        </div>
        <div className="row">
          <div className="stat">
            {sale ? <>Price <b>{isEth ? formatEther(sale.price) + ' ETH' : sale.price.toString() + ' units'}</b> / copy</> : 'Loading…'}
            {sale ? <> &nbsp;·&nbsp; Total <b>{isEth ? formatEther(totalPrice) + ' ETH' : totalPrice.toString() + ' units'}</b></> : null}
            {sale ? <> &nbsp;·&nbsp; Sold <b>{sale.sold.toString()}/{sale.allocation.toString()}</b></> : null}
            {maxSupply > 0 ? <> &nbsp;·&nbsp; Copies <b>{supply}/{maxSupply}</b></> : <> &nbsp;·&nbsp; Copies <b>{supply}</b> (open)</>}
            {' '}
            <span className={'pill ' + (paused || soldOut ? 'closed' : 'open')}>{soldOut ? 'sold out' : paused ? 'paused' : 'open'}</span>
          </div>
          <button onClick={mint} disabled={!canMint}>
            {busy ? 'Minting…' : soldOut ? 'Sold out' : paused ? 'Paused' : !isEth ? 'ERC-20 — see README' : account ? 'Mint' : 'Connect & mint'}
          </button>
        </div>
        {msg ? <div className="muted" style={{marginTop: 12}}>{msg}</div> : null}
        {sale && !sale.configured ? <div className="muted" style={{marginTop: 12}}>No sale configured yet for id #{tokenId}.</div> : null}
      </div>
    </main>
  );
}
`;

function readme(o: MintPageOptions): string {
  return (
    '# ' +
    o.collectionName +
    ' — mint page\n\n' +
    'A self-contained Next.js mint site for the ABX collection `' +
    o.token +
    '`, wired to the shared fixed-price minter `' +
    o.minter +
    '` on ' +
    o.chainName +
    '. Generated by `abx mint-page`.\n\n' +
    '## Run it locally\n\n' +
    '```bash\nnpm install\nnpm run dev      # http://localhost:3000\n```\n\n' +
    'Config lives in `.env.local` (already prefilled). It reads sale state + each token\'s image straight from chain — no backend.\n\n' +
    '## Deploy (Vercel — recommended)\n\n' +
    '```bash\nnpm i -g vercel\nvercel            # first run links/creates the project\nvercel --prod     # ship it\n```\n\n' +
    'In the Vercel dashboard set the same `NEXT_PUBLIC_*` vars from `.env.local` (Project → Settings → Environment Variables), then redeploy. Any Next.js host works; Vercel is the least-setup path.\n\n' +
    '## Customize (this is a starting point)\n\n' +
    '- **Design** — it is plain React + one `app/globals.css`. Restyle freely; ask your agent for a bespoke layout per drop.\n' +
    '- **Multi-wallet** — V1 uses the injected wallet (`window.ethereum`) with zero config. For WalletConnect/Coinbase/etc., swap in [RainbowKit](https://rainbowkit.com) + wagmi (needs a WalletConnect projectId).\n' +
    '- **ERC-20 sales** — the mint button handles ETH. For an ERC-20-priced sale, add an `approve(minter, price)` step before `purchase` (see `lib/abi.ts`).\n' +
    '- **Sale terms are part of the purchase** — `purchase` takes the payment token and a max price, and the page passes the terms it just read from chain. If the owner re-prices mid-click the mint reverts `SaleTermsChanged` (nothing is charged) and the page tells the buyer to review the new price. Keep that: an unbounded price is how a re-priced sale could reach a buyer\'s ERC-20 allowance.\n' +
    '- **RPC** — `NEXT_PUBLIC_RPC_URL` is a public endpoint (may rate-limit). Use your own **keyless** endpoint if you like; never put a secret-keyed URL in a `NEXT_PUBLIC_` var — it ships to the browser.\n' +
    (o.isEdition
      ? '- **Gallery** — NOT included for an edition (v1 scope). Sales are keyed `(token, id)` — a "copies of one id" page has no single "minted tokens" list the way a 721 Series does; the purchase card (price, sold/allocation, per-id supply/cap, paused) is fully live from chain. Add a gallery yourself (or ask your agent) if you want one — e.g. loop `uri(id)` over the id range you care about.\n'
      : '- **Gallery** — shows minted tokens newest-first, paginated. It reads `tokenURI(id)`; on-chain collections resolve with no backend, off-chain ones need their resolver/gateway reachable.\n')
  );
}

export function mintPageArtifact(o: MintPageOptions): MintPageArtifact {
  const isEdition = !!o.isEdition;
  return {
    files: [
      {path: 'package.json', content: packageJson(o)},
      {path: 'next.config.mjs', content: NEXT_CONFIG},
      {path: 'tsconfig.json', content: TSCONFIG},
      {path: 'next-env.d.ts', content: NEXT_ENV},
      {path: '.gitignore', content: GITIGNORE},
      {path: '.env.local', content: envFile(o)},
      {path: '.env.example', content: envFile({...o, token: '0xYourCollection', minter: o.minter})},
      {path: 'lib/config.ts', content: LIB_CONFIG},
      {path: 'lib/chain.ts', content: LIB_CHAIN},
      {path: 'lib/abi.ts', content: isEdition ? LIB_ABI_EDITION : LIB_ABI},
      {path: 'lib/meta.ts', content: LIB_META},
      {path: 'app/globals.css', content: APP_GLOBALS},
      {path: 'app/layout.tsx', content: APP_LAYOUT},
      {path: 'app/page.tsx', content: APP_PAGE},
      {path: 'app/mint-client.tsx', content: isEdition ? APP_MINT_CLIENT_EDITION : APP_MINT_CLIENT},
      {path: 'README.md', content: readme(o)},
    ],
    steps: [
      'npm install',
      'npm run dev            # preview at http://localhost:3000',
      'npm i -g vercel && vercel --prod   # deploy (set the NEXT_PUBLIC_* vars in the Vercel dashboard)',
    ],
  };
}
