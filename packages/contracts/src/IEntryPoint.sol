// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev ERC-4337 v0.7 packed user operation (the layout the canonical EntryPoint 0x0000000071727De22E5E9d8BAf0edAc6f37da032 uses).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;   // verificationGasLimit (16 bytes) | callGasLimit (16 bytes)
    uint256 preVerificationGas;
    bytes32 gasFees;            // maxPriorityFeePerGas (16 bytes) | maxFeePerGas (16 bytes)
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPoint {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata op) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function depositTo(address account) external payable;
    function withdrawTo(address payable to, uint256 amount) external;
}
