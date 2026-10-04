// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {PackedUserOperation, IEntryPoint} from './IEntryPoint.sol';
import {SKUdeskCore} from './SKUdeskCore.sol';

/// @title AgentAccount - a locked ERC-4337 (v0.7) smart account for one AI agent.
/// @notice The account signs nothing itself: the agent key signs UserOperations. The account accepts ONLY
/// `execute(vault, 0, data)` where `data` starts with one of the vault's agent functions. It cannot call the token,
/// any other contract, the vault's owner functions, and it cannot send ETH to anyone. This is a second layer: the vault
/// still enforces every spending rule itself. Gas limits are capped and no priority tip is accepted, so the agent key cannot pay itself from the gas deposit.
/// The identity token is a name tag: owning or selling it does not move control of the vault or the account.
/// @dev Minimal single-purpose account. It is not an ERC-7579 / ERC-6900 modular account.
contract AgentAccount {
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    // The agent key could act as its own bundler and pay itself out of the gas deposit through huge gas limits or a tip.
    // Bounding the gas fields (and refusing any tip) limits that to the real cost of the operation.
    uint256 public constant MAX_VERIFICATION_GAS = 1_000_000;
    uint256 public constant MAX_CALL_GAS = 3_000_000;
    uint256 public constant MAX_PRE_VERIFICATION_GAS = 250_000;
    bytes4 internal constant ERC1271_OK = 0x1626ba7e;

    address public immutable entryPoint;
    address public immutable factory;
    address public vault;      // the only contract this account may call
    address public signer;     // the agent key
    address public owner;      // the human; can rotate the key and take back the gas deposit
    bool public initialized;

    error NotEntryPoint(); error NotFactory(); error NotOwner(); error AlreadyInitialized(); error ZeroAddress();
    error GasTooHigh(uint256 verificationGas, uint256 callGas, uint256 preVerificationGas); error TipNotAllowed(uint256 maxPriorityFeePerGas);
    error BadCall(); error TargetNotAllowed(address target); error ValueNotAllowed(uint256 value); error SelectorNotAllowed(bytes4 selector);
    error CallFailed(bytes reason); error PrefundFailed();

    event Initialized(address indexed vault, address indexed signer, address indexed owner);
    event SignerChanged(address indexed signer);

    constructor(address _entryPoint, address _factory) { entryPoint = _entryPoint; factory = _factory; }

    /// @notice One-time binding done by the factory in the same transaction that creates the account.
    function init(address _vault, address _signer, address _owner) external {
        if (msg.sender != factory) revert NotFactory();
        if (initialized) revert AlreadyInitialized();
        if (_vault == address(0) || _signer == address(0) || _owner == address(0)) revert ZeroAddress();
        initialized = true; vault = _vault; signer = _signer; owner = _owner;
        emit Initialized(_vault, _signer, _owner);
    }

    // ---------------- ERC-4337
    function validateUserOp(PackedUserOperation calldata op, bytes32 userOpHash, uint256 missingAccountFunds)
        external returns (uint256 validationData)
    {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        // The call rules are checked before the signature so a forbidden call never reaches execution (reverts the whole op).
        _checkCallData(op.callData);
        _checkGas(op);
        if (!_signedBySigner(_ethSigned(userOpHash), op.signature)) validationData = SIG_VALIDATION_FAILED;
        if (missingAccountFunds != 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}('');
            if (!ok) revert PrefundFailed();
        }
    }

    function execute(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _check(target, value, data);
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            // Bubble the vault's own custom error unchanged so wallets and the UI can explain it.
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    // ---------------- owner controls
    function setSigner(address s) external {
        if (msg.sender != owner) revert NotOwner();
        if (s == address(0)) revert ZeroAddress();
        signer = s; emit SignerChanged(s);
    }
    /// @notice Anyone can top up the gas deposit this account uses at the EntryPoint (plain ETH, no paymaster).
    function addDeposit() external payable { IEntryPoint(entryPoint).depositTo{value: msg.value}(address(this)); }
    function deposit() external view returns (uint256) { return IEntryPoint(entryPoint).balanceOf(address(this)); }
    function withdrawDeposit(address payable to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        IEntryPoint(entryPoint).withdrawTo(to, amount);
    }

    // ---------------- ERC-1271 (lets the agent key vouch for this account, e.g. ERC-8004 setAgentWallet)
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return _signedBySigner(hash, sig) ? ERC1271_OK : bytes4(0xffffffff);
    }

    receive() external payable {}

    // ---------------- the lock
    function _checkGas(PackedUserOperation calldata op) internal pure {
        uint256 verificationGas = uint128(bytes16(op.accountGasLimits)); uint256 callGas = uint128(uint256(op.accountGasLimits));
        if (verificationGas > MAX_VERIFICATION_GAS || callGas > MAX_CALL_GAS || op.preVerificationGas > MAX_PRE_VERIFICATION_GAS) revert GasTooHigh(verificationGas, callGas, op.preVerificationGas);
        uint256 tip = uint128(bytes16(op.gasFees));
        if (tip != 0) revert TipNotAllowed(tip);
    }

    function _checkCallData(bytes calldata cd) internal view {
        if (cd.length < 4 || bytes4(cd[:4]) != this.execute.selector) revert BadCall();
        (address target, uint256 value, bytes memory data) = abi.decode(cd[4:], (address, uint256, bytes));
        _check(target, value, data);
    }
    function _check(address target, uint256 value, bytes memory data) internal view {
        if (target != vault) revert TargetNotAllowed(target);
        if (value != 0) revert ValueNotAllowed(value);
        if (data.length < 4) revert BadCall();
        bytes4 sel; assembly { sel := mload(add(data, 32)) }
        if (!_agentSelector(sel)) revert SelectorNotAllowed(sel);
    }
    /// @dev Exactly the functions SKUdeskCore guards with `onlyAgent`.
    function _agentSelector(bytes4 s) internal pure returns (bool) {
        return s == SKUdeskCore.commitOpportunity.selector || s == SKUdeskCore.mintLot.selector
            || s == SKUdeskCore.fundLot.selector || s == SKUdeskCore.markPurchased.selector
            || s == SKUdeskCore.markReceived.selector || s == SKUdeskCore.markListed.selector
            || s == SKUdeskCore.markSold.selector || s == SKUdeskCore.settle.selector
            || s == SKUdeskCore.cancel.selector || s == SKUdeskCore.refund.selector;
    }

    // ---------------- signatures
    function _ethSigned(bytes32 h) internal pure returns (bytes32) { return keccak256(abi.encodePacked('\x19Ethereum Signed Message:\n32', h)); }
    function _signedBySigner(bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]); bytes32 s = bytes32(sig[32:64]); uint8 v = uint8(sig[64]);
        // reject malleable (high-s) signatures
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        if (v != 27 && v != 28) return false;
        address a = ecrecover(digest, v, r, s);
        return a != address(0) && a == signer;
    }
}
