// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {SeriesImage} from "../src/tokens/SeriesImage.sol";
import {SeriesImageFactory} from "../src/factories/SeriesImageFactory.sol";
import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {OneOfOneEdition} from "../src/tokens/OneOfOneEdition.sol";
import {OneOfOneEditionFactory} from "../src/factories/OneOfOneEditionFactory.sol";
import {EditionImage} from "../src/tokens/EditionImage.sol";
import {EditionImageFactory} from "../src/factories/EditionImageFactory.sol";
import {EditionCode} from "../src/tokens/EditionCode.sol";
import {EditionCodeFactory} from "../src/factories/EditionCodeFactory.sol";
import {AbxSeedSource} from "../src/seed/AbxSeedSource.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev A validator with code that reverts on unknown selectors, so enrollment's probe accepts it.
contract OrderValidator {
    function validateTransfer(address, address, address, uint256) external pure {}
}

contract OrderReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }
}

/// @title The `initialize` event order each token type documents
/// @notice Each token's `initialize` NatSpec states the exact log sequence an indexer will see. This
///         pins it, with every optional extension configured so every conditional event fires.
///         `ext:<name>` is `AbxExtensionVersionSet` for `keccak256("abx.extension.<name>")`.
contract InitEventOrderTest is Test {
    address internal owner = address(0xA11CE);
    address internal validator;
    address internal seedSource;
    address internal receiver;

    function setUp() public {
        validator = address(new OrderValidator());
        seedSource = address(new AbxSeedSource());
        receiver = address(new OrderReceiver());
    }

    function _assertOrder(string[] memory expected) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, expected.length, "event count");
        for (uint256 i; i < logs.length; ++i) {
            bytes memory e = bytes(expected[i]);
            if (e.length > 4 && e[0] == "e" && e[1] == "x" && e[2] == "t" && e[3] == ":") {
                bytes memory name = new bytes(e.length - 4);
                for (uint256 k; k < name.length; ++k) name[k] = e[k + 4];
                assertEq(
                    logs[i].topics[0],
                    keccak256("AbxExtensionVersionSet(bytes32,uint16)"),
                    expected[i]
                );
                assertEq(
                    logs[i].topics[1], keccak256(abi.encodePacked("abx.extension.", name)), expected[i]
                );
            } else {
                assertEq(logs[i].topics[0], keccak256(e), expected[i]);
            }
        }
    }

    function _fields() internal pure returns (IAbxOnChainMetadata.FieldInput[] memory f) {
        f = new IAbxOnChainMetadata.FieldInput[](1);
        f[0] = IAbxOnChainMetadata.FieldInput("name", "text", bytes("x"));
    }

    function _tokenFields() internal pure returns (IAbxOnChainMetadata.TokenFieldInput[] memory f) {
        f = new IAbxOnChainMetadata.TokenFieldInput[](1);
        f[0] = IAbxOnChainMetadata.TokenFieldInput(0, "name", "text", bytes("x"));
    }

    function _list(string memory csv) internal pure returns (string[] memory out) {
        bytes memory b = bytes(csv);
        uint256 n = 1;
        for (uint256 i; i < b.length; ++i) if (b[i] == " ") ++n;
        out = new string[](n);
        uint256 start;
        uint256 k;
        for (uint256 i; i <= b.length; ++i) {
            if (i == b.length || b[i] == " ") {
                bytes memory w = new bytes(i - start);
                for (uint256 j; j < w.length; ++j) w[j] = b[start + j];
                out[k++] = string(w);
                start = i + 1;
            }
        }
    }

    string internal constant HEAD = "OwnershipTransferred(address,address) AbxDeployed(uint16) "
        "ext:royalty MaxRoyaltyBpsUpdated(uint16) RoyaltyChangedForAll(address,uint16) "
        "BurnConfigured(bool) ";
    string internal constant SALE = "ext:external-minter MinterSet(address) "
        "ext:primary-payee PrimaryPayeeChanged(address) ext:paused PausedStatusChanged(bool) ";
    string internal constant FIELDS = "ext:onchain-metadata "
        "TokenFieldSet(uint256,bytes32,bytes32,bytes) ContractFieldSet(bytes32,bytes32,bytes) "
        "ContractURIUpdated() ext:creator-token TransferValidatorUpdated(address,address) ";
    string internal constant CODE = "ext:seed-source SeedSourceSet(address) ext:params "
        "ext:configurable-params ";
    string internal constant SEEDED = "TokenParamConfigured(uint256,bytes32,bytes32,bool,address) "
        "MetadataUpdate(uint256) ";
    string internal constant TAIL = "Initialized(uint64) Deployed(address,address,address)";

    function test_OneOfOneImage() public {
        OneOfOneImageFactory f = new OneOfOneImageFactory();
        vm.recordLogs();
        f.deploy(
            OneOfOneImage.InitParams(
                owner, owner, "N", "S", "b", address(0), "c", address(0), owner, 500, 1000, true,
                validator, _fields(), _fields()
            )
        );
        _assertOrder(_list(string.concat(HEAD, FIELDS, "Transfer(address,address,uint256) ", TAIL)));
    }

    function test_SeriesImage() public {
        SeriesImageFactory f = new SeriesImageFactory();
        SeriesImage.InitParams memory p;
        (p.owner, p.name, p.symbol, p.tokenURIBase, p.contractURIBase) = (owner, "N", "S", "b", "c");
        (p.royaltyReceiver, p.royaltyBps, p.maxRoyaltyBps, p.burnable) = (owner, 500, 1000, true);
        (p.transferValidator, p.maxInvocations, p.primaryPayee, p.minter) = (validator, 5, owner, owner);
        (p.paused, p.mintTo, p.mintCount) = (true, owner, 1);
        (p.tokenFields, p.contractFields) = (_tokenFields(), _fields());
        vm.recordLogs();
        f.deploy(p);
        _assertOrder(
            _list(
                string.concat(
                    HEAD,
                    "ext:max-invocations MaxInvocationsUpdated(uint256) ",
                    SALE,
                    FIELDS,
                    "Transfer(address,address,uint256) ",
                    TAIL
                )
            )
        );
    }

    function test_SeriesCode() public {
        SeriesCodeFactory f = new SeriesCodeFactory();
        SeriesCode.InitParams memory p;
        (p.owner, p.name, p.symbol, p.tokenURIBase, p.contractURIBase) = (owner, "N", "S", "b", "c");
        (p.royaltyReceiver, p.royaltyBps, p.maxRoyaltyBps, p.burnable) = (owner, 500, 1000, true);
        (p.transferValidator, p.maxInvocations, p.primaryPayee, p.minter) = (validator, 5, owner, owner);
        (p.paused, p.seedSource, p.disableTokenOwnerDelegation) = (true, seedSource, true);
        (p.mintTo, p.mintCount) = (owner, 1);
        (p.tokenFields, p.contractFields) = (_tokenFields(), _fields());
        vm.recordLogs();
        f.deploy(p);
        _assertOrder(
            _list(
                string.concat(
                    HEAD,
                    "ext:max-invocations MaxInvocationsUpdated(uint256) ",
                    SALE,
                    CODE,
                    "DelegateRegistrySet(address) ext:onchain-script ext:dependencies ",
                    FIELDS,
                    SEEDED,
                    "Transfer(address,address,uint256) ",
                    TAIL
                )
            )
        );
    }

    function test_OneOfOneEdition() public {
        OneOfOneEditionFactory f = new OneOfOneEditionFactory();
        vm.recordLogs();
        f.deploy(
            OneOfOneEdition.InitParams(
                owner, receiver, 2, "N", "S", "b", address(0), "c", address(0), owner, 500, 1000,
                true, validator, 10, owner, owner, true, _fields(), _fields()
            )
        );
        _assertOrder(
            _list(
                string.concat(
                    HEAD,
                    "ext:edition-supply DefaultMaxSupplySet(uint256) ",
                    SALE,
                    FIELDS,
                    "TransferSingle(address,address,address,uint256,uint256) ",
                    TAIL
                )
            )
        );
    }

    function test_EditionImage() public {
        EditionImageFactory f = new EditionImageFactory();
        EditionImage.InitParams memory p;
        (p.owner, p.name, p.symbol, p.tokenURIBase, p.contractURIBase) = (owner, "N", "S", "b", "c");
        (p.royaltyReceiver, p.royaltyBps, p.maxRoyaltyBps, p.burnable) = (owner, 500, 1000, true);
        (p.transferValidator, p.maxInvocations, p.editionSize) = (validator, 5, 10);
        (p.primaryPayee, p.minter, p.paused) = (owner, owner, true);
        (p.mintTo, p.mintCount, p.mintAmount) = (receiver, 1, 2);
        (p.tokenFields, p.contractFields) = (_tokenFields(), _fields());
        vm.recordLogs();
        f.deploy(p);
        _assertOrder(
            _list(
                string.concat(
                    HEAD,
                    "ext:max-invocations MaxInvocationsUpdated(uint256) ",
                    "ext:edition-supply DefaultMaxSupplySet(uint256) ",
                    SALE,
                    FIELDS,
                    "TransferSingle(address,address,address,uint256,uint256) ",
                    TAIL
                )
            )
        );
    }

    function test_EditionCode() public {
        EditionCodeFactory f = new EditionCodeFactory();
        EditionCode.InitParams memory p;
        (p.owner, p.name, p.symbol, p.tokenURIBase, p.contractURIBase) = (owner, "N", "S", "b", "c");
        (p.royaltyReceiver, p.royaltyBps, p.maxRoyaltyBps, p.burnable) = (owner, 500, 1000, true);
        (p.transferValidator, p.maxInvocations, p.editionSize) = (validator, 5, 10);
        (p.primaryPayee, p.minter, p.paused, p.seedSource) = (owner, owner, true, seedSource);
        (p.mintTo, p.mintCount, p.mintAmount) = (receiver, 1, 2);
        (p.tokenFields, p.contractFields) = (_tokenFields(), _fields());
        vm.recordLogs();
        f.deploy(p);
        _assertOrder(
            _list(
                string.concat(
                    HEAD,
                    "ext:max-invocations MaxInvocationsUpdated(uint256) ",
                    "ext:edition-supply DefaultMaxSupplySet(uint256) ",
                    SALE,
                    CODE,
                    "ext:onchain-script ext:dependencies ",
                    FIELDS,
                    SEEDED,
                    "TransferSingle(address,address,address,uint256,uint256) ",
                    TAIL
                )
            )
        );
    }
}
