// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MaxDataLengthConfigureHook} from "abx-contracts/src/reference/MaxDataLengthConfigureHook.sol";
import {TransferCounterHook} from "abx-contracts/src/reference/TransferCounterHook.sol";
import {TransferCountAugmentHook} from "abx-contracts/src/reference/TransferCountAugmentHook.sol";

/// Fork these thin wrappers when your project needs different policy. Keeping each lifecycle role
/// in its own contract means a project only deploys and grants the authority it actually uses.
contract MyConfigureHook is MaxDataLengthConfigureHook {
    constructor(address token, uint256 maxDataLength) MaxDataLengthConfigureHook(token, maxDataLength) {}
}

contract MyTransferHook is TransferCounterHook {
    constructor(address token) TransferCounterHook(token) {}
}

contract MyAugmentHook is TransferCountAugmentHook {
    constructor(TransferCounterHook counter) TransferCountAugmentHook(counter) {}
}
