# Legacy source references

ABX tracks current work in GitHub Issues, not in a repository backlog. This file preserves one label
cited by deployed Solidity source comments; editing those comments would change compiler metadata and
CREATE2 creation bytecode without changing runtime behavior.

- **B22:** when a token implementation approaches the EIP-170 size limit, move coherent read/write
  surfaces into a delegatecalled library instead of weakening the size guard. The current extraction
  prescription is maintained under "Maintenance invariants" in `contracts/README.md`.

This is a compatibility note, not an active roadmap.
