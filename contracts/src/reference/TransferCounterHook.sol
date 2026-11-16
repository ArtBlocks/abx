// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAbxTransferHook} from "../extensions/configurable-params/IAbxParamHooks.sol";

/// @title TransferCounterHook — reference transfer lifecycle observer
/// @notice Counts copies moved between two different non-zero addresses. Mint and burn are
///         intentionally excluded, and so are self-transfers: an ERC-721 token reports them to its
///         transfer hook (an ERC-1155 token does not), and counting them would let a holder raise
///         the rendered count just by paying gas. For ERC-1155 this is an aggregate per id, not an
///         invented single-owner concept.
contract TransferCounterHook is IAbxTransferHook {
    error OnlyToken();

    address public immutable token;
    mapping(uint256 tokenId => uint256 copiesTransferred) public transferCount;

    constructor(address token_) {
        token = token_;
    }

    function onTokenTransfer(uint256 tokenId, address from, address to, address, uint256 amount)
        external
    {
        if (msg.sender != token) revert OnlyToken();
        if (from != address(0) && to != address(0) && from != to) transferCount[tokenId] += amount;
    }
}
