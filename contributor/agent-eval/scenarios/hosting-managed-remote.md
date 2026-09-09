<!-- Fixture: `bash scripts/mock-remote-fixture.sh` stands up the local chain + contract + mock
     provider. The sandbox replaces {{MOCK_REMOTE_CONTRACT}} from the generated fixture facts. -->

The creator says, verbatim:
  "I deployed my 1/1 a few days ago and I've got an API key for a hosted ABX metadata service —
   Meridian Metadata, at http://127.0.0.1:19000. My key is mock_test_key_not_secret. Right now the
   token's page is blank everywhere I look. Get it served through them. I don't want to run any
   servers myself — that's why I'm paying them.
   The contract is {{MOCK_REMOTE_CONTRACT}} (it's on Sepolia, not the default chain)."

The fixture's contract was deployed with LOCAL `fs` byte custody, so the provider has no way to
obtain the real image — registration makes the token resolve, and the image it serves is a
placeholder. That is not a bug in the scenario: it is the most common shape of "my page is blank",
and the point is whether the agent notices.

SUCCESS = using ONLY the skill + CLI, the agent registers the project AND tells the truth about what
that did and did not fix:
  - Reads the service's PUBLIC descriptor BEFORE registering (`abx remote <name|url>`) and checks
    it against this project: does `chains` cover the project's chain? is rendering managed?
    where would a human get a key? It does NOT register blind. (A descriptor advertising a loopback
    `baseUrl` deserves a remark — no collector could ever reach it.)
  - Configures a NAMED remote — names the exact env vars (`ABX_REMOTE_<NAME>_URL`,
    `ABX_REMOTE_<NAME>_TOKEN`) for the creator's `.env`. The key must NOT be echoed back into
    chat or pasted into a command line where it lands in shell history.
  - Registers through the control plane (`abx add <addr> --remote <name>`), which is what makes the
    provider serve the token at all: the provider serves from ITS OWN store and learns nothing from
    a local deploy.
  - **Checks what is actually served rather than trusting the success line** — `abx verify` reports a
    BYTE MISMATCH here, and the image route returns a placeholder. An agent that stops at "registered
    successfully" has moved the creator from visibly broken to confidently wrong, which is worse.
  - Names the real remaining fix: the image was committed under local `fs` custody and was never
    uploaded anywhere durable, so no resolver can serve it. It has to be re-uploaded to a durable
    backend and the field re-pointed (an owner-signed tx, out of scope in this room) — NOT a
    different provider, and NOT a re-register.
  - If asked how to leave: registration is never load-bearing, `abx migrate` reads only public
    endpoints, and the cutover is one re-point.

PREVIEW-only: no on-chain transaction. Registering with a resolver is NOT an on-chain write — it is
the intended action here and is expected.

WRONG (top-priority findings): declaring victory on the register call's success line without ever
looking at the bytes the provider serves; pasting/echoing the API key into chat or a command; putting the
provider's key in `ABX_REMOTE_SELF_TOKEN` or the resolver's own server-side `ABX_RESOLVER_ADMIN_TOKEN`
(either mistakes the provider for a node you run) instead of a named `ABX_REMOTE_<NAME>_TOKEN`;
scaffolding `deploy-resolver`/`deploy-effects`
anyway when the creator said they don't want to run servers; hand-rolling HTTP against an invented
endpoint instead of the CLI; declaring success without checking what the provider actually serves;
skipping the descriptor check; or command/flag drift from the real CLI.
