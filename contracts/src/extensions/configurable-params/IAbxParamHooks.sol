// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title Param lifecycle hooks — the three addresses a project may wire (all optional)
/// @notice Behavior is the implementation's; effects ride the spine. The token stores addresses
///         only (`HooksConfigured`); these interfaces are the calling conventions.

/// @notice Write-time hook: called by the token inside a schema-governed configure, BEFORE the
///         value persists. Reverting **vetoes** the write — this is the validator slot.
interface IAbxConfigureHook {
    /// @param tokenId    the token whose param is being configured
    /// @param key        the param key (readable-ASCII `bytes32`)
    /// @param value      the literal `bytes32` on the scalar path; `keccak256(data)` on the blob path
    /// @param updatedBy  the original external caller (delegatecall preserves `msg.sender`)
    /// @param dataLength `0` on the scalar path; `data.length` on the blob path. **Never `0` on the
    ///                   blob path** — an empty value is refused before this call — so this is a
    ///                   reliable discriminator between the two.
    /// @param dataBlobAddress `address(0)` on the scalar path; on the blob path, the Solady SSTORE2
    ///                   pointer holding THIS write's bytes, already deployed and readable.
    ///
    /// @dev **Two shapes, one function.** A scalar (`Bool`/`Select`/`HexColor`/range/timestamp) write
    ///      passes its whole value in `value` and zeroes the last two arguments. A `String`/`Bytes`
    ///      write cannot: the value is a blob, so `value` carries only its hash. `dataLength` and
    ///      `dataBlobAddress` are what make that shape inspectable.
    ///
    ///      **Why an address and not the bytes.** A blob can be nearly a full contract's worth of
    ///      data, and forwarding it would put that in the calldata of every configure call whether
    ///      the hook looks at it or not (~16 gas per non-zero byte, paid by the writer). Passing the
    ///      pointer costs one word. A hook that only enforces a size ceiling reads `dataLength` and
    ///      never touches the blob; a hook that needs the content calls
    ///      `SSTORE2.read(dataBlobAddress)` and pays for exactly what it wanted.
    ///
    ///      **The guaranteed invariant:** `keccak256(SSTORE2.read(dataBlobAddress)) == value`. Same
    ///      pointer layout `tokenParamData` returns, so a hook reads it the same way. Do NOT `CALL`
    ///      the pointer — SSTORE2 prefixes a `STOP`, so it is data wearing a contract's clothes.
    ///
    ///      **`tokenParamData(tokenId, key)` still returns the OLD value during this call**, because
    ///      nothing has persisted yet — that is what "BEFORE the value persists" means, and it is a
    ///      feature: a hook can compare the incoming blob against the outgoing one and veto a
    ///      regression. The new bytes exist ONLY at `dataBlobAddress` until this call returns.
    ///
    ///      **Cost of a veto, stated so it is not a surprise.** The blob is written before this call —
    ///      it has to be, or the pointer would name a contract that does not exist yet, and reading
    ///      it would be worse than useless (`extcodesize` of an empty account minus one underflows
    ///      into a huge length). So a hook that rejects a write rejects it *after* the writer paid to
    ///      store the bytes. On the accepted path the cost is unchanged — the blob is written once
    ///      either way. Only rejection wastes, it wastes only the rejected writer's own gas, and a
    ///      dry run (`eth_call`) surfaces the rejection for free beforehand.
    function onParamConfigured(
        uint256 tokenId,
        bytes32 key,
        bytes32 value,
        address updatedBy,
        uint256 dataLength,
        address dataBlobAddress
    ) external;
}

