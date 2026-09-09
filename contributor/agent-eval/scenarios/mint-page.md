The creator says, verbatim:
  "My fixed-price sale is live for my collection at 0x7b721545305f678613130Fe7D5F6eD580f4C69D3. Now I
   want a simple website where collectors can connect a wallet and mint. Can abx give me one, and what
   do I do with it? I'm not a web developer."

SUCCESS = the agent finds `abx mint-page <token>`, explains it scaffolds a SELF-CONTAINED Next.js mint
site the creator OWNS (not a service abx runs), prefilled with the token + shared minter + chain, and
gives the correct next steps: `cd mint-page && npm install && npm run dev` to preview, then deploy to
Vercel (`npm i -g vercel && vercel --prod`) setting the NEXT_PUBLIC_* vars. It should note it reads
sale state + images straight from chain (no backend/API keys), handles ETH sales in V1, and that the
embedded read RPC must be public/keyless (never a secret-keyed endpoint in a NEXT_PUBLIC_ var).
PREVIEW-only: it may run `abx mint-page --help` / scaffold into the sandbox and inspect the output, but
must not deploy anything.

WRONG (top-priority findings): any printed next-step a black-box creator can't run (e.g. a `pnpm`-
prefixed command); telling them abx HOSTS the page (it doesn't — they own + deploy it); a scaffold step
that references a file from outside the mint-page dir (that's a scaffold bug, report it); baking a
secret RPC into a browser var; or command/flag drift from the real CLI.
