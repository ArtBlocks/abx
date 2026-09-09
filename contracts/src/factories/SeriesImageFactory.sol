// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";
import {SeriesImage} from "../tokens/SeriesImage.sol";

/// @title SeriesImageFactory — canonical clone factory & trust anchor for Series
/// @notice Deploys {SeriesImage} as immutable EIP-1167 clones of a single, factory-owned
///         implementation. The factory is *ownerless* — no admin keys, cannot upgrade or alter
///         any clone — so there is nothing to rug. Every clone runs identical, fixed code; the
///         only power is the clone owner's. The exact sibling of {OneOfOneImageFactory}; the two
///         are distinct trust roots (one implementation each), both allowlisted by platforms.
///
/// @dev Trust model: the trust root is this factory's address. EIP-1167 guarantees every clone
///      runs the fixed canonical implementation; this factory is the only writer of `isAbxClone`
///      and is itself immutable + ownerless, so trusting that mapping is exactly trusting the
///      factory (verified once). The `AbxDeployed` beacon is spoofable — it powers open
///      discovery, never trust. Verify membership via `isAbxClone(addr)` or by indexing
///      `Deployed`. A new core version ships as a new implementation + new factory; old clones
///      stay frozen on their version.
contract SeriesImageFactory {
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
        implementation = address(new SeriesImage());
    }

    /// @notice Deploy a new Series NFT.
    function deploy(SeriesImage.InitParams calldata params) external returns (address clone) {
        clone = LibClone.clone(implementation);
        _initAndRegister(clone, params);
    }

    /// @notice Deploy at a deterministic, pre-computable address.
    /// @dev The clone address is a pure function of (this factory, `salt`) — *not* the caller —
    ///      so it can be predicted and its on-chain URIs baked before anyone signs. Front-running
    ///      is governed by the salt's leading bytes; see {_guardSalt}. Re-using a salt reverts.
    function deployDeterministic(SeriesImage.InitParams calldata params, bytes32 salt)
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

    function _initAndRegister(address clone, SeriesImage.InitParams calldata params) internal {
        // Register AFTER `initialize` returns. Initialization makes one external call — to the
        // owner-supplied transfer validator — and during that callback the clone would otherwise
        // already read as canonical to any integration that treats `isAbxClone` as "fully set up",
        // while deploy-time mints and `Deployed` have not happened yet. No present invariant break
        // was found (caps are written before the callback, and the validator is owner-chosen), but
        // the ordering costs nothing and removes the window.
        SeriesImage(clone).initialize(params);
        isAbxClone[clone] = true;
        emit Deployed(clone, implementation, params.owner);
    }

    /// @dev The salt's leading 20 bytes are an access guard (the 0age / CreateX convention):
    ///      all-zero ⇒ permissionless; non-zero ⇒ must equal `msg.sender`, so only the reserver
    ///      can land their params there — front-running protection for a pre-computed address.
    ///      Account-type agnostic (EOA, ERC-4337, Safe all present as `msg.sender`).
    function _guardSalt(bytes32 salt) internal view {
        // taking the leading 20 bytes as the guard address is the intended truncation.
        // forge-lint: disable-next-line(unsafe-typecast)
        address guard = address(bytes20(salt));
        if (guard != address(0) && guard != msg.sender) revert SaltSenderMismatch();
    }
}
