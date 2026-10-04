// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from './core/interfaces/IPoolManager.sol';
import {IUnlockCallback} from './core/interfaces/callback/IUnlockCallback.sol';
import {PoolKey} from './core/types/PoolKey.sol';
import {PoolId} from './core/types/PoolId.sol';
import {BalanceDelta} from './core/types/BalanceDelta.sol';
import {SwapParams} from './core/types/PoolOperation.sol';
import {TickMath} from './core/libraries/TickMath.sol';
import {V4Settle} from './V4Settle.sol';

/// @title V4SwapHelper - exact-input swap on a Uniswap v4 pool (ERC-20 pairs, no hook data).
/// @notice Flow: caller -> swapExactIn -> PoolManager.unlock -> unlockCallback -> PoolManager.swap,
///         then the input is paid from the caller (sync -> transferFrom -> settle) and the output is taken to the caller.
///         Reverts if the output is below minAmountOut. The helper never holds tokens.
contract V4SwapHelper is IUnlockCallback {
    IPoolManager public immutable poolManager;

    event Swapped(address indexed trader, PoolId indexed poolId, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    error NotPoolManager();
    error AmountTooLarge();
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);

    constructor(IPoolManager pm) { poolManager = pm; }

    /// @param zeroForOne true sells currency0 for currency1, false sells currency1 for currency0.
    /// @param amountIn exact input amount (base units of the input currency).
    /// @param minAmountOut minimum output accepted (slippage bound).
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 amountOut)
    {
        if (amountIn == 0 || amountIn > uint256(uint128(type(int128).max))) revert AmountTooLarge();
        BalanceDelta delta = abi.decode(
            poolManager.unlock(abi.encode(msg.sender, key, zeroForOne, amountIn, minAmountOut)), (BalanceDelta)
        );
        (int128 dIn, int128 dOut) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        amountOut = uint256(int256(dOut));
        emit Swapped(msg.sender, key.toId(), zeroForOne, uint256(-int256(dIn)), amountOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (address payer, PoolKey memory key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut) =
            abi.decode(data, (address, PoolKey, bool, uint256, uint256));
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn), // negative = exact input
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ''
        );
        int128 out = zeroForOne ? delta.amount1() : delta.amount0();
        if (out < 0 || uint256(int256(out)) < minAmountOut) revert InsufficientOutput(out < 0 ? 0 : uint256(int256(out)), minAmountOut);
        V4Settle.settleOrTake(poolManager, key.currency0, payer, delta.amount0());
        V4Settle.settleOrTake(poolManager, key.currency1, payer, delta.amount1());
        return abi.encode(delta);
    }
}
