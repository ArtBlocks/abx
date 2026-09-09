// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAbxConfigureHook} from "../extensions/configurable-params/IAbxParamHooks.sol";

/// @title MaxDataLengthConfigureHook — reference configure-time validator
/// @notice A deliberately small example: scalar params pass, while String/Bytes writes are capped.
///         The token address is immutable so another contract cannot invoke the hook out of context.
contract MaxDataLengthConfigureHook is IAbxConfigureHook {
    error OnlyToken();
    error DataTooLarge(uint256 supplied, uint256 maximum);
    error InvalidBlobPointer();

    address public immutable token;
    uint256 public immutable maxDataLength;

    constructor(address token_, uint256 maxDataLength_) {
        token = token_;
        maxDataLength = maxDataLength_;
    }

    function onParamConfigured(
        uint256,
        bytes32,
        bytes32,
        address,
        uint256 dataLength,
        address dataBlobAddress
    ) external view {
        if (msg.sender != token) revert OnlyToken();
        if ((dataLength == 0) != (dataBlobAddress == address(0))) revert InvalidBlobPointer();
        if (dataLength > maxDataLength) revert DataTooLarge(dataLength, maxDataLength);
    }
}
