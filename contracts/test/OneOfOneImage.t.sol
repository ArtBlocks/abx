// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {Initializable} from "solady/utils/Initializable.sol";
import {LibString} from "solady/utils/LibString.sol";

import {OneOfOneImage} from "../src/tokens/OneOfOneImage.sol";
import {OneOfOneImageFactory} from "../src/factories/OneOfOneImageFactory.sol";
import {TokenURI} from "../src/uri/token/TokenURI.sol";
import {ContractURI} from "../src/uri/contract/ContractURI.sol";
import {AbxVersion} from "../src/libraries/AbxVersion.sol";
import {IAbxBeacon} from "../src/interfaces/IAbxBeacon.sol";
import {IAbxRoyalty} from "../src/extensions/royalty/IAbxRoyalty.sol";
import {OnChainMetadata} from "../src/extensions/onchain-metadata/OnChainMetadata.sol";
import {IAbxOnChainMetadata} from "../src/extensions/onchain-metadata/IAbxOnChainMetadata.sol";

/// @notice Behavior of a deployed 1/1 clone (owner powers, on-chain metadata, royalty, ERC-165).
contract OneOfOneImageTest is Test {
    // canonical metadata tags are off-chain convention (spec + SDK); the contract is opaque.
    // These mirror them for the test only.
    bytes32 internal constant IMAGE = "image";
    bytes32 internal constant DESCRIPTION = "description";
    bytes32 internal constant INLINE = "inline";
    bytes32 internal constant KECCAK256 = "keccak256";
    bytes32 internal constant ARWEAVE = "arweave";

    // mirrored events for expectEmit
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    event TokenURIOverrideSet(uint256 indexed tokenId, string uri);
    event ContractURIUpdated();
    event RoyaltyChangedForAll(address indexed account, uint16 basisPoints);
    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event TokenFieldSet(
        uint256 indexed tokenId, bytes32 indexed field, bytes32 representation, bytes value
    );
    event TokenFieldLocked(uint256 indexed tokenId, bytes32 indexed field);
    event ContractFieldSet(bytes32 indexed field, bytes32 representation, bytes value);

    OneOfOneImageFactory internal factory;
    OneOfOneImage internal nft;

    address internal owner = makeAddr("owner");
    address internal royaltyReceiver = makeAddr("royaltyReceiver");
    address internal stranger = makeAddr("stranger");

    uint16 internal constant BPS = 500; // 5%

    // protocol spec values, asserted independently of the implementation's own constants
    bytes32 internal constant ROYALTY_ID = keccak256("abx.extension.royalty");
    uint16 internal constant ROYALTY_VERSION = 2;
    bytes32 internal constant ONCHAIN_METADATA_ID = keccak256("abx.extension.onchain-metadata");

    function setUp() public {
        factory = new OneOfOneImageFactory();
        nft = OneOfOneImage(factory.deploy(_params()));
    }

    function _params() internal view returns (OneOfOneImage.InitParams memory) {
        return OneOfOneImage.InitParams({
            owner: owner,
            mintTo: owner, // mint at deploy (the common case)
            name: "Sunrise",
            symbol: "SUN",
            tokenURIBase: "https://abx.test/t",
            tokenURIRenderer: address(0),
            contractURIBase: "https://abx.test/c",
            contractURIRenderer: address(0),
            royaltyReceiver: royaltyReceiver,
            royaltyBps: BPS,
            maxRoyaltyBps: 1000,
            burnable: false,
            transferValidator: address(0),
            tokenFields: new IAbxOnChainMetadata.FieldInput[](0),
            contractFields: new IAbxOnChainMetadata.FieldInput[](0)
        });
    }

    /// @dev Mirrors `TokenURI._composeTokenURI`: `{base}/{chainId}/{address}/{tokenId}` with a
    ///      lowercase 0x-address. The contract derives the off-chain pointer; tests compare to this.
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

    /// @dev Mirrors `ContractURI`: `{base}/{chainId}/{address}` (no tokenId).
    function _derivedContract(address c, string memory base) internal view returns (string memory) {
        return
            string.concat(
                base, "/", LibString.toString(block.chainid), "/", LibString.toHexString(c)
            );
    }

    // ---- initialization state ----

    function test_InitialState() public view {
        assertEq(nft.owner(), owner);
        assertEq(nft.ownerOf(0), owner);
        assertEq(nft.balanceOf(owner), 1);
        assertEq(nft.name(), "Sunrise");
        assertEq(nft.symbol(), "SUN");
        assertEq(nft.tokenURI(0), _derivedToken(address(nft), 0, "https://abx.test/t"));
        assertEq(nft.contractURI(), _derivedContract(address(nft), "https://abx.test/c"));
        assertEq(nft.tokenURIBase(), "https://abx.test/t");
        assertEq(nft.contractURIBase(), "https://abx.test/c");
        assertEq(nft.abxVersion(), AbxVersion.CORE_VERSION);
        assertEq(nft.extensionVersion(ROYALTY_ID), ROYALTY_VERSION);
        assertEq(nft.extensionVersion(ONCHAIN_METADATA_ID), 1);
    }

    function test_TokenURI_DerivesProtocolPathGrammar() public {
        // Pin a known chainId so the literal grammar is checkable, not just self-consistent.
        vm.chainId(11155111); // Sepolia
        OneOfOneImage n = OneOfOneImage(factory.deploy(_params()));
        string memory uri = n.tokenURI(0);
        // {base}/{chainId}/{address}/{tokenId} — chainId decimal, lowercase 0x-address, tokenId decimal.
        assertTrue(
            LibString.startsWith(uri, "https://abx.test/t/11155111/0x"), "base/chainId/0x prefix"
        );
        assertTrue(LibString.endsWith(uri, "/0"), "trailing /tokenId");
        assertEq(uri, _derivedToken(address(n), 0, "https://abx.test/t"));
        // contractURI follows the same grammar without a tokenId.
        assertTrue(
            LibString.startsWith(n.contractURI(), "https://abx.test/c/11155111/0x"),
            "contract grammar"
        );
        assertEq(n.contractURI(), _derivedContract(address(n), "https://abx.test/c"));
    }

    function test_RoyaltyResolution() public view {
        // ERC-2981 is the read surface; query with salePrice == 10_000 to read the rate.
        (address r, uint256 amount) = nft.royaltyInfo(0, 1 ether);
        assertEq(r, royaltyReceiver);
        assertEq(amount, 1 ether * uint256(BPS) / 10_000);

        (, uint256 rate) = nft.royaltyInfo(0, 10_000);
        assertEq(rate, BPS);
    }

    function test_SupportsInterface() public view {
        assertTrue(nft.supportsInterface(0x01ffc9a7)); // ERC165
        assertTrue(nft.supportsInterface(0x80ac58cd)); // ERC721
        assertTrue(nft.supportsInterface(0x5b5e139f)); // ERC721Metadata
        assertTrue(nft.supportsInterface(0x2a55205a)); // ERC2981
        assertTrue(nft.supportsInterface(0x49064906)); // ERC4906
        assertTrue(nft.supportsInterface(type(IAbxBeacon).interfaceId));
        // On-Chain Metadata has a read surface → non-zero id → IS ERC-165-advertised.
        assertTrue(type(IAbxOnChainMetadata).interfaceId != bytes4(0));
        assertTrue(nft.supportsInterface(type(IAbxOnChainMetadata).interfaceId));
        // Royalty extension is events-only (id 0x00000000) — discovered via the beacon,
        // not ERC-165. extensionVersion() proves support (see test_InitialState).
        assertEq(type(IAbxRoyalty).interfaceId, bytes4(0));
        assertFalse(nft.supportsInterface(0xdeadbeef));
    }

    // ---- owner powers ----

    function test_SetTokenURIBase_EmitsErc4906Batch() public {
        // Re-pointing the base may change every token's URI → the BatchMetadataUpdate ping.
        vm.expectEmit(true, true, true, true);
        emit BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(owner);
        nft.setTokenURIBase("https://node2.example/t");
        assertEq(nft.tokenURI(0), _derivedToken(address(nft), 0, "https://node2.example/t"));
    }

    function test_SetContractURIBase_Emits7572() public {
        vm.expectEmit(true, true, true, true);
        emit ContractURIUpdated();
        vm.prank(owner);
        nft.setContractURIBase("https://node2.example/c");
        assertEq(nft.contractURI(), _derivedContract(address(nft), "https://node2.example/c"));
    }

    // ---- the per-token override (the fixed-locator escape, e.g. ipfs://) ----

    function test_TokenURIOverride_WinsAndPingsTheToken() public {
        // A per-token override pins ONE token to a fixed locator, winning over the derived base,
        // and pings only that token (MetadataUpdate, not the batch).
        vm.expectEmit(true, true, true, true);
        emit TokenURIOverrideSet(0, "ipfs://frozen-doc");
        vm.expectEmit(true, true, true, true);
        emit MetadataUpdate(0);
        vm.prank(owner);
        nft.setTokenURIOverride(0, "ipfs://frozen-doc");

        assertEq(nft.tokenURIOverride(0), "ipfs://frozen-doc");
        assertEq(nft.tokenURI(0), "ipfs://frozen-doc"); // override wins, returned verbatim
        // clearing it (empty string) falls back to the derived base path
        vm.prank(owner);
        nft.setTokenURIOverride(0, "");
        assertEq(nft.tokenURI(0), _derivedToken(address(nft), 0, "https://abx.test/t"));
    }

    function test_ContractURIOverride_WinsOverBase() public {
        vm.prank(owner);
        nft.setContractURIOverride("ipfs://frozen-collection");
        assertEq(nft.contractURIOverride(), "ipfs://frozen-collection");
        assertEq(nft.contractURI(), "ipfs://frozen-collection");
    }

    // ---- lock freezes base + override + renderer (the immutable terminal state) ----

    function test_LockTokenURI_FreezesBaseOverrideAndRenderer() public {
        vm.prank(owner);
        nft.setTokenURIOverride(0, "ipfs://frozen-doc"); // the explicit immutable target
        vm.prank(owner);
        nft.lockTokenURI();
        assertTrue(nft.tokenURILocked());

        vm.startPrank(owner);
        vm.expectRevert(TokenURI.TokenURIConfigLocked.selector);
        nft.setTokenURIBase("https://elsewhere/t");
        vm.expectRevert(TokenURI.TokenURIConfigLocked.selector);
        nft.setTokenURIOverride(0, "ipfs://other");
        vm.expectRevert(TokenURI.TokenURIConfigLocked.selector);
        nft.setTokenURIRenderer(address(1));
        vm.stopPrank();
        assertEq(nft.tokenURI(0), "ipfs://frozen-doc"); // frozen forever
    }

    function test_LockContractURI_Freezes() public {
        vm.prank(owner);
        nft.lockContractURI();
        vm.prank(owner);
        vm.expectRevert(ContractURI.ContractURIConfigLocked.selector);
        nft.setContractURIBase("https://elsewhere/c");
    }

    function test_SetDefaultRoyalty_EmitsAndUpdates() public {
        vm.expectEmit(true, true, true, true);
        emit RoyaltyChangedForAll(stranger, 250);
        vm.prank(owner);
        nft.setDefaultRoyalty(stranger, 250);
        (address r, uint256 rate) = nft.royaltyInfo(0, 10_000);
        assertEq(r, stranger);
        assertEq(rate, 250);
    }

    function test_SetDefaultRoyalty_RevertsOverCap() public {
        vm.prank(owner);
        vm.expectRevert(bytes4(keccak256("RoyaltyTooHigh()")));
        nft.setDefaultRoyalty(stranger, 1_001); // > 10%
    }

    function test_SetDefaultRoyalty_RevertsZeroReceiverWithBps() public {
        // ERC-2981 forbids a zero receiver for a non-zero royalty (would burn royalties).
        vm.prank(owner);
        vm.expectRevert(bytes4(keccak256("RoyaltyReceiverIsZeroAddress()")));
        nft.setDefaultRoyalty(address(0), 250);
    }

    function test_SetDefaultRoyalty_ZeroBpsClearsRoyalty() public {
        // bps == 0 is the clean "no royalty" path — receiver ignored, royalty cleared.
        vm.prank(owner);
        nft.setDefaultRoyalty(address(0), 0);
        (address r, uint256 amount) = nft.royaltyInfo(0, 1 ether);
        assertEq(r, address(0));
        assertEq(amount, 0);
    }

    // ---- access control ----

    function test_OnlyOwner_TokenURI() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setTokenURIBase("x");
    }

    function test_OnlyOwner_TokenURIOverride() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setTokenURIOverride(0, "ipfs://x");
    }

    function test_OnlyOwner_ContractURI() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setContractURIBase("x");
    }

    function test_OnlyOwner_Royalty() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setDefaultRoyalty(stranger, 100);
    }

    // ---- misc ----

    function test_TokenURI_RevertsForNonexistent() public {
        vm.expectRevert(bytes4(keccak256("NonexistentToken()")));
        nft.tokenURI(1);
    }

    function test_Transfer() public {
        vm.prank(owner);
        nft.transferFrom(owner, stranger, 0);
        assertEq(nft.ownerOf(0), stranger);
    }

    function test_CannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        nft.initialize(_params());
    }

    // ---- deferred mint (mintTo == 0) ----

    function _deferredParams() internal view returns (OneOfOneImage.InitParams memory p) {
        p = _params();
        p.mintTo = address(0); // deploy without minting
    }

    function test_DeployWithoutMint_TokenDoesNotExist() public {
        OneOfOneImage n = OneOfOneImage(factory.deploy(_deferredParams()));
        assertEq(n.owner(), owner); // admin set even though nothing minted
        assertEq(n.balanceOf(owner), 0);
        vm.expectRevert(bytes4(keccak256("TokenDoesNotExist()")));
        n.ownerOf(0);
        // URIs are stored at init but tokenURI gates on existence (the resolver
        // serves metadata off-chain regardless — that's how it warms before mint).
        vm.expectRevert(bytes4(keccak256("NonexistentToken()")));
        n.tokenURI(0);
    }

    function test_Mint_OwnerMintsLater() public {
        OneOfOneImage n = OneOfOneImage(factory.deploy(_deferredParams()));
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), owner, 0);
        vm.prank(owner);
        n.mint(owner);
        assertEq(n.ownerOf(0), owner);
        assertEq(n.tokenURI(0), _derivedToken(address(n), 0, "https://abx.test/t"));
    }

    function test_Mint_ToBuyerOnPrimarySale() public {
        OneOfOneImage n = OneOfOneImage(factory.deploy(_deferredParams()));
        vm.prank(owner);
        n.mint(stranger); // primary sale: settle off-chain, mint to the buyer
        assertEq(n.ownerOf(0), stranger);
        assertEq(n.owner(), owner); // admin unchanged
    }

    function test_Mint_OnlyOwner() public {
        OneOfOneImage n = OneOfOneImage(factory.deploy(_deferredParams()));
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        n.mint(stranger);
    }

    function test_Mint_CannotMintTwice() public {
        // The 1/1 invariant: minting again reverts (token id 0 already exists).
        vm.prank(owner);
        vm.expectRevert(bytes4(keccak256("TokenAlreadyExists()")));
        nft.mint(owner); // nft already minted at deploy in setUp
    }

    // ---- on-chain metadata extension (field → {representation, value}) ----

    function _tokenVal(OneOfOneImage n, uint256 id, bytes32 field)
        internal
        view
        returns (bytes memory v)
    {
        (, v) = n.tokenField(id, field);
    }

    function _tokenRep(OneOfOneImage n, uint256 id, bytes32 field)
        internal
        view
        returns (bytes32 rep)
    {
        (rep,) = n.tokenField(id, field);
    }

    function test_OnChainMetadata_TokenFieldAtInit() public {
        bytes memory cid = hex"1220abcd"; // illustrative CID
        OneOfOneImage.InitParams memory p = _params();
        p.tokenFields = new IAbxOnChainMetadata.FieldInput[](1);
        p.tokenFields[0] =
            IAbxOnChainMetadata.FieldInput({field: IMAGE, representation: ARWEAVE, value: cid});

        OneOfOneImage n = OneOfOneImage(factory.deploy(p));
        assertEq(_tokenRep(n, 0, IMAGE), ARWEAVE);
        assertEq(_tokenVal(n, 0, IMAGE), cid);
        assertEq(n.extensionVersion(ONCHAIN_METADATA_ID), 1);
        assertFalse(n.tokenFieldLocked(0, IMAGE));
    }

    function test_OnChainMetadata_OwnerSet_Emits() public {
        bytes memory txid = abi.encodePacked(keccak256("arweave-tx")); // 32 bytes
        vm.expectEmit(true, true, false, true); // tokenId + field indexed; representation is data
        emit TokenFieldSet(0, IMAGE, ARWEAVE, txid);
        vm.prank(owner);
        nft.setTokenField(0, IMAGE, ARWEAVE, txid);
        assertEq(_tokenRep(nft, 0, IMAGE), ARWEAVE);
        assertEq(_tokenVal(nft, 0, IMAGE), txid);
    }

    function test_OnChainMetadata_InlineDescriptionOnChain() public {
        // The optional-on-chain field path: a `description` carried `inline` as literal UTF-8 —
        // durable + reconstructable from chain alone. The resolver prefers it.
        bytes memory desc = bytes("A sustained signal held flat and bright while harmonics decay.");
        vm.prank(owner);
        nft.setTokenField(0, DESCRIPTION, INLINE, desc);
        assertEq(_tokenRep(nft, 0, DESCRIPTION), INLINE);
        assertEq(_tokenVal(nft, 0, DESCRIPTION), desc);
        assertFalse(nft.tokenFieldLocked(0, DESCRIPTION));
    }

    function test_OnChainMetadata_SettingFieldReplacesRepresentation() public {
        // One active representation per field: re-setting swaps both representation + value.
        vm.startPrank(owner);
        nft.setTokenField(0, IMAGE, KECCAK256, hex"1234");
        assertEq(_tokenRep(nft, 0, IMAGE), KECCAK256);
        nft.setTokenField(0, IMAGE, INLINE, bytes("<svg/>"));
        vm.stopPrank();
        assertEq(_tokenRep(nft, 0, IMAGE), INLINE);
        assertEq(_tokenVal(nft, 0, IMAGE), bytes("<svg/>"));
    }

    function test_OnChainMetadata_CollectionField() public {
        // Collection-scope store (ERC-7572 contract metadata), independent of any token.
        bytes memory desc = bytes("A study in persistence.");
        vm.expectEmit(true, false, false, true); // field indexed; representation is data
        emit ContractFieldSet(DESCRIPTION, INLINE, desc);
        vm.prank(owner);
        nft.setContractField(DESCRIPTION, INLINE, desc);
        (bytes32 rep, bytes memory val) = nft.contractField(DESCRIPTION);
        assertEq(rep, INLINE);
        assertEq(val, desc);
    }

    function test_OnChainMetadata_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(Ownable.Unauthorized.selector);
        nft.setTokenField(0, IMAGE, KECCAK256, hex"1234");
    }

    function test_OnChainMetadata_EmptyReverts() public {
        vm.prank(owner);
        vm.expectRevert(OnChainMetadata.EmptyFieldValue.selector);
        nft.setTokenField(0, IMAGE, KECCAK256, "");
    }

    function test_OnChainMetadata_PerFieldLock() public {
        vm.startPrank(owner);
        nft.setTokenField(0, IMAGE, KECCAK256, hex"1234");
        vm.expectEmit(true, true, false, true);
        emit TokenFieldLocked(0, IMAGE);
        nft.lockTokenField(0, IMAGE);
        // locking `image` freezes it regardless of representation…
        vm.expectRevert(OnChainMetadata.FieldLocked.selector);
        nft.setTokenField(0, IMAGE, KECCAK256, hex"5678");
        vm.expectRevert(OnChainMetadata.FieldLocked.selector);
        nft.setTokenField(0, IMAGE, INLINE, hex"5678");
        // …but a different field stays editable (per-field, not all-or-nothing)
        nft.setTokenField(0, DESCRIPTION, INLINE, bytes("still editable"));
        vm.stopPrank();
        assertTrue(nft.tokenFieldLocked(0, IMAGE));
        assertFalse(nft.tokenFieldLocked(0, DESCRIPTION));
        assertEq(_tokenVal(nft, 0, IMAGE), hex"1234");
    }

    // ── totalSupply: live mint counter (NOT full ERC-721 Enumerable) ─────────────

    function test_TotalSupply_TracksMint() public {
        // setUp minted token #0 at deploy.
        assertEq(nft.totalSupply(), 1);

        // A fresh clone that defers the mint starts at 0, then counts up on mint.
        OneOfOneImage.InitParams memory p = _params();
        p.mintTo = address(0);
        OneOfOneImage fresh = OneOfOneImage(factory.deploy(p));
        assertEq(fresh.totalSupply(), 0);
        vm.prank(owner);
        fresh.mint(owner);
        assertEq(fresh.totalSupply(), 1);
    }

    function test_DoesNotClaimEnumerable() public view {
        // We expose totalSupply() standalone but deliberately do NOT implement/advertise
        // full ERC-721 Enumerable (tokenByIndex/tokenOfOwnerByIndex) — so the 165 id is false.
        assertFalse(nft.supportsInterface(0x780e9d63)); // ERC-721 Enumerable
        assertTrue(nft.supportsInterface(0x80ac58cd)); // ERC-721 (still a proper NFT)
    }
}
