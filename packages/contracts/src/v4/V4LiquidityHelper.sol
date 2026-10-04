// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from './core/interfaces/IPoolManager.sol';
import {IUnlockCallback} from './core/interfaces/callback/IUnlockCallback.sol';
import {PoolKey} from './core/types/PoolKey.sol';
import {PoolId} from './core/types/PoolId.sol';
import {BalanceDelta} from './core/types/BalanceDelta.sol';
import {ModifyLiquidityParams} from './core/types/PoolOperation.sol';
import {V4Settle} from './V4Settle.sol';

/// @title V4LiquidityHelper - add / remove liquidity on a Uniswap v4 pool (ERC-20 pairs, no hook data).
/// @notice Flow: caller -> modifyLiquidity -> PoolManager.unlock -> unlockCallback -> PoolManager.modifyLiquidity,
///         then each currency delta is settled from the caller (sync -> transferFrom -> settle) or taken to the caller.
///         The caller approves this helper for the amounts it is ready to pay; the helper never holds tokens.
/// @dev Positions are owned by this helper inside the PoolManager. To keep one caller from touching another
///      caller's position, the salt passed to the PoolManager is keccak256(abi.encode(caller, userSalt)), so every
///      caller has its own position namespace and receives the tokens of its own removals only.
///      unlockCallback is only accepted from the PoolManager, which only calls back the contract that called unlock(),
///      so the callback data always originates from modifyLiquidity below.
contract V4LiquidityHelper is IUnlockCallback {
    IPoolManager public immutable poolManager;

    event LiquidityModified(
        address indexed owner, PoolId indexed poolId, int24 tickLower, int24 tickUpper,
        int256 liquidityDelta, bytes32 salt, int128 amount0, int128 amount1
    );

    error NotPoolManager();

    constructor(IPoolManager pm) { poolManager = pm; }

    /// @notice Salt under which the PoolManager records `owner`'s position for `userSalt`.
    function positionSalt(address owner, bytes32 userSalt) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, userSalt));
    }

    /// @notice Add (liquidityDelta > 0) or remove (liquidityDelta < 0) liquidity for msg.sender.
    /// @return delta caller delta from the PoolManager (negative = paid by caller, positive = sent to caller).
    function modifyLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params) external returns (BalanceDelta delta) {
        ModifyLiquidityParams memory p = params;
        p.salt = positionSalt(msg.sender, params.salt);
        delta = abi.decode(poolManager.unlock(abi.encode(msg.sender, key, p)), (BalanceDelta));
        emit LiquidityModified(msg.sender, key.toId(), p.tickLower, p.tickUpper, p.liquidityDelta, p.salt, delta.amount0(), delta.amount1());
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (address payer, PoolKey memory key, ModifyLiquidityParams memory p) = abi.decode(data, (address, PoolKey, ModifyLiquidityParams));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(key, p, '');
        V4Settle.settleOrTake(poolManager, key.currency0, payer, delta.amount0());
        V4Settle.settleOrTake(poolManager, key.currency1, payer, delta.amount1());
        return abi.encode(delta);
    }
}
