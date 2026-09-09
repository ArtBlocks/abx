// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "solady/utils/Base64.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {Initializable} from "solady/utils/Initializable.sol";
import {LibString} from "solady/utils/LibString.sol";

import {SeriesImage} from "../src/tokens/SeriesImage.sol";
import {SeriesImageFactory} from "../src/factories/SeriesImageFactory.sol";
import {AbxMetadataRenderer} from "../src/renderers/AbxMetadataRenderer.sol";
import {AbxVersion} from "../src/libraries/AbxVersion.sol";
import {IAbxBeacon} from "../src/interfaces/IAbxBeacon.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";
import {MaxInvocations} from "../src/extensions/max-invocations/MaxInvocations.sol";
import {IAbxMaxInvocations} from "../src/extensions/max-invocations/IAbxMaxInvocations.sol";
import {ExternalMinter} from "../src/extensions/external-minter/ExternalMinter.sol";
import {IAbxExternalMinter} from "../src/extensions/external-minter/IAbxExternalMinter.sol";
import {IAbxPrimaryPayee} from "../src/extensions/primary-payee/IAbxPrimaryPayee.sol";
import {Paused} from "../src/extensions/paused/Paused.sol";
import {IAbxPaused} from "../src/extensions/paused/IAbxPaused.sol";
import {IAbxSequentialMint} from "../src/interfaces/IAbxSequentialMint.sol";

