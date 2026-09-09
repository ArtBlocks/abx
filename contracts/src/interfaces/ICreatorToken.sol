// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.28;

/// @title ICreatorToken — the ERC-721C creator-token surface (Register 1 standard)
/// @notice The transfer-validator read/manage surface royalty-enforcing marketplaces
///         probe for. ERC-165 id: 0xad0d7f6c. Stock ERC-721C advertises this *and*
///         {ICreatorTokenLegacy}; ABX tokens advertise both only when enrolled.
interface ICreatorToken {
    /// @notice The transfer validator changed (zero = enforcement suspended).
    event TransferValidatorUpdated(address oldValidator, address newValidator);

    /// @notice The active transfer validator (zero when unenrolled or suspended).
    function getTransferValidator() external view returns (address validator);

    /// @notice Point the token at a new transfer validator (zero suspends enforcement).
    function setTransferValidator(address validator) external;

    /// @notice The validator function transfers are checked against, and whether it's a view.
    function getTransferValidationFunction()
        external
        view
        returns (bytes4 functionSignature, bool isViewFunction);
}

/// @title ICreatorTokenLegacy — the pre-`getTransferValidationFunction` creator-token surface
/// @notice The subset older marketplaces probe for. ERC-165 id: 0xa07d229a.
interface ICreatorTokenLegacy {
    /// @notice The transfer validator changed (zero = enforcement suspended).
    event TransferValidatorUpdated(address oldValidator, address newValidator);

    /// @notice The active transfer validator (zero when unenrolled or suspended).
    function getTransferValidator() external view returns (address validator);

    /// @notice Point the token at a new transfer validator (zero suspends enforcement).
    function setTransferValidator(address validator) external;
}
