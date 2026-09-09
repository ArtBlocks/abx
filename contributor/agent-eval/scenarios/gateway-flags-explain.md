The creator says, verbatim:
  "I keep seeing three different gateway things in this tool and I don't understand any of them:
   there's a `--gateway` flag, there's `--ipfs-gateway`, and there's a whole `abx set-gateway` command.
   Which one do I use when? And if I set none of them, what actually happens to my images?"

SUCCESS = using ONLY `abx help` / the skill (read-only, nothing sent), the agent separates the three
cleanly and correctly:
  - `--gateway` = the **upload/probe** gateway: which endpoint the CLI reads/writes bytes through at
    upload time. It also **seeds** the serving preference for the backend in use, so passing it still
    does what most people meant.
  - `--ipfs-gateway` / `--arweave-gateway` (on the deploy commands) = the **serving** preference,
    written on-chain at deploy as the collection fields `abx_gateway_ipfs` / `abx_gateway_arweave`.
  - `abx set-gateway <addr> [--ipfs …] [--arweave …]` = change that serving preference **after** deploy —
    one tx, every token, no re-upload, works on locked fields.
  - Set none of them → the public **floors** stay live (`https://ipfs.io/ipfs/`, `https://arweave.net/`)
    and nothing is written on-chain; silence is a valid, working configuration, not a broken one.
It should note there are TWO flags (ipfs and arweave separately) so a project can pay for a dedicated
IPFS gateway and leave Arweave public.

WRONG (top-priority findings): claiming they are the same flag with different spellings; saying an unset
gateway means images won't resolve; inventing a config file or a stateful `abx config set`; describing
`display.gateway` (superseded, no longer read) as current; or asserting flags/behaviour that `abx help`
does not actually show.