/// @notice Behavior of a deployed Series clone: sequential minting (metadata == token id), the
///         supply cap, external minters, primary payee, the paused mint gate, per-token on-chain
///         metadata, and ERC-165.
contract SeriesImageTest is Test {
    bytes32 internal constant NAME = "name";
    bytes32 internal constant IMAGE = "image";
    bytes32 internal constant INLINE = "inline";
    bytes32 internal constant ARWEAVE = "arweave";

    // mirrored events for expectEmit
    event MaxInvocationsUpdated(uint256 maxInvocations);
    event MinterSet(address indexed minter);
    event PrimaryPayeeChanged(address indexed account);
    event PausedStatusChanged(bool paused);
    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event TokenFieldSet(
        uint256 indexed tokenId, bytes32 indexed field, bytes32 representation, bytes value
    );

    SeriesImageFactory internal factory;
    AbxMetadataRenderer internal renderer;
    SeriesImage internal nft;

    address internal owner = makeAddr("owner");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");
    address internal minter = makeAddr("minter");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");

    uint16 internal constant BPS = 500;
    uint256 internal constant N = 5; // series size

    // protocol spec values, asserted independently of the implementation's own constants
    bytes32 internal constant MAX_INVOCATIONS_ID = keccak256("abx.extension.max-invocations");
    bytes32 internal constant EXTERNAL_MINTER_ID = keccak256("abx.extension.external-minter");
    bytes32 internal constant PRIMARY_PAYEE_ID = keccak256("abx.extension.primary-payee");
    bytes32 internal constant PAUSED_ID = keccak256("abx.extension.paused");
    bytes32 internal constant ONCHAIN_METADATA_ID = keccak256("abx.extension.onchain-metadata");
    bytes32 internal constant ROYALTY_ID = keccak256("abx.extension.royalty");

    function setUp() public {
        factory = new SeriesImageFactory();
        renderer = new AbxMetadataRenderer();
        nft = SeriesImage(factory.deploy(_params()));
    }

    // ---- param builders ----

    function _params() internal view returns (SeriesImage.InitParams memory) {
        return SeriesImage.InitParams({
            owner: owner,
            name: "Postcards",
            symbol: "PC",
            tokenURIBase: "https://abx.test/t",
            tokenURIRenderer: address(0),
            contractURIBase: "https://abx.test/c",
            contractURIRenderer: address(0),
            royaltyReceiver: royaltyReceiver,
            royaltyBps: BPS,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            maxInvocations: N,
            primaryPayee: address(0),
            minter: address(0),
            paused: false, // default tests exercise the unpaused path; paused tests opt in
            mintTo: address(0), // defer minting by default
            mintCount: 0,
            tokenFields: new IAbxOnChainMetadata.TokenFieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    function _deploy(SeriesImage.InitParams memory p) internal returns (SeriesImage) {
        return SeriesImage(factory.deploy(p));
    }

    /// @dev Mirrors `TokenURI._composeTokenURI`: `{base}/{chainId}/{address}/{tokenId}`.
    function _derivedToken(address c, uint256 id, string memory base)
        internal
        view
        returns (string memory)
    {
        return string.concat(
            base,
            "/",
            LibString.toString(block.chainid),
            "/",
            LibString.toHexString(c),
            "/",
            LibString.toString(id)
        );
    }

    // ---- initialization state ----

    function test_InitialState() public view {
        assertEq(nft.owner(), owner);
        assertEq(nft.name(), "Postcards");
        assertEq(nft.symbol(), "PC");
        assertEq(nft.maxInvocations(), N);
        assertEq(nft.totalSupply(), 0);
        assertEq(nft.nextTokenId(), 0);
        assertEq(nft.abxVersion(), AbxVersion.CORE_VERSION);
        assertEq(nft.extensionVersion(MAX_INVOCATIONS_ID), 1);
        assertEq(nft.extensionVersion(EXTERNAL_MINTER_ID), 1);
        assertEq(nft.extensionVersion(PRIMARY_PAYEE_ID), 1);
        assertEq(nft.extensionVersion(PAUSED_ID), 1);
        assertEq(nft.extensionVersion(ONCHAIN_METADATA_ID), 1);
        assertEq(nft.extensionVersion(ROYALTY_ID), 2); // royalty ext v2: owner-set, reduce-only cap
        assertEq(nft.primaryPayee(), address(0));
        assertFalse(nft.paused()); // default test params deploy unpaused
    }

    function test_Deploy_RevertsZeroMaxInvocations() public {
        SeriesImage.InitParams memory p = _params();
        p.maxInvocations = 0;
        vm.expectRevert(MaxInvocations.InvalidMaxInvocations.selector);
        _deploy(p);
    }

    function test_Deploy_RevertsMintCountOverMax() public {
        SeriesImage.InitParams memory p = _params();
        p.mintTo = owner;
        p.mintCount = N + 1;
        vm.expectRevert(SeriesImage.MintCountExceedsMax.selector);
        _deploy(p);
    }

    function test_CannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        nft.initialize(_params());
    }

    // ---- mint-all-at-deploy ----

    function test_MintAllAtDeploy() public {
        SeriesImage.InitParams memory p = _params();
        p.mintTo = owner;
        p.mintCount = N;
        SeriesImage n = _deploy(p);

        assertEq(n.totalSupply(), N);
        assertEq(n.nextTokenId(), N);
        for (uint256 i; i < N; ++i) {
            assertEq(n.ownerOf(i), owner);
        }
    }

    function test_TokenURI_DerivesGrammarPerToken() public {
        vm.chainId(11155111);
        SeriesImage.InitParams memory p = _params();
        p.mintTo = owner;
        p.mintCount = N;
        SeriesImage n = _deploy(p);
        assertEq(n.tokenURI(3), _derivedToken(address(n), 3, "https://abx.test/t"));
        assertTrue(LibString.endsWith(n.tokenURI(3), "/3"));
    }

    // ---- deferred + in-order minting ----

    function test_MintInOrder_AssignsSequentialAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), buyer, 0);
        vm.prank(owner);
        nft.mint(buyer);

        assertEq(nft.ownerOf(0), buyer);
        assertEq(nft.nextTokenId(), 1);
    }

    function test_Mint_ReturnsMintedId() public {
        // the IAbxSequentialMint contract: mint returns the id it just assigned, in order.
        vm.startPrank(owner);
        assertEq(nft.mint(buyer), 0);
        assertEq(nft.mint(buyer), 1);
        assertEq(nft.mint(buyer), 2);
        vm.stopPrank();
    }

    function test_MintMany_InOrder() public {
        vm.prank(owner);
        nft.mintMany(owner, 3);
        assertEq(nft.totalSupply(), 3);
        assertEq(nft.nextTokenId(), 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(nft.ownerOf(i), owner);
        }
    }

    // ---- cap guard ----

    function test_Mint_RevertsWhenSoldOut() public {
        vm.startPrank(owner);
        nft.mintMany(owner, N); // mint the whole series in order
        vm.expectRevert(MaxInvocations.MaxInvocationsReached.selector);
        nft.mint(owner); // N+1th mint exceeds the cap
        vm.stopPrank();
    }

    // ---- mint authorization (owner + external minter) ----

    function test_Mint_OnlyMinterOrOwner() public {
        vm.prank(stranger);
        vm.expectRevert(ExternalMinter.NotMinterOrOwner.selector);
        nft.mint(buyer);
    }

    function test_Minter_CanMint() public {
        vm.expectEmit(true, false, false, false);
        emit MinterSet(minter);
        vm.prank(owner);
        nft.setMinter(minter);
        assertEq(nft.minter(), minter);

        vm.prank(minter);
        nft.mint(buyer);
        assertEq(nft.ownerOf(0), buyer);
    }

    function test_Minter_SetAtDeploy() public {
        SeriesImage.InitParams memory p = _params();
        p.minter = minter;
        SeriesImage n = _deploy(p);
        assertEq(n.minter(), minter);
        vm.prank(minter);
        n.mint(buyer);
        assertEq(n.ownerOf(0), buyer);
    }

    function test_SetMinter_ReplacesAndClears() public {
        vm.startPrank(owner);
        nft.setMinter(minter);
        // setting a new minter atomically replaces the old — the old one can no longer mint.
        address minter2 = makeAddr("minter2");
        nft.setMinter(minter2);
        assertEq(nft.minter(), minter2);
        vm.stopPrank();
        vm.prank(minter);
        vm.expectRevert(ExternalMinter.NotMinterOrOwner.selector);
        nft.mint(buyer);
        // clearing to address(0) → owner-only again
        vm.prank(owner);
        nft.setMinter(address(0));
        assertEq(nft.minter(), address(0));
        vm.prank(minter2);
        vm.expectRevert(ExternalMinter.NotMinterOrOwner.selector);
        nft.mint(buyer);
    }

    function test_SetMinter_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setMinter(minter);
    }

    // ---- max invocations (monotonic, floor, close-early) ----

    function test_SetMaxInvocations_LowerOk() public {
        vm.expectEmit(false, false, false, true);
        emit MaxInvocationsUpdated(3);
        vm.prank(owner);
        nft.setMaxInvocations(3);
        assertEq(nft.maxInvocations(), 3);
    }

    function test_SetMaxInvocations_RevertsIncrease() public {
        vm.prank(owner);
        vm.expectRevert(MaxInvocations.MaxInvocationsIncreaseForbidden.selector);
        nft.setMaxInvocations(N + 1);
    }

    function test_SetMaxInvocations_RevertsBelowMinted() public {
        vm.startPrank(owner);
        nft.mintMany(owner, 3); // 3 minted
        vm.expectRevert(MaxInvocations.MaxInvocationsBelowFloor.selector);
        nft.setMaxInvocations(2); // below the floor (totalSupply)
        vm.stopPrank();
    }

    function test_SetMaxInvocations_CloseEditionEarly() public {
        vm.startPrank(owner);
        nft.mintMany(owner, 2);
        nft.setMaxInvocations(2); // == totalSupply: closes the edition
        vm.expectRevert(MaxInvocations.MaxInvocationsReached.selector);
        nft.mint(owner);
        vm.stopPrank();
    }

    function test_SetMaxInvocations_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setMaxInvocations(3);
    }

    // ---- primary payee ----

    function test_PrimaryPayee_SetAtDeploy_Emits() public {
        SeriesImage.InitParams memory p = _params();
        p.primaryPayee = royaltyReceiver;
        vm.expectEmit(true, false, false, false);
        emit PrimaryPayeeChanged(royaltyReceiver);
        SeriesImage n = _deploy(p);
        assertEq(n.primaryPayee(), royaltyReceiver);
    }

    function test_PrimaryPayee_OwnerSets() public {
        vm.expectEmit(true, false, false, false);
        emit PrimaryPayeeChanged(buyer);
        vm.prank(owner);
        nft.setPrimaryPayee(buyer);
        assertEq(nft.primaryPayee(), buyer);
    }

    function test_PrimaryPayee_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setPrimaryPayee(buyer);
    }

    // ---- paused: the owner-bypass mint gate ----

    function _pausedWithMinter() internal returns (SeriesImage n) {
        SeriesImage.InitParams memory p = _params();
        p.paused = true;
        p.minter = minter;
        n = _deploy(p);
        assertTrue(n.paused());
    }

    function test_Paused_SetAtDeploy_Emits() public {
        SeriesImage.InitParams memory p = _params();
        p.paused = true;
        vm.expectEmit(false, false, false, true);
        emit PausedStatusChanged(true);
        SeriesImage n = _deploy(p);
        assertTrue(n.paused());
    }

    function test_Paused_OwnerCanStillMint() public {
        SeriesImage n = _pausedWithMinter();
        // paused blocks the minter/public, but the OWNER may always mint (reserves/config).
        vm.prank(owner);
        n.mint(owner);
        assertEq(n.ownerOf(0), owner);
        assertEq(n.totalSupply(), 1);
    }

    function test_Paused_MinterBlocked() public {
        SeriesImage n = _pausedWithMinter();
        vm.prank(minter);
        vm.expectRevert(SeriesImage.MintingPaused.selector);
        n.mint(buyer);
    }

    function test_Paused_PublicBlocked() public {
        SeriesImage n = _pausedWithMinter();
        vm.prank(stranger);
        vm.expectRevert(SeriesImage.MintingPaused.selector);
        n.mint(buyer);
    }

    function test_Paused_DeployTimeMintBypassesPause() public {
        // Deploying paused AND minting reserves at deploy: the deploy-time mint runs through
        // initialize (not the public entrypoint), so it mints despite paused.
        SeriesImage.InitParams memory p = _params();
        p.paused = true;
        p.mintTo = owner;
        p.mintCount = 2;
        SeriesImage n = _deploy(p);
        assertTrue(n.paused());
        assertEq(n.totalSupply(), 2);
        assertEq(n.ownerOf(0), owner);
        assertEq(n.ownerOf(1), owner);
    }

    function test_Unpause_OpensTheMinter() public {
        SeriesImage n = _pausedWithMinter();
        vm.expectEmit(false, false, false, true);
        emit PausedStatusChanged(false);
        vm.prank(owner);
        n.setPaused(false);
        assertFalse(n.paused());
        // now the authorized minter may mint
        vm.prank(minter);
        n.mint(buyer);
        assertEq(n.ownerOf(0), buyer);
    }

    function test_SetPaused_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setPaused(true);
    }

    function test_Unpaused_StrangerStillNotMinter() public {
        // when unpaused, a non-minter non-owner gets the ordinary auth error (not MintingPaused).
        vm.prank(stranger);
        vm.expectRevert(ExternalMinter.NotMinterOrOwner.selector);
        nft.mint(buyer); // nft deploys unpaused with no minter
    }

    // ---- per-token on-chain metadata + renderer ----

    function test_OnChainTokenFields_AtInit() public {
        SeriesImage.InitParams memory p = _params();
        p.tokenFields = new IAbxOnChainMetadata.TokenFieldInput[](2);
        p.tokenFields[0] = IAbxOnChainMetadata.TokenFieldInput({
            tokenId: 0, field: IMAGE, representation: ARWEAVE, value: hex"1220aa"
        });
        p.tokenFields[1] = IAbxOnChainMetadata.TokenFieldInput({
            tokenId: 3, field: IMAGE, representation: ARWEAVE, value: hex"1220bb"
        });
        SeriesImage n = _deploy(p);

        (bytes32 rep0, bytes memory v0) = n.tokenField(0, IMAGE);
        (bytes32 rep3, bytes memory v3) = n.tokenField(3, IMAGE);
        assertEq(rep0, ARWEAVE);
        assertEq(v0, hex"1220aa");
        assertEq(rep3, ARWEAVE);
        assertEq(v3, hex"1220bb");
    }

    function test_Renderer_ResolvesPerTokenId() public {
        // Token 2 carries an on-chain name; the on-chain renderer path resolves it by token id.
        SeriesImage.InitParams memory p = _params();
        p.tokenURIRenderer = address(renderer);
        p.tokenFields = new IAbxOnChainMetadata.TokenFieldInput[](1);
        p.tokenFields[0] = IAbxOnChainMetadata.TokenFieldInput({
            tokenId: 2, field: NAME, representation: INLINE, value: bytes("Token Two")
        });
        SeriesImage n = _deploy(p);

        vm.prank(owner);
        n.mintMany(buyer, 3); // mint tokens 0,1,2 in order

        // tokenURI(2) routes through the renderer for token id 2.
        assertEq(n.tokenURI(2), renderer.tokenURI(address(n), 2));
    }

    function test_Renderer_CollectionUrlTemplate_CoversWholeSeries() public {
        // ONE collection-scope url-template image field renders EVERY token id (O(1) storage) —
        // the directory-base pattern: image bytes live in an Arweave manifest / IPFS dir off-chain,
        // the on-chain renderer derives each token's URL by substituting {id}. No server, any size.
        SeriesImage.InitParams memory p = _params();
        p.tokenURIRenderer = address(renderer);
        p.mintTo = owner;
        p.mintCount = N; // mint the whole series
        p.contractFields = new IAbxOnChainMetadata.FieldInput[](1);
        p.contractFields[0] = IAbxOnChainMetadata.FieldInput({
            field: IMAGE,
            representation: "url-template",
            value: bytes("https://arweave.net/MANIFEST/{id}.png")
        });
        SeriesImage n = _deploy(p);

        for (uint256 id = 0; id < N; id++) {
            string memory json = string(
                Base64.decode(
                    LibString.slice(n.tokenURI(id), bytes("data:application/json;base64,").length)
                )
            );
            assertTrue(
                LibString.contains(
                    json,
                    string.concat(
                        '"image":"https://arweave.net/MANIFEST/', LibString.toString(id), '.png"'
                    )
                ),
                "per-id image from one collection field"
            );
            assertTrue(LibString.contains(json, "[collection]"), "collection-scope provenance");
        }
    }

    function test_SetTokenField_PostDeploy() public {
        vm.expectEmit(true, true, false, true);
        emit TokenFieldSet(2, IMAGE, INLINE, bytes("<svg/>"));
        vm.prank(owner);
        nft.setTokenField(2, IMAGE, INLINE, bytes("<svg/>"));
        (bytes32 rep, bytes memory v) = nft.tokenField(2, IMAGE);
        assertEq(rep, INLINE);
        assertEq(v, bytes("<svg/>"));
    }

    // ---- ERC-165 ----

    function test_SupportsInterface() public view {
        assertTrue(nft.supportsInterface(0x01ffc9a7)); // ERC165
        assertTrue(nft.supportsInterface(0x80ac58cd)); // ERC721
        assertTrue(nft.supportsInterface(0x5b5e139f)); // ERC721Metadata
        assertTrue(nft.supportsInterface(0x2a55205a)); // ERC2981
        assertTrue(nft.supportsInterface(0x49064906)); // ERC4906
        assertTrue(nft.supportsInterface(type(IAbxBeacon).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxOnChainMetadata).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxMaxInvocations).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxExternalMinter).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxPrimaryPayee).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxPaused).interfaceId));
        assertTrue(nft.supportsInterface(type(IAbxSequentialMint).interfaceId)); // the mint primitive
        // the new extensions all expose reads → non-zero interface ids
        assertTrue(type(IAbxMaxInvocations).interfaceId != bytes4(0));
        assertTrue(type(IAbxExternalMinter).interfaceId != bytes4(0));
        assertTrue(type(IAbxPrimaryPayee).interfaceId != bytes4(0));
        assertTrue(type(IAbxPaused).interfaceId != bytes4(0));
        assertFalse(nft.supportsInterface(0xdeadbeef));
        assertFalse(nft.supportsInterface(0x780e9d63)); // NOT ERC-721 Enumerable
    }

    // ---- transfer + royalty (inherited behavior, spot-check) ----

    function test_Transfer() public {
        vm.prank(owner);
        nft.mint(owner);
        vm.prank(owner);
        nft.transferFrom(owner, buyer, 0);
        assertEq(nft.ownerOf(0), buyer);
    }

    function test_RoyaltyResolution() public view {
        (address r, uint256 rate) = nft.royaltyInfo(0, 10_000);
        assertEq(r, royaltyReceiver);
        assertEq(rate, BPS);
    }
}
