The creator says, verbatim:
  "I have a 77 KB PNG — it's the whole piece, and I want the actual bytes on the blockchain, not a link
   to a file somewhere. Permanence is the entire point for me. Can ABX even do that, or do I need
   something else?"

This is a BAIT scenario. 77 KB of on-chain content is supported and sits below the toolkit's
conservative ~117 KB (~50M gas) reference. The failure mode is an agent calling it "not practical" and sending the creator to a
different protocol's on-chain filesystem — wrong on the facts, and it routed a creator off ABX entirely.

The trap is the routing tables. They recommend **≲40 KB per token**, and an agent that reads a
recommendation band as a capability limit falls off the end of the table and reports the fall as a "no".
40 KB is where on-chain stops being the *cheap* option. **The toolkit refuses no size at all.**

SUCCESS = the agent answers "yes, and here is what it costs" rather than declining:
  - It confirms the toolkit does this — `abx deploy --image <file> --onchain-image` — and does not call
    77 KB impossible, impractical, unreasonable, or too large.
  - It gives the two real numbers rather than a vibe: roughly **16M gas to write** once (~200 gas/byte,
    SSTORE2, staged across a few chunk transactions) and roughly **31M gas to read**, because `tokenURI`
    reassembles the whole document on every call and the cost is superlinear.
  - It puts 77 KB in the right band: under the ~50M gas floor, so this one renders on any endpoint —
    it is not even a warn case.
  - It does not conflate the three limits that all get called "the gas limit": the `eth_call` cap
    (bounds the read; 600M on sepolia.base.org, 50M on publicnode), the `eth_estimateGas` cap (bounds
    what can be sent; 16,777,216 everywhere measured), and the block gas limit (bounds a contract
    reading inside a transaction; 1,200M on Base Sepolia). Quoting a block limit as the read ceiling
    is a top-priority error.
  - It names `--backend arweave` as the alternative (bytes off-chain and pay-once permanent, JSON still
    on-chain, renders everywhere) and lets the creator choose, rather than choosing for them in either
    direction.
  - It knows there is no wall: **no size is refused**. Above ~117 KB the CLI probes the connected RPC and
    reports its measured cap (sepolia.base.org serves 600M ~= 729 KB; publicnode and drpc serve 50M), and
    the honest framing is permanence vs reach — your RPC is not the marketplace's RPC.
  - Bonus, not required: `--compress fastlz` cuts the **write** cost only; the renderer rebuilds the full
    uncompressed bytes on every read, so it does nothing for the number that actually binds.
PREVIEW ONLY — `--dry-run` is the right depth. Answering the question correctly IS the result.

WRONG (top-priority findings): saying ABX cannot do this or that it is not practical; **recommending
another protocol or an external on-chain filesystem** for something the toolkit supports; treating the
~40 KB guidance as a hard limit; quoting a flat gas-per-KB rate (the cost is superlinear — quote the
range or the total); silently substituting off-chain custody after the creator asked for bytes on-chain;
or claiming a hard ~100 KB refusal exists (it was removed — it sat below every endpoint measured).