/// @notice Transfer hook: called by the token after every ownership change (mint = transfer from
///         `0x0`, burn = transfer to `0x0`). The mechanism for owner-dependent output — it may
///         persist/derive params (the token exposes no special path; the hook acts through its
///         own authority). **A VETO**: its revert bubbles and the transfer (or mint) fails. The
///         token used to swallow reverts and promise the lifecycle could never block a transfer,
///         which was not keepable — Solady runs the receiver acceptance check after this call, so on
///         `safeTransferFrom` a hook could starve it regardless. A creator who wants no such power
///         sets no transfer hook; a creator who wants to prove they will never gain one calls
///         `lockParamHooks()` before selling, and a buyer verifies with `paramHooks()`.
interface IAbxTransferHook {
    /// @param tokenId  the 721 token, or the 1155 id whose balance moved
    /// @param from     `address(0)` on mint
    /// @param to       `address(0)` on burn
    /// @param operator the caller that initiated the move — the holder itself, an approved
    ///                 operator, or a minter. NOT redundant with `from`: on ERC-1155 an approved
    ///                 marketplace moves a holder's copies, and a hook that cares who acted needs
    ///                 to see it.
    /// @param amount   copies moved. Always 1 on ERC-721.
    ///
    /// @dev **Implementations that mutate state MUST authenticate `msg.sender` as the expected
    ///      token contract.** This callback is an ordinary external function: anyone can call it
    ///      directly with forged `from`, `to`, `operator`, and `amount` values. Constructor-pin the
    ///      token address (as the canonical `TransferCounterHook` does), or enforce an equivalent
    ///      allowlist when one hook intentionally serves multiple token contracts.
    ///
    /// @dev `operator` and `amount` exist because without them a hook on a shared-supply ERC-1155
    ///      cannot tell a real transfer from a no-op. Adversarial review showed the consequence:
    ///      Solady permits `safeTransferFrom(from, to, id, 0, "")` from any caller who owns nothing,
    ///      so a stranger could fire the lifecycle for an id they hold no copy of, and a hook that
    ///      stored "the most recent mover" would rewrite shared params for every real holder. The
    ///      token now refuses to notify on zero-amount and self-transfers, and these two arguments
    ///      let a hook apply its own policy on top.
    ///
    ///      **Think carefully before storing per-id state from this on a multi-copy edition.**
    ///      Params are per id and therefore SHARED across every holder of that id, so a hook that
    ///      writes "the current owner" is really writing "whoever moved most recently" — and it
    ///      changes the work for all of them. Aggregate or monotonic state (transfer counts, "has
    ///      ever been held by") is coherent there; a single-owner notion is not, unless the edition
    ///      size is 1.
    function onTokenTransfer(
        uint256 tokenId,
        address from,
        address to,
        address operator,
        uint256 amount
    ) external;
}

/// @notice Read-time hook: ephemeral derivation at view time, no event, no storage. Consumed by
///         renderers and resolvers when assembling `tokenData` — never called by the token
///         itself, so its shape costs the token nothing. It may **add** keys and **override**
///         stored ones (augment wins per key); return data is bounded only by `eth_call`
///         limits, so this is the lane for large *derived* data (the stored-param blob ceiling
///         doesn't apply to compute). Chain-derived but not log-foldable: reconstructors
///         resolve it as a head read, like `tokenURI` strings.
/// @dev Keys are readable-ASCII `bytes32` — the system-wide key type (stores, event topics).
///      Values are the **final canonical string** exactly as `tokenData` carries it (augmented
///      keys have no schema, so no type can disambiguate later — the hook resolves it up
///      front): a hook injecting binary base64-encodes it itself (free — view context only).
///      Raw, not JSON-escaped: escaping is the serializer's single job, same as stored values.
///      This keeps serialization one deterministic path — which `inputsHash` depends on.
interface IAbxAugmentHook {
    struct AugmentedParam {
        bytes32 key; // readable-ASCII, like stored param keys; reserved tokenData keys rejected
        string value; // the final canonical string (binary ⇒ hook base64s); serializer escapes
    }

    function augmentTokenParams(address token, uint256 tokenId)
        external
        view
        returns (AugmentedParam[] memory);
}
