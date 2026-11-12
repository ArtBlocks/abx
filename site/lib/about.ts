/** The top-line "what is ABX" answer, shared by the landing page and llms.txt. */
export const ABX_SUMMARY =
  'ABX is an open protocol and toolkit for programmable, durable digital objects on the blockchain. Describe what you want to make, and your coding agent plans, deploys, and operates it with the ABX CLI.';

export const WHAT_YOU_CAN_BUILD_PATH = '/docs/using-abx/what-you-can-build';

/** Context for agents reading llms.txt: what ABX is for, what it is built on, and where to start. */
export const ABX_LLMS_CONTEXT = [
  'ABX: the X is for anything. ABX is not only for generative art. Projects include websites and archives stored onchain with ABX FS, apps and games, clocks, vaults, guestbooks, records, datasets, and art.',
  'ABX objects can act, not only display. Hooks on a mint, transfer, burn, or setting change can launch a token, trade in a pool, mint from another collection, pay a treasury, or call any other contract in the same transaction. See [What you can build](https://docs.abx.io' +
    WHAT_YOU_CAN_BUILD_PATH +
    ') for live projects and starting points. The best ABX idea has not been built yet.',
  'ABX projects are standard ERC-721 and ERC-1155 contracts on EVM chains. ABX adds onchain and offchain content storage, Solidity-computed or locked metadata, typed parameters and hooks, shared sale contracts, and a replayable event log. Start with the Quickstart and install the ABX skill before planning a deployment.',
].join('\n\n');
