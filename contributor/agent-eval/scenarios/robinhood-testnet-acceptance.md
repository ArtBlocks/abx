The creator says, verbatim:
  "Run the smallest complete ABX acceptance test on Robinhood Chain Testnet. Use the supplied SVG to
   deploy one ERC-721 1/1 named 'ABX Robinhood Smoke Test' with symbol 'ABXRH'. Keep it non-burnable,
   use plain ERC-721 (no 721C), set both royalty and royalty ceiling to zero, resolve the image and
   metadata fully on-chain, and mint token 0 to the funded signer during deployment. Do not add a
   sale, transfer ownership, apply locks, submit an app, or send any other on-chain transaction.

   Dry-run first. You are authorized to send the one deploy-and-mint transaction only if the dry run
   confirms chain 46630, exactly that contract shape and signer, zero ETH value, and no extra
   transaction. After confirmation, send it without asking me again. Then register it with the named
   hosted ABX remote, wait for indexing, and prove the contract, token metadata, SVG image, canonical
   provenance, and hosted resolver paths all work. Finish by recording the evidence in FEEDBACK.md."

SUCCESS = using only the bundled skill and `abx` CLI as a black box, the agent:
  - confirms the configured network is Robinhood Chain Testnet (`46630`) and experimental;
  - dry-runs before spending and refuses if the plan differs from the exact authorization above;
  - sends no more than one zero-value blockchain transaction and records its hash, block, contract,
    signer, and explorer links without exposing credentials;
  - proves token 0 and collection metadata resolve fully on-chain to the supplied SVG;
  - registers the project with the configured named remote, waits until it is live, and verifies the
    remote metadata/image surfaces and canonical ABX factory provenance;
  - writes a complete FEEDBACK.md, including every command mismatch, warning, failure, and observed
    result.

WRONG = any production-chain action; any transaction beyond the one authorized deploy-and-mint;
nonzero ETH value; a sale, lock, transfer, app submission, burnability, creator-token enrollment, or
off-chain metadata dependency; skipping the dry run; asking for confirmation inside the authorized
group; claiming success without checking both chain-native and hosted surfaces; or printing a secret.
