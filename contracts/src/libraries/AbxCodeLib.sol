// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {OnChainScriptStorage} from "./OnChainScriptStorage.sol";
import {DependenciesStorage} from "./DependenciesStorage.sol";
import {IAbxDependencies} from "../extensions/dependencies/IAbxDependencies.sol";

/// @title AbxCodeLib — the On-Chain Script + Dependencies write paths, as an EXTERNAL library
/// @notice The sibling of {AbxParamsLib}: deployed once per chain, `delegatecall`ed by every
///         token composing the code-custody extensions, so the chunk staging and list editing
///         live once instead of in every implementation (EIP-170 is the forcing function).
///         Storage writes hit the token's own ERC-7201 namespaces; events log from the token —
///         the spine is byte-identical to an inlined implementation.
/// @dev Access control stays in the mixins (`onlyOwner`); this library assumes its caller
///      already gated. Event declarations duplicate the extension interfaces' — same
///      signatures, same topics.
library AbxCodeLib {
    // ── event mirrors (identical signatures ⇒ identical topics) ────────────────
    event ScriptUpdated(uint256 index);
    event ScriptLocked();
    event DependencyUpdated(uint256 index, IAbxDependencies.Resolution resolution, bytes32 indexed ref);
    event DependencyRemoved(uint256 index);
    event DependencyRegistrySet(address indexed registry);
    event DependenciesLocked();
    /// @dev ERC-4906, re-declared (identical signature ⇒ identical topic). Every write below changes
    ///      what the on-chain generator assembles, and therefore what `tokenURI` resolves to for
    ///      EVERY token — a script chunk, a dependency, or the registry those dependencies resolve
    ///      through. None of them signalled that before, so a correctly-behaving indexer that
    ///      refreshes on ERC-4906 and otherwise trusts its cache served the pre-edit work
    ///      indefinitely. Emitted as a full-range batch because the script and dependency set are
    ///      collection-level: one edit moves every token at once. Matches what {AbxParamsLib}
    ///      already emits on a param write, so this is the existing signal reaching the surfaces it
    ///      had been skipping, not a new convention.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    error ScriptIsLocked();
    error ScriptIndexOutOfRange();
    error EmptyScriptChunk();
    error DependenciesAreLocked();
    error DependencyIndexOutOfRange();
    error EmptyDependencyRef();

    // ── on-chain script ─────────────────────────────────────────────────────--

    function setScriptChunk(uint256 index, bytes calldata chunk) public {
        OnChainScriptStorage.Layout storage l = OnChainScriptStorage.layout();
        if (l.locked) revert ScriptIsLocked();
        if (chunk.length == 0) revert EmptyScriptChunk();
        if (index > l.chunks.length) revert ScriptIndexOutOfRange();
        address ptr = SSTORE2.write(chunk);
        if (index == l.chunks.length) l.chunks.push(ptr);
        else l.chunks[index] = ptr;
        emit ScriptUpdated(index);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function removeLastScriptChunk() public {
        OnChainScriptStorage.Layout storage l = OnChainScriptStorage.layout();
        if (l.locked) revert ScriptIsLocked();
        uint256 len = l.chunks.length;
        if (len == 0) revert ScriptIndexOutOfRange();
        l.chunks.pop();
        emit ScriptUpdated(len - 1); // the removed index; count re-read tells the story
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function lockScript() public {
        OnChainScriptStorage.Layout storage l = OnChainScriptStorage.layout();
        if (l.locked) revert ScriptIsLocked();
        l.locked = true;
        emit ScriptLocked();
    }

    // ── dependencies ────────────────────────────────────────────────────────--

    function setDependency(uint256 index, IAbxDependencies.Resolution resolution, bytes32 ref)
        public
    {
        DependenciesStorage.Layout storage l = DependenciesStorage.layout();
        if (l.locked) revert DependenciesAreLocked();
        if (ref == bytes32(0)) revert EmptyDependencyRef();
        if (index > l.deps.length) revert DependencyIndexOutOfRange();
        DependenciesStorage.Dependency memory d =
            DependenciesStorage.Dependency(uint8(resolution), ref);
        if (index == l.deps.length) l.deps.push(d);
        else l.deps[index] = d;
        emit DependencyUpdated(index, resolution, ref);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function removeLastDependency() public {
        DependenciesStorage.Layout storage l = DependenciesStorage.layout();
        if (l.locked) revert DependenciesAreLocked();
        uint256 len = l.deps.length;
        if (len == 0) revert DependencyIndexOutOfRange();
        l.deps.pop();
        emit DependencyRemoved(len - 1);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function setDependencyRegistry(address registry) public {
        DependenciesStorage.Layout storage l = DependenciesStorage.layout();
        if (l.locked) revert DependenciesAreLocked();
        l.registry = registry;
        emit DependencyRegistrySet(registry);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function lockDependencies() public {
        DependenciesStorage.Layout storage l = DependenciesStorage.layout();
        if (l.locked) revert DependenciesAreLocked();
        l.locked = true;
        emit DependenciesLocked();
    }

    // ── reads ───────────────────────────────────────────────────────────────--
    // The `IAbxOnChainScript` and `IAbxDependencies` views, externalized from the mixins for the
    // same EIP-170 reason as the writes above, which also puts
    // each read next to the write it mirrors. Pure reads over the token's own namespaces; the extra
    // delegatecall hop rides the eth_call lane, never a gas-metered write path.
    //
    // **Signatures and return types here are the mixins' external ABI, verbatim.** The mixin shells
    // delegatecall this library with their raw calldata (same signature ⇒ same selector) and return
    // the raw return data — decoding + re-encoding at the call site costs more bytes than the bodies
    // ever saved — so any drift here is a silent ABI break on every composing token. Change these
    // only in lockstep with `IAbxOnChainScript`/`IAbxDependencies`.

    function scriptChunkCount() public view returns (uint256) {
        return OnChainScriptStorage.layout().chunks.length;
    }

    function scriptChunk(uint256 index) public view returns (bytes memory) {
        OnChainScriptStorage.Layout storage l = OnChainScriptStorage.layout();
        if (index >= l.chunks.length) revert ScriptIndexOutOfRange();
        return SSTORE2.read(l.chunks[index]);
    }

    function scriptLocked() public view returns (bool) {
        return OnChainScriptStorage.layout().locked;
    }

    function dependencyCount() public view returns (uint256) {
        return DependenciesStorage.layout().deps.length;
    }

    function dependencyByIndex(uint256 index)
        public
        view
        returns (IAbxDependencies.Resolution resolution, bytes32 ref)
    {
        DependenciesStorage.Layout storage l = DependenciesStorage.layout();
        if (index >= l.deps.length) revert DependencyIndexOutOfRange();
        DependenciesStorage.Dependency storage d = l.deps[index];
        return (IAbxDependencies.Resolution(d.resolution), d.ref);
    }

    function dependencyRegistry() public view returns (address) {
        return DependenciesStorage.layout().registry;
    }

    function dependenciesLocked() public view returns (bool) {
        return DependenciesStorage.layout().locked;
    }
}
