// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {IAbxSeedSource} from "../interfaces/IAbxSeedSource.sol";

/// @title AbxSeedSource — the canonical pseudorandom seed source
/// @notice One shared, ownerless deployment per chain (its address lives in the deployment
///         manifest, the same shared-singleton trust model as the factories and renderer).
///         Derives a mint-time seed from the calling token, the token id, and block entropy.
///
/// @notice **Read this before you price scarcity off it.** The seed is **pseudorandom, derived
///         entirely from on-chain values**, and every one of those values is readable by any
///         contract *during the minting transaction*. It is therefore:
///         - **deterministic after the fact** — anyone can replay it from the block, which is what
///           makes generative output verifiable, and is the property this source exists for;
///         - **not secret before the fact** — a caller executing in the same transaction can
///           compute the seed a mint would receive, and can choose whether to complete that mint.
///
///         Concretely, that means a motivated buyer can decline outcomes they don't want (mint
///         inside a wrapper that reverts unless the result is favourable, paying only gas), and a
///         builder can reorder or omit transactions. **This source is not strong enough to settle
///         anything lottery-like** — a prize draw, a raffle, a mint where a rare outcome is worth
///         materially more than the mint price and the ordering is contestable.
///
///         It is well suited to generative work where the seed diversifies output and the
///         distribution, not any single outcome, is the product. If your project needs randomness
///         a buyer cannot foresee or refuse, **do not use this source** — point `seedSource` at
///         your own contract implementing {IAbxSeedSource} and back it with a commitment scheme
///         (commit at mint, resolve from a later block) or an off-chain VRF oracle. The seed
///         source is a per-project address precisely so that this is a swap, not a fork.
///
/// @dev Stateless and multi-tenant: `msg.sender` (the project contract) namespaces the seed, so
///      two projects minting the same id in the same block still differ.
///
///      **`to` is deliberately not in the preimage.** It used to be, and that was a mistake: `to`
///      is chosen by the buyer (`purchaseTo` names the recipient), which turned a caller-supplied
///      160-bit field into a search space — grind candidate recipients in a view loop, then buy
///      once at the winner, and select a rare outcome deterministically for the cost of gas.
///      Dropping it does not make the seed secret (see above), but it removes the cheap,
///      *targeted* search. A custom source is free to use `to`; if it does, it inherits that
///      grinding surface.
///
///      **"Accept-or-decline, not choose" is the ERC-721 statement, and only that.** A 721 mint
///      takes the next sequential id, so a buyer does not select any preimage input. An
///      `EditionCode` buyer NAMES the id they mint, and `tokenId` is still in the preimage — so on
///      the edition lane a buyer can search the unminted ids for the outcome they prefer, bounded by
///      how many remain rather than by a 160-bit field. That is much weaker than recipient
///      grinding and it is inherent to letting a buyer pick their copy, but it is a different
///      statement and it is stated separately here rather than implied away.
contract AbxSeedSource is IAbxSeedSource {
    /// @inheritdoc IAbxSeedSource
    /// @dev `to` is accepted (the interface's shape, and useful to curated/commit-reveal sources)
    ///      and intentionally unused here — see the class note.
    function seed(uint256 tokenId, address /* to */ ) external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                msg.sender, tokenId, block.prevrandao, blockhash(block.number - 1), block.timestamp
            )
        );
    }
}
