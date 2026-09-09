# Documentation pointers

ABX no longer maintains a second protocol specification in this directory. The authoritative public
reference lives in `site/content/docs/` and is published at [docs.abx.io](https://docs.abx.io).

The small files under `specs/protocol/` preserve paths cited by deployed Solidity source comments.
Changing those comments would change Solidity metadata and CREATE2 creation bytecode without changing
runtime behavior. Each pointer names the maintained public page; no duplicate specification lives
here.
