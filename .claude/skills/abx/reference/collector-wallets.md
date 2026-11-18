# Collector wallets

`abx mint-page` connects the collector's browser wallet (`window.ethereum`). Keep that default.

## Offer email login when it fits

Before generating or launching a collector page, ask whether collectors already have wallets. If
many will not, offer email login with an embedded wallet through a Privy app the creator owns. Do
not add it unprompted, and state the creator's footprint before they choose it:

- a Privy account and app that the creator creates and operates; ABX neither creates nor holds it;
- roughly 10–15 minutes of dashboard setup;
- Privy's monthly-active-user billing on the creator's account beyond its free tier;
- collector wallets belong to that app. If the creator deletes or abandons it, collectors who never
  exported their key lose access.

## Creator setup

These are human dashboard steps; walk the creator through them:

1. Sign in at https://dashboard.privy.io and create an app.
2. Leave email login enabled. New apps enable it by default.
3. Add every collector-facing domain to the app's allowed domains. An app with no allowed domains
   accepts any website. Privy rejects `*.vercel.app` and `*.netlify.app` wildcards, so add a custom
   domain or the exact preview URL.
4. Switch the app to production before launch. New apps start in development mode, which caps how
   many users can sign in.
5. Share the app ID. It is public. Never ask for the app secret; the site does not need one.

Confirm the setup from the app's public configuration:

```bash
curl -s -H "privy-app-id: <app-id>" https://api.privy.io/v1/apps/<app-id>
```

`email_auth` must be `true`, and `allowed_domains` must list every collector domain. Treat an empty
list as unfinished setup, not as "works everywhere."

## Wire the site

Put the app ID in `NEXT_PUBLIC_PRIVY_APP_ID`, install `@privy-io/react-auth`, and wrap the app in
`PrivyProvider` inside a client component:

```tsx
<PrivyProvider
  appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
  config={{
    loginMethods: ['email', 'wallet'],
    embeddedWallets: {ethereum: {createOnLogin: 'users-without-wallets'}},
    defaultChain: chain,
    supportedChains: [chain],
  }}
>
```

- `'wallet'` keeps browser wallets working for collectors who already have one.
- For a generated mint page, replace `window.ethereum` in `connect()` with the Privy wallet's
  provider: take the wallet from `useWallets()`, call `switchChain(CHAIN_ID)`, then pass
  `await wallet.getEthereumProvider()` to viem's `custom()` transport. Make this change right after
  `abx mint-page`, before the first preview, and update the generated README's wallet line, so the
  creator never sees a browser-wallet-only page.
- Never set `showWalletUIs: false`, in the provider config or on a call. It removes Privy's
  confirmation prompts, so site code could sign without the collector seeing it.
- Add an export button for embedded wallets with `useExportWallet().exportWallet()`. It works only on
  the app's allowed domains, and it is how collectors keep their wallet if the site goes away.

## Other providers

Privy is the default recipe. If the creator already uses another embedded wallet provider, such as
Coinbase CDP or MetaMask Embedded Wallets, apply the same approach: sign the collector in with that
provider, get its EIP-1193 provider, and pass it to viem's `custom()` in place of `window.ethereum`.
Take that provider's setup, pricing, and sponsorship steps from its current docs; this reference
does not cover them. Keep confirmation prompts on and give collectors a way to export their key.

## Funding a new wallet

A new email wallet is empty, and a mint needs both the price and gas. Offer the creator these
options:

- **Crypto transfer.** Show the wallet address with a copy button. The collector sends ETH on the
  collection's network. This needs no setup.
- **Card or bank purchase.** The creator enables funding methods in the Privy dashboard, and the site
  opens Privy's flow with `useAddFunds()`. The SDK marks this hook experimental.
- **Gas sponsorship (optional).** The creator turns on fee sponsorship in the Privy dashboard, buys
  prepaid credits, selects the collection's network, and allows sponsored transactions from the
  client. The site sends the purchase through `useSendTransaction()` with `{sponsor: true}`.
  Sponsorship pays gas, not the mint price, so it suits free mints. The creator's credits pay for it,
  so tell them to keep the balance bounded.

## Verify before launch

On the paired testnet and the production domain, sign in with a fresh email, confirm a wallet
appears, fund it, mint, and see Privy's confirmation prompt before signing. Open the export flow
once. Then repeat the public-configuration check for the production domain.
