// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from './core/interfaces/IPoolManager.sol';
import {Currency} from './core/types/Currency.sol';

/// @title V4Settle - settle / take one currency delta inside a Uniswap v4 unlock callback.
/// @notice ERC-20 currencies only. Debts are paid straight from `payer` to the PoolManager
///         (sync -> transferFrom -> settle); credits are taken straight to `payer`.
///         The calling helper never holds tokens.
library V4Settle {
    error NativeCurrencyUnsupported();
    error TransferFromFailed();

    function settleOrTake(IPoolManager pm, Currency currency, address payer, int128 delta) internal {
        if (delta == 0) return;
        if (currency.isAddressZero()) revert NativeCurrencyUnsupported();
        if (delta < 0) {
            uint256 owed = uint256(-int256(delta));
            pm.sync(currency);
            (bool ok, bytes memory ret) = Currency.unwrap(currency).call(
                abi.encodeWithSelector(0x23b872dd, payer, address(pm), owed) // transferFrom(address,address,uint256)
            );
            if (!ok || (ret.length == 0 && Currency.unwrap(currency).code.length == 0) || (ret.length != 0 && !abi.decode(ret, (bool)))) {
                revert TransferFromFailed();
            }
            pm.settle();
        } else {
            pm.take(currency, payer, uint256(int256(delta)));
        }
    }
}
