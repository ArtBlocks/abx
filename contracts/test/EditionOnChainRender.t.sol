// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";

import {EditionCode} from "../src/tokens/EditionCode.sol";
import {EditionCodeFactory} from "../src/factories/EditionCodeFactory.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {SeedSvgRenderer} from "../src/renderers/examples/SeedSvgRenderer.sol";
import {SeedTraitsRenderer} from "../src/renderers/examples/SeedTraitsRenderer.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";
import {IAbxSeedSource} from "../src/interfaces/IAbxSeedSource.sol";

contract EditionSeedSource is IAbxSeedSource {
    function seed(uint256 id, address) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("edition", id));
    }
}

/// @notice **Is a fully on-chain, Solidity-rendered ERC-1155 edition a CONTRACT gap or a CLI gap?**
///
/// `deploy-code --copies` refuses `--image-renderer`/`--attributes-renderer`, and a 2026-08-24 field
/// report read that refusal as a protocol limit — "no lane gives you a permissionless, ongoing,
/// on-chain-rendered ERC-1155" — and shipped an ERC-721 workaround instead.
///
/// This test settles it from the contracts, not from prose: `EditionCode` composes the same
/// `OnChainMetadata` extension and the same URI-renderer slots as `SeriesCode`, so the in-chain
/// Solidity renderer lane is fully expressible on the contract **today**, with the canonical
/// metadata renderer and canonical example field renderers, no server anywhere. It is a CLI gap.
///
/// Keep this test: it is the executable statement of that claim, and if it ever stops passing, the
/// edition/code parity invariant in `contracts/README.md` has become a contract change instead.
contract EditionOnChainRenderTest is Test {
    bytes32 internal constant RENDERER_REP = "renderer";

    EditionCodeFactory internal factory;
    AbxMetadataRenderer internal metadataRenderer;
    SeedSvgRenderer internal imageRenderer;
    SeedTraitsRenderer internal traitsRenderer;
    EditionCode internal nft;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");

    function setUp() public {
        factory = new EditionCodeFactory();
        metadataRenderer = new AbxMetadataRenderer();
        imageRenderer = new SeedSvgRenderer();
        traitsRenderer = new SeedTraitsRenderer();

        // Exactly what `deploy-code --image-renderer X --attributes-renderer Y --onchain-uri` bakes
        // on the 721 lane: two collection-scope `renderer` fields + both URI renderers.
        IAbxOnChainMetadata.FieldInput[] memory contractFields = new IAbxOnChainMetadata.FieldInput[](2);
        contractFields[0] =
            IAbxOnChainMetadata.FieldInput("image", RENDERER_REP, abi.encode(address(imageRenderer)));
        contractFields[1] =
            IAbxOnChainMetadata.FieldInput("attributes", RENDERER_REP, abi.encode(address(traitsRenderer)));

        nft = EditionCode(
            factory.deploy(
                EditionCode.InitParams({
                    owner: owner,
                    name: "Autograph",
                    symbol: "AUTO",
                    tokenURIBase: "", // no server, deliberately
                    tokenURIRenderer: address(metadataRenderer),
                    contractURIBase: "",
                    contractURIRenderer: address(metadataRenderer),
                    royaltyReceiver: owner,
                    royaltyBps: 500,
                    maxRoyaltyBps: 1000,
                    burnable: false,
                    transferValidator: address(0),
                    maxInvocations: 10,
                    editionSize: 0, // open edition — the "ongoing, permissionless" shape
                    primaryPayee: address(0),
                    minter: address(0),
                    paused: false,
                    seedSource: address(new EditionSeedSource()),
                    mintTo: address(0),
                    mintCount: 0,
                    mintAmount: 0,
                    tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
                    contractFields: contractFields
                })
            )
        );
    }

    function _json(string memory uri) internal pure returns (string memory) {
        string memory prefix = "data:application/json;base64,";
        assertTrue(LibString.startsWith(uri, prefix), "uri must be an on-chain data JSON document");
        return string(Base64.decode(LibString.slice(uri, bytes(prefix).length, bytes(uri).length)));
    }

    /// @dev The headline: an open ERC-1155 edition whose image AND traits are computed in Solidity,
    ///      served from `uri(id)`, with no `http` anywhere in the document.
    function test_EditionServesAFullyOnChainDocument() public {
        vm.prank(owner);
        nft.mint(collector, 0, 3);

        string memory doc = _json(nft.uri(0));
        assertTrue(LibString.contains(doc, '"image":"data:image/svg+xml;base64,'), "image computed on chain");
        assertTrue(LibString.contains(doc, '"attributes":['), "traits computed on chain");
        assertFalse(LibString.contains(doc, "http"), "a chain-complete document names no off-chain host");
    }

    /// @dev The "ongoing / permissionless" half: a later id mints and renders identically, and the
    ///      collection surface (the sentinel id the renderer receives for `contractURI`) also works.
    function test_LaterIdsAndTheCollectionSurfaceRenderToo() public {
        vm.startPrank(owner);
        nft.mint(collector, 0, 1);
        nft.mint(collector, 4, 7); // a different work, minted later, many copies
        vm.stopPrank();

        string memory later = _json(nft.uri(4));
        assertTrue(LibString.contains(later, '"image":"data:image/svg+xml;base64,'), "id 4 renders too");
        // The two ids draw from different seeds, so their documents must differ.
        assertNotEq(keccak256(bytes(later)), keccak256(bytes(_json(nft.uri(0)))), "per-id seeds diverge");

        string memory collection = _json(nft.contractURI());
        assertTrue(bytes(collection).length > 0, "contractURI resolves on chain");
    }

    /// @dev And the field surface is writable AFTER deploy, on the same terms as the 721 — which is
    ///      what makes a post-launch renderer swap possible on this lane too.
    function test_TheRendererFieldIsRepointableAfterDeploy() public {
        vm.prank(owner);
        nft.mint(collector, 0, 1);

        SeedSvgRenderer replacement = new SeedSvgRenderer();
        vm.prank(owner);
        nft.setContractField("image", RENDERER_REP, abi.encode(address(replacement)));

        (bytes32 rep, bytes memory value) = nft.contractField("image");
        assertEq(rep, RENDERER_REP);
        assertEq(abi.decode(value, (address)), address(replacement));
        assertTrue(LibString.contains(_json(nft.uri(0)), '"image":"data:image/svg+xml;base64,'), "still renders");
    }
}
