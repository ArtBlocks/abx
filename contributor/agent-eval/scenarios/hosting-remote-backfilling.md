<!-- Fixture: `bash scripts/mock-remote-fixture.sh` stands up the local chain + contract + mock
     provider, then run a SECOND provider that always defers catch-up (the 202 lane):
       ABX_RPC_URLS_SEPOLIA=http://localhost:8545 ABX_REGISTER_DEADLINE_MS=1 \
         node --import tsx scripts/mock-remote-service.mts --port 19100 --chain sepolia --key <key>
     The sandbox replaces {{MOCK_REMOTE_CONTRACT}} from the generated fixture facts. -->

The creator says, verbatim:
  "I've got a hosted ABX metadata service — Meridian Metadata at http://127.0.0.1:19100, my key is
   mock_test_key_not_secret. I registered my contract with them earlier today and their dashboard
   said something about 'backfilling'. Is my project actually going to show up, or is it stuck?
   Should I re-register it? It's been sitting there and I'm nervous I've broken something.
   The contract is {{MOCK_REMOTE_CONTRACT}} (testnet)."

SUCCESS = using ONLY the skill + CLI, the agent treats a deferred catch-up as normal progress and
proves the outcome instead of guessing:
  - ASKS THE SERVICE where it got to, rather than reasoning about it — the indexing status for this
    project on that provider — and reports the lifecycle state in the service's own vocabulary.
  - Explains what the state means for the creator: a registration is durable once accepted, so
    `queued`/`backfilling` means *wait*, not *broken*; `live` means done; `stale` is still serving;
    `failed` carries a machine-readable cause and is retried.
  - Answers "should I re-register?" correctly: NO as a remedy for a backfill in progress (a re-POST
    does not start a second replay and does not make it faster). Registering again is only for
    bridging changed off-chain data.
  - Confirms the end state with a real read (the project reaches `live`, and/or the provider actually
    serves the token JSON now) rather than asserting it will be fine.
  - If the state were `failed`, distinguishes a cause that is the PROVIDER's to fix (their chain RPC
    unavailable / rate-limited — not the creator's key, address, or chain) from one the creator can
    act on (wrong address/chain).

PREVIEW-only: no on-chain transaction. Reading a provider's status and registering with a resolver are
not on-chain writes.

WRONG (top-priority findings): telling the creator the add failed or was lost; re-registering (or
looping registrations) to "kick" a backfill; blaming the key, the contract, the chain, or the network
for a normal `backfilling`; standing up a self-hosted resolver to dodge it; hand-rolling HTTP against
an invented endpoint instead of the CLI; declaring it fixed without a read that shows the end state;
or command/flag drift from the real CLI.
