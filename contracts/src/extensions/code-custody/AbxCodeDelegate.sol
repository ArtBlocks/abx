// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {AbxCodeLib} from "../../libraries/AbxCodeLib.sol";

/// @title AbxCodeDelegate — the raw-calldata read passthrough into {AbxCodeLib}
/// @notice Shared base of the two code-custody mixins ({OnChainScript}, {Dependencies}), which are
///         always composed together and always by a token that already links {AbxCodeLib}. It
///         exists so the passthrough plumbing is compiled into the token **once** instead of once
///         per mixin.
/// @dev Why a raw passthrough and not a typed shell: B22 step 1 measured a typed shell
///      (`return AbxCodeLib.f(...)`) *growing* the token, because decoding the library's return
///      value and re-encoding it at the call site costs more bytes than the extracted body saves.
///      Forwarding the calldata verbatim and returning the return data untouched costs a fixed ~2
///      dozen bytes per view instead. The price is that **{AbxCodeLib}'s read signatures are part
///      of every composing token's external ABI** — same signature ⇒ same selector is the whole
///      mechanism — so they must track `IAbxOnChainScript`/`IAbxDependencies` verbatim.
abstract contract AbxCodeDelegate {
    /// @dev Delegatecalls {AbxCodeLib} with this call's exact calldata — the library declares the
    ///      same signature, so the selector dispatches there — and returns the library's return
    ///      data untouched, since it already encodes this function's exact return ABI. Storage
    ///      resolves in this token's ERC-7201 namespaces, which is what `delegatecall` buys.
    ///      Every target is a view, but the mutability checker flags any raw `delegatecall`, so the
    ///      pointer cast below launders it — a runtime no-op (internal function pointers are bare
    ///      jump destinations). Never returns.
    function _delegateCodeRead() internal view {
        function() internal fn = _delegateCodeReadRaw;
        function() internal view viewFn;
        assembly {
            viewFn := fn
        }
        viewFn();
    }

    /// @dev The raw forward. Non-view only because assembly `delegatecall` is always flagged.
    function _delegateCodeReadRaw() private {
        address lib = address(AbxCodeLib);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), lib, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
