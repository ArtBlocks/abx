// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";
import {OneOfOneEdition} from "../tokens/OneOfOneEdition.sol";

/// @title OneOfOneEditionFactory — canonical clone factory & trust anchor
/// @notice Deploys {OneOfOneEdition} as immutable EIP-1167 clones of a single, factory-owned
///         implementation. The factory is *ownerless* — it has no admin keys and cannot upgrade
///         or alter any clone — so there is nothing to rug. Every clone runs identical, fixed
///         code; the only power is the clone owner's (accepted: ABX contracts are owned).
///
/// @dev Trust model: identical to {OneOfOneImageFactory} — the trust root is this factory's
///      address (platforms allowlist it); EIP-1167 guarantees every clone runs the fixed,
///      canonical implementation code; this factory is the only writer of `isAbxClone`, and is
///      itself immutable + ownerless, so trusting that mapping is exactly trusting the factory
///      (verified once). The `AbxDeployed` beacon is spoofable — any contract can emit it — so it
///      powers only open discovery, never trust.
///
///      Verify membership via `isAbxClone(addr)` (on-chain) or by indexing `Deployed`. A new core
///      version ships as a new implementation + new factory; old clones stay frozen on their version.
contract OneOfOneEditionFactory {
    /// @notice The canonical implementation every clone delegates to (immutable).
    address public immutable implementation;

    /// @notice True for addresses this factory deployed.
    mapping(address => bool) public isAbxClone;

    /// @notice A canonical clone was deployed and initialized.
    event Deployed(address indexed clone, address indexed implementation, address indexed owner);

    /// @notice A salt reserved an address to a specific deployer, and the caller isn't it.
    error SaltSenderMismatch();

    constructor() {
        // Deploy the one implementation; its constructor disables initializers,
        // so the master copy can never be initialized or hijacked.
        implementation = address(new OneOfOneEdition());
    }

    /// @notice Deploy a new 1/1 edition NFT.
    function deploy(OneOfOneEdition.InitParams calldata params) external returns (address clone) {
        clone = LibClone.clone(implementation);
        _initAndRegister(clone, params);
    }

    /// @notice Deploy at a deterministic, pre-computable address.
    /// @dev The clone address is a pure function of (this factory, `salt`) — *not* the caller —
    ///      so it can be predicted and its on-chain URIs baked before anyone signs. Front-running
    ///      is governed by the salt's leading bytes; see {_guardSalt}. Re-using a salt reverts
    ///      (the address already has code).
    function deployDeterministic(OneOfOneEdition.InitParams calldata params, bytes32 salt)
        external
        returns (address clone)
    {
        _guardSalt(salt);
        clone = LibClone.cloneDeterministic(implementation, salt);
        _initAndRegister(clone, params);
    }

    /// @notice Address {deployDeterministic} would produce for `salt` (caller-independent).
    function predictDeterministicAddress(bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddress(implementation, salt, address(this));
    }

    function _initAndRegister(address clone, OneOfOneEdition.InitParams calldata params) internal {
        // Register AFTER `initialize` returns. Initialization makes one external call — to the
        // owner-supplied transfer validator — and during that callback the clone would otherwise
        // already read as canonical to any integration that treats `isAbxClone` as "fully set up",
        // while deploy-time mints and `Deployed` have not happened yet. No present invariant break
        // was found (caps are written before the callback, and the validator is owner-chosen), but
        // the ordering costs nothing and removes the window.
        OneOfOneEdition(clone).initialize(params);
        isAbxClone[clone] = true;
        emit Deployed(clone, implementation, params.owner);
    }

    /// @dev The salt's leading 20 bytes are an access guard (the 0age / CreateX convention):
    ///      all-zero ⇒ permissionless (anyone may deploy to this address); non-zero ⇒ must equal
    ///      `msg.sender`, so only the reserver can land their params there — front-running
    ///      protection for a pre-computed address. The guard is account-type agnostic: an EOA, an
    ///      ERC-4337 smart account, or a Safe all present as `msg.sender` here, so naming any of
    ///      them in the salt just works (no ERC-2771 / signature plumbing needed).
    function _guardSalt(bytes32 salt) internal view {
        // taking the leading 20 bytes as the guard address is the intended truncation.
        // forge-lint: disable-next-line(unsafe-typecast)
        address guard = address(bytes20(salt));
        if (guard != address(0) && guard != msg.sender) revert SaltSenderMismatch();
    }
}
