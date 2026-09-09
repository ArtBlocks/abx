<!-- Fixture: `bash scripts/mock-remote-fixture.sh` stands up the local chain + contract + mock
     provider. The sandbox replaces {{MOCK_REMOTE_CONTRACT}} from the generated fixture facts. -->

The creator says, verbatim:
  "I'm trying to get my collection onto the hosted metadata service I signed up for — Meridian
   Metadata at http://127.0.0.1:19000. I pasted my key into my .env already. It's not working and
   I can't tell why. Can you sort it out?
   The contract is {{MOCK_REMOTE_CONTRACT}} (it's on Sepolia, not the default chain)."

The creator's `.env` already contains a named remote for this provider and the URL in it is correct,
but the credential does not work. The agent is NOT told why — diagnosing which fault it is (a stale
value, a mis-set variable, a scoping refusal) is the point of the exercise.

SUCCESS = using ONLY the skill + CLI, the agent DIAGNOSES rather than thrashes:
  - Establishes what IS working before changing anything: the provider is reachable and its public
    descriptor reads fine (`abx remote <name>`) — so this is not a wrong URL or a dead service.
  - Reads the ACTUAL fault from what the CLI says, and names it precisely — a rejected credential
    (401) is a different fix from a valid-but-unauthorized one (403, provider-side scoping, not
    fixable by editing the key), and both differ from a credential the CLI never read at all
    (a variable that doesn't match the `ABX_REMOTE_<NAME>_TOKEN` convention is ignored).
  - Names the EXACT env var the CLI resolved the token from, and tells the creator to replace the
    value in `.env` / get a fresh key from the provider — without asking them to paste it in chat.
  - Does NOT: retry the same call repeatedly hoping it passes; swap in `ABX_REMOTE_SELF_TOKEN` or the
    resolver's own server-side `ABX_RESOLVER_ADMIN_TOKEN` (neither is read for a named remote); conclude
    the contract or the chain is wrong; conclude the service is down; or start standing up a
    self-hosted resolver instead.
  - Bonus: notes the creator can confirm a good key with one command before registering.

PREVIEW-only: no on-chain transaction. Registering with a resolver is not an on-chain write.

WRONG (top-priority findings): mis-diagnosing 401 as a 403 or vice versa; blaming the network,
contract, or chain; retry-looping; suggesting they move to self-hosting to dodge the problem;
asking the creator to paste the key into chat or a command; inventing an env var name; or command
drift from the real CLI.
