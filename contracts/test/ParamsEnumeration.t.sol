// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {SeriesCode} from "../src/tokens/SeriesCode.sol";
import {SeriesCodeFactory} from "../src/factories/SeriesCodeFactory.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";
import {IAbxConfigurableParams} from
    "../src/extensions/configurable-params/IAbxConfigurableParams.sol";
import {ConfigurableParams} from "../src/extensions/configurable-params/ConfigurableParams.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @dev Deterministic seed source — the mint path must write `seed` without ever listing it.
contract EnumSeedSource is IAbxSeedSource {
    function seed(uint256 tokenId, address) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("enum", tokenId));
    }
}

/// @notice On-chain param **enumeration**: the per-scope key lists a consumer reads instead of
///         guessing keys. The load-bearing invariant is `key ∈ list ⟺ isSet` — with `seed`
///         excepted at both scopes — held across every write path (raw setters, the data
///         variants, the governed `configureTokenParam*` path, mint-time seeds) and across
///         removal, which is swap-and-pop and so reorders the list by design.
contract ParamsEnumerationTest is Test {
    bytes32 internal constant SEED = "seed";

    SeriesCodeFactory internal factory;
    EnumSeedSource internal seedSource;
    SeriesCode internal nft;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");

    uint256 internal constant N = 20; // series size
    uint256 internal constant TOKEN = 0; // the token every scope test writes against

    /// @dev The fuzz alphabet — small enough that random sequences actually collide and clear.
    bytes32[4] internal ALPHABET = [bytes32("palette"), "size", "tint", "glow"];

    function setUp() public {
        factory = new SeriesCodeFactory();
        seedSource = new EnumSeedSource();
        nft = SeriesCode(factory.deploy(_params(address(seedSource))));
    }

    function _params(address src) internal view returns (SeriesCode.InitParams memory) {
        return SeriesCode.InitParams({
            owner: owner,
            name: "Waves",
            symbol: "WAV",
            tokenURIBase: "https://abx.test/t",
            tokenURIRenderer: address(0),
            contractURIBase: "https://abx.test/c",
            contractURIRenderer: address(0),
            royaltyReceiver: owner,
            royaltyBps: 500,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            maxInvocations: N,
            primaryPayee: address(0),
            minter: address(0),
            paused: false,
            seedSource: src,
            disableTokenOwnerDelegation: false,
            mintTo: address(0),
            mintCount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    // ── assertion helpers ─────────────────────────────────────────────────────

    function _contains(bytes32[] memory list, bytes32 key) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == key) return true;
        }
        return false;
    }

    /// @dev The invariant, checked over the whole alphabet: every alphabet key is listed exactly
    ///      when it is set, and the list is exactly that long — which together rule out both a
    ///      duplicate (length too high) and an omission (length too low).
    function _assertTokenListMatches(uint256 tokenId) internal view {
        bytes32[] memory keys = nft.tokenParamKeys(tokenId);
        uint256 setCount;
        for (uint256 i; i < ALPHABET.length; ++i) {
            (,, bool isSet) = nft.tokenParam(tokenId, ALPHABET[i]);
            assertEq(_contains(keys, ALPHABET[i]), isSet, "token: list must match isSet");
            if (isSet) ++setCount;
        }
        assertEq(keys.length, setCount, "token: list length must equal the set-key count");
        assertFalse(_contains(keys, SEED), "token: seed must never be listed");
    }

    function _assertContractListMatches() internal view {
        bytes32[] memory keys = nft.contractParamKeys();
        uint256 setCount;
        for (uint256 i; i < ALPHABET.length; ++i) {
            (,, bool isSet) = nft.contractParam(ALPHABET[i]);
            assertEq(_contains(keys, ALPHABET[i]), isSet, "contract: list must match isSet");
            if (isSet) ++setCount;
        }
        assertEq(keys.length, setCount, "contract: list length must equal the set-key count");
        assertFalse(_contains(keys, SEED), "contract: seed must never be listed");
    }

    // ── the invariant, under random interleaved sequences ─────────────────────

    /// @dev Random set / setData / clear against the token scope. `clear` reverts on an unset
    ///      key, so the reference read (`isSet`) decides whether the op is legal — which also
    ///      means a bogus list would steer the sequence and get caught either way.
    function testFuzz_TokenKeyListTracksTheSetKeys(uint8[24] calldata ops, uint8[24] calldata idx)
        public
    {
        vm.startPrank(owner);
        for (uint256 i; i < ops.length; ++i) {
            bytes32 key = ALPHABET[idx[i] % ALPHABET.length];
            (,, bool isSet) = nft.tokenParam(TOKEN, key);
            uint256 op = ops[i] % 4;
            if (op == 0) {
                nft.setTokenParam(TOKEN, key, bytes32(uint256(ops[i])));
            } else if (op == 1) {
                nft.setTokenParamData(TOKEN, key, abi.encodePacked("blob", ops[i]));
            } else if (op == 2 && isSet) {
                nft.clearTokenParam(TOKEN, key);
            } else {
                nft.setTokenParam(TOKEN, key, bytes32(uint256(i)));
            }
            _assertTokenListMatches(TOKEN);
        }

        // draining the scope must empty the list — the end-to-end proof that every swap-and-pop
        // left the index mapping consistent (a stale index corrupts the next removal).
        for (uint256 i; i < ALPHABET.length; ++i) {
            (,, bool isSet) = nft.tokenParam(TOKEN, ALPHABET[i]);
            if (isSet) nft.clearTokenParam(TOKEN, ALPHABET[i]);
            _assertTokenListMatches(TOKEN);
        }
        vm.stopPrank();
        assertEq(nft.tokenParamKeys(TOKEN).length, 0);
    }

    function testFuzz_ContractKeyListTracksTheSetKeys(
        uint8[24] calldata ops,
        uint8[24] calldata idx
    ) public {
        vm.startPrank(owner);
        for (uint256 i; i < ops.length; ++i) {
            bytes32 key = ALPHABET[idx[i] % ALPHABET.length];
            (,, bool isSet) = nft.contractParam(key);
            uint256 op = ops[i] % 4;
            if (op == 0) {
                nft.setContractParam(key, bytes32(uint256(ops[i])));
            } else if (op == 1) {
                nft.setContractParamData(key, abi.encodePacked("blob", ops[i]));
            } else if (op == 2 && isSet) {
                nft.clearContractParam(key);
            } else {
                nft.setContractParam(key, bytes32(uint256(i)));
            }
            _assertContractListMatches();
        }

        for (uint256 i; i < ALPHABET.length; ++i) {
            (,, bool isSet) = nft.contractParam(ALPHABET[i]);
            if (isSet) nft.clearContractParam(ALPHABET[i]);
            _assertContractListMatches();
        }
        vm.stopPrank();
        assertEq(nft.contractParamKeys().length, 0);
    }

    /// @dev The governed path writes through the same choke point, so it must index identically.
    ///      A schema'd key can never be cleared (the raw setter is closed) — the list only grows.
    function testFuzz_GovernedWritesMaintainTheIndex(uint8[16] calldata idx) public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        for (uint256 i; i < ALPHABET.length; ++i) {
            vm.prank(owner);
            nft.setParamSchema(
                ALPHABET[i],
                IAbxConfigurableParams.ParamType.Uint256Range,
                IAbxConfigurableParams.AuthOption.TokenOwner,
                address(0),
                0,
                bytes32(0),
                bytes32(0),
                new string[](0)
            );
        }

        for (uint256 i; i < idx.length; ++i) {
            bytes32 key = ALPHABET[idx[i] % ALPHABET.length];
            vm.prank(collector);
            nft.configureTokenParam(id, key, bytes32(uint256(idx[i])));
            _assertTokenListMatches(id);
        }
        assertEq(nft.paramSchemaKeys().length, ALPHABET.length);
    }

    // ── `seed` is never enumerated ────────────────────────────────────────────

    function test_MintWritesSeedWithoutListingIt() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);

        (,, bool isSet) = nft.tokenParam(id, SEED);
        assertTrue(isSet, "the mint path must set seed");
        assertEq(nft.tokenParamKeys(id).length, 0, "a seeded mint must write no index");
    }

    function test_GovernedSeedReconfigureStillNeverListsIt() public {
        // Declared before any seed exists — the seed's governance model is fixed pre-sale.
        vm.prank(owner);
        nft.setParamSchema(
            SEED,
            IAbxConfigurableParams.ParamType.Uint256Range,
            IAbxConfigurableParams.AuthOption.TokenOwner,
            address(0),
            0,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
        vm.prank(owner);
        uint256 id = nft.mint(collector);

        vm.prank(collector);
        nft.configureTokenParam(id, SEED, bytes32(uint256(777)));
        (bytes32 v,,) = nft.tokenParam(id, SEED);
        assertEq(v, bytes32(uint256(777)));
        assertEq(nft.tokenParamKeys(id).length, 0, "a reassigned seed is still not a listed key");

        // it IS a declared key though — that list is the governed vocabulary, not the value set
        bytes32[] memory schemaKeys = nft.paramSchemaKeys();
        assertEq(schemaKeys.length, 1);
        assertEq(schemaKeys[0], SEED);
    }

    /// @dev The one reachable "set but never indexed, then cleared" path on this token type:
    ///      the settled-seed guard is token-scope only, so a contract-scope `seed` clears
    ///      normally — and must leave the neighbouring keys' list untouched.
    function test_ContractScopeSeedIsSettableClearableAndNeverListed() public {
        vm.startPrank(owner);
        nft.setContractParam("palette", bytes32(uint256(1)));
        nft.setContractParam(SEED, bytes32(uint256(9)));
        nft.setContractParam("size", bytes32(uint256(2)));

        bytes32[] memory keys = nft.contractParamKeys();
        assertEq(keys.length, 2, "seed must not join the contract list");
        assertEq(keys[0], "palette");
        assertEq(keys[1], "size");

        // clearing an unindexed-but-set key must be a no-op for the list, not a corruption
        nft.clearContractParam(SEED);
        vm.stopPrank();

        (,, bool isSet) = nft.contractParam(SEED);
        assertFalse(isSet);
        keys = nft.contractParamKeys();
        assertEq(keys.length, 2);
        assertEq(keys[0], "palette");
        assertEq(keys[1], "size");
    }

    function test_SettledSeedGuardStillAppliesAtTokenScope() public {
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        vm.prank(owner);
        vm.expectRevert(SeriesCode.SeedSettled.selector);
        nft.clearTokenParam(id, SEED);
    }

    // ── list mechanics ────────────────────────────────────────────────────────

    function test_LiteralReplacingDataKeepsOneEntry() public {
        vm.startPrank(owner);
        nft.setTokenParamData(TOKEN, "palette", bytes("a long value"));
        assertEq(nft.tokenParamKeys(TOKEN).length, 1);

        nft.setTokenParam(TOKEN, "palette", bytes32(uint256(1))); // literal drops the blob
        vm.stopPrank();

        bytes32[] memory keys = nft.tokenParamKeys(TOKEN);
        assertEq(keys.length, 1, "replacing a value must not re-append the key");
        assertEq(keys[0], "palette");
        assertEq(nft.tokenParamData(TOKEN, "palette"), bytes(""));
    }

    function test_ReSetAfterClearReAppends() public {
        vm.startPrank(owner);
        nft.setTokenParam(TOKEN, "palette", bytes32(uint256(1)));
        nft.setTokenParam(TOKEN, "size", bytes32(uint256(2)));
        nft.clearTokenParam(TOKEN, "palette");
        assertEq(nft.tokenParamKeys(TOKEN).length, 1);

        nft.setTokenParam(TOKEN, "palette", bytes32(uint256(3)));
        vm.stopPrank();

        bytes32[] memory keys = nft.tokenParamKeys(TOKEN);
        assertEq(keys.length, 2);
        assertEq(keys[0], "size"); // swap-and-pop moved "size" down…
        assertEq(keys[1], "palette"); // …and the re-set appended at the end
    }

    /// @dev Swap-and-pop must move the LAST key into the removed slot and correct its index.
    ///      Clearing that moved key next is the proof its index was fixed: a stale index would
    ///      pop the wrong element and leave the list inconsistent with `isSet`.
    function test_SwapAndPopMovesTheLastKeyAndFixesItsIndex() public {
        vm.startPrank(owner);
        nft.setTokenParam(TOKEN, "palette", bytes32(uint256(1)));
        nft.setTokenParam(TOKEN, "size", bytes32(uint256(2)));
        nft.setTokenParam(TOKEN, "tint", bytes32(uint256(3)));

        bytes32[] memory keys = nft.tokenParamKeys(TOKEN);
        assertEq(keys[0], "palette");
        assertEq(keys[1], "size");
        assertEq(keys[2], "tint");

        nft.clearTokenParam(TOKEN, "palette"); // remove the FIRST → "tint" takes slot 0
        keys = nft.tokenParamKeys(TOKEN);
        assertEq(keys.length, 2);
        assertEq(keys[0], "tint");
        assertEq(keys[1], "size");

        nft.clearTokenParam(TOKEN, "tint"); // the moved key, via its corrected index
        keys = nft.tokenParamKeys(TOKEN);
        assertEq(keys.length, 1);
        assertEq(keys[0], "size");

        nft.clearTokenParam(TOKEN, "size"); // removing the last entry needs no swap
        vm.stopPrank();
        assertEq(nft.tokenParamKeys(TOKEN).length, 0);
        _assertTokenListMatches(TOKEN);
    }

    function test_ScopesAndTokensAreIndependent() public {
        vm.startPrank(owner);
        nft.setTokenParam(0, "palette", bytes32(uint256(1)));
        nft.setTokenParam(1, "size", bytes32(uint256(2)));
        nft.setContractParam("tint", bytes32(uint256(3)));
        vm.stopPrank();

        assertEq(nft.tokenParamKeys(0).length, 1);
        assertEq(nft.tokenParamKeys(0)[0], "palette");
        assertEq(nft.tokenParamKeys(1).length, 1);
        assertEq(nft.tokenParamKeys(1)[0], "size");
        assertEq(nft.tokenParamKeys(2).length, 0);
        assertEq(nft.contractParamKeys().length, 1);
        assertEq(nft.contractParamKeys()[0], "tint");
    }

    // ── paged getters ─────────────────────────────────────────────────────────

    function _fillFour() internal {
        vm.startPrank(owner);
        for (uint256 i; i < ALPHABET.length; ++i) {
            nft.setTokenParam(TOKEN, ALPHABET[i], bytes32(uint256(i)));
            nft.setContractParam(ALPHABET[i], bytes32(uint256(i)));
        }
        vm.stopPrank();
    }

    function test_PagedTokenKeysWindows() public {
        _fillFour();

        (bytes32[] memory keys, uint256 total) = nft.tokenParamKeysPaged(TOKEN, 0, 2);
        assertEq(total, 4);
        assertEq(keys.length, 2);
        assertEq(keys[0], ALPHABET[0]);
        assertEq(keys[1], ALPHABET[1]);

        (keys, total) = nft.tokenParamKeysPaged(TOKEN, 2, 2); // the tail, exactly
        assertEq(total, 4);
        assertEq(keys.length, 2);
        assertEq(keys[0], ALPHABET[2]);
        assertEq(keys[1], ALPHABET[3]);

        (keys, total) = nft.tokenParamKeysPaged(TOKEN, 3, 10); // count past the end → clamps
        assertEq(total, 4);
        assertEq(keys.length, 1);
        assertEq(keys[0], ALPHABET[3]);

        (keys, total) = nft.tokenParamKeysPaged(TOKEN, 4, 2); // start AT the end → empty
        assertEq(total, 4);
        assertEq(keys.length, 0);

        (keys, total) = nft.tokenParamKeysPaged(TOKEN, 99, 2); // start past the end → empty
        assertEq(total, 4);
        assertEq(keys.length, 0);

        (keys, total) = nft.tokenParamKeysPaged(TOKEN, 0, 0); // count 0 → empty, total still true
        assertEq(total, 4);
        assertEq(keys.length, 0);

        (keys, total) = nft.tokenParamKeysPaged(TOKEN, 0, type(uint256).max); // the whole list
        assertEq(total, 4);
        assertEq(keys.length, 4);
    }

    function test_PagedContractKeysWindows() public {
        _fillFour();

        (bytes32[] memory keys, uint256 total) = nft.contractParamKeysPaged(1, 2);
        assertEq(total, 4);
        assertEq(keys.length, 2);
        assertEq(keys[0], ALPHABET[1]);
        assertEq(keys[1], ALPHABET[2]);

        (keys, total) = nft.contractParamKeysPaged(0, 0);
        assertEq(total, 4);
        assertEq(keys.length, 0);

        (keys, total) = nft.contractParamKeysPaged(4, 1);
        assertEq(total, 4);
        assertEq(keys.length, 0);
    }

    function test_PagedOnAnEmptyListIsEmptyNotARevert() public view {
        (bytes32[] memory keys, uint256 total) = nft.tokenParamKeysPaged(7, 0, 10);
        assertEq(total, 0);
        assertEq(keys.length, 0);

        (keys, total) = nft.contractParamKeysPaged(0, 10);
        assertEq(total, 0);
        assertEq(keys.length, 0);

        (keys, total) = nft.paramSchemaKeysPaged(0, 10);
        assertEq(total, 0);
        assertEq(keys.length, 0);
    }

    /// @dev Walking the paged form to exhaustion must reproduce the full-array read exactly.
    function testFuzz_PagedWalkReproducesTheFullList(uint8 pageSize) public {
        _fillFour();
        uint256 size = uint256(pageSize % 5) + 1; // 1..5
        bytes32[] memory full = nft.tokenParamKeys(TOKEN);

        uint256 seen;
        for (uint256 start; start < full.length; start += size) {
            (bytes32[] memory page, uint256 total) = nft.tokenParamKeysPaged(TOKEN, start, size);
            assertEq(total, full.length);
            for (uint256 i; i < page.length; ++i) {
                assertEq(page[i], full[start + i]);
                ++seen;
            }
        }
        assertEq(seen, full.length);
    }

    // ── the schema key list ───────────────────────────────────────────────────

    function _uintSchema(bytes32 key, uint48 lockAfter) internal {
        vm.prank(owner);
        nft.setParamSchema(
            key,
            IAbxConfigurableParams.ParamType.Uint256Range,
            IAbxConfigurableParams.AuthOption.Creator,
            address(0),
            lockAfter,
            bytes32(0),
            bytes32(0),
            new string[](0)
        );
    }

    function test_SchemaKeysAppendOnFirstDeclarationOnly() public {
        assertEq(nft.paramSchemaKeys().length, 0);

        _uintSchema("palette", 0);
        _uintSchema("size", 0);
        bytes32[] memory keys = nft.paramSchemaKeys();
        assertEq(keys.length, 2);
        assertEq(keys[0], "palette");
        assertEq(keys[1], "size");

        _uintSchema("palette", uint48(block.timestamp + 1 days)); // update, not a new key
        keys = nft.paramSchemaKeys();
        assertEq(keys.length, 2, "re-declaring a key must not duplicate it");
        assertEq(keys[0], "palette");
        assertEq(keys[1], "size");

        (bool exists,,,, uint48 lockAfter,,,) = nft.paramSchema("palette");
        assertTrue(exists);
        assertEq(lockAfter, uint48(block.timestamp + 1 days)); // the update landed
    }

    function test_SchemaKeysListDeclaredButUnsetKeys() public {
        _uintSchema("palette", 0);
        // declared, never written: invisible to the value lists, visible to the schema list —
        // which is exactly what a chain-only configure UI needs to render an empty field.
        assertEq(nft.tokenParamKeys(TOKEN).length, 0);
        assertEq(nft.contractParamKeys().length, 0);
        assertEq(nft.paramSchemaKeys().length, 1);
    }

    function test_PagedSchemaKeysWindows() public {
        _uintSchema("palette", 0);
        _uintSchema("size", 0);
        _uintSchema("tint", 0);

        (bytes32[] memory keys, uint256 total) = nft.paramSchemaKeysPaged(0, 2);
        assertEq(total, 3);
        assertEq(keys.length, 2);
        assertEq(keys[0], "palette");
        assertEq(keys[1], "size");

        (keys, total) = nft.paramSchemaKeysPaged(2, 5);
        assertEq(total, 3);
        assertEq(keys.length, 1);
        assertEq(keys[0], "tint");

        (keys, total) = nft.paramSchemaKeysPaged(3, 1);
        assertEq(total, 3);
        assertEq(keys.length, 0);
    }

    function test_SchemaKeysSurviveTheValueLifecycle() public {
        _uintSchema("palette", 0);
        vm.prank(owner);
        uint256 id = nft.mint(collector);
        vm.prank(owner);
        nft.configureTokenParam(id, "palette", bytes32(uint256(5)));
        assertEq(nft.tokenParamKeys(id).length, 1);

        // the raw clear is closed for a governed key, so the value cannot leave — but the point
        // stands: the schema list is a declaration record, independent of any value's lifetime.
        vm.prank(owner);
        vm.expectRevert(ConfigurableParams.SchemaGoverned.selector);
        nft.clearTokenParam(id, "palette");
        assertEq(nft.paramSchemaKeys().length, 1);
    }

    // ── gas ───────────────────────────────────────────────────────────────────

    /// @notice The measured cost of index maintenance, and the proof the mint path skips it.
    ///         Numbers are logged (they belong in `AbxParamsLib`'s NatSpec, not in an assert
    ///         that breaks on every unrelated opcode-pricing change); the assertions pin the
    ///         *shape*: a seeded mint writes no index, and a repeat write is far cheaper than a
    ///         first write because it touches no new slot.
    function test_GasIndexMaintenanceCost() public {
        vm.startPrank(owner);
        uint256 g = gasleft();
        uint256 id = nft.mint(collector);
        uint256 mintGas = g - gasleft();
        emit log_named_uint("mint (seed written, never indexed)", mintGas);
        assertEq(nft.tokenParamKeys(id).length, 0, "the mint path must write no index");

        g = gasleft();
        nft.setTokenParam(id, "palette", bytes32(uint256(1)));
        uint256 firstInScope = g - gasleft();
        emit log_named_uint("set: first key in the scope", firstInScope);

        g = gasleft();
        nft.setTokenParam(id, "size", bytes32(uint256(1)));
        uint256 secondKey = g - gasleft();
        emit log_named_uint("set: an additional new key", secondKey);

        g = gasleft();
        nft.setTokenParam(id, "palette", bytes32(uint256(2)));
        uint256 repeat = g - gasleft();
        emit log_named_uint("set: repeat of a listed key", repeat);

        g = gasleft();
        nft.clearTokenParam(id, "palette");
        emit log_named_uint("clear (swap-and-pop)", g - gasleft());
        vm.stopPrank();

        // a first write pays for three fresh slots (list length, element, index); a repeat pays
        // for none of them, so the gap is the whole story of this feature's write cost.
        assertGt(firstInScope, secondKey, "the scope's first key also inits the length slot");
        assertGt(secondKey, repeat * 5, "a new key must cost far more than re-setting one");
    }

    /// @dev A seeded mint must be indistinguishable from one on a project with no params at all:
    ///      the enumeration feature charges the mint path nothing but a `bytes32` comparison.
    function test_GasSeededMintUnaffectedByEnumeration() public {
        vm.startPrank(owner);
        uint256 g = gasleft();
        nft.mint(collector);
        uint256 seeded = g - gasleft();
        vm.stopPrank();

        SeriesCode bare = SeriesCode(factory.deploy(_params(address(0))));
        vm.startPrank(owner);
        g = gasleft();
        bare.mint(collector);
        uint256 unseeded = g - gasleft();
        vm.stopPrank();

        emit log_named_uint("mint with a seed", seeded);
        emit log_named_uint("mint with no seed source", unseeded);
        assertEq(bare.tokenParamKeys(0).length, 0);
        assertEq(nft.tokenParamKeys(0).length, 0);
    }
}
