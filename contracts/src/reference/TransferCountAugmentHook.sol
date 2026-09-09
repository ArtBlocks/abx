// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibString} from "solady/utils/LibString.sol";
import {IAbxAugmentHook} from "../extensions/configurable-params/IAbxParamHooks.sol";
import {TransferCounterHook} from "./TransferCounterHook.sol";

/// @title TransferCountAugmentHook — reference read-time derivation
/// @notice Exposes the counter hook's monotonic state as one canonical string PostParam.
contract TransferCountAugmentHook is IAbxAugmentHook {
    using LibString for uint256;

    error WrongToken();

    TransferCounterHook public immutable counter;

    constructor(TransferCounterHook counter_) {
        counter = counter_;
    }

    function augmentTokenParams(address token, uint256 tokenId)
        external
        view
        returns (AugmentedParam[] memory params)
    {
        if (token != counter.token()) revert WrongToken();
        params = new AugmentedParam[](1);
        params[0] = AugmentedParam({
            key: "transfer_count", value: counter.transferCount(tokenId).toString()
        });
    }
}
