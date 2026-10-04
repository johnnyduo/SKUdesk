// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from 'forge-std/Script.sol';
import {IPoolManager} from '../src/v4/core/interfaces/IPoolManager.sol';
import {IHooks} from '../src/v4/core/interfaces/IHooks.sol';
import {PoolKey} from '../src/v4/core/types/PoolKey.sol';
import {Currency} from '../src/v4/core/types/Currency.sol';
import {ModifyLiquidityParams} from '../src/v4/core/types/PoolOperation.sol';
import {TickMath} from '../src/v4/core/libraries/TickMath.sol';
import {SqrtPriceMath} from '../src/v4/core/libraries/SqrtPriceMath.sol';
import {FullMath} from '../src/v4/core/libraries/FullMath.sol';
import {UnitReceiptToken} from '../src/v4/UnitReceiptToken.sol';
import {V4LiquidityHelper} from '../src/v4/V4LiquidityHelper.sol';
import {V4SwapHelper} from '../src/v4/V4SwapHelper.sol';

interface IMintable {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// @title V4PoolParams - pool parameters for the units / mUSDC Uniswap v4 reference pool.
/// @dev Both tokens have 6 decimals, so the raw-unit price equals the human price.
///      Uniswap price = currency1 per currency0, sqrtPriceX96 = sqrt(price) * 2^96.
///      If the unit token is currency0: price = P = priceCents / 100 (mUSDC per unit)
///          sqrtPriceX96 = floor(sqrt(priceCents * 2^192 / 100))
///          e.g. 10.99: floor(sqrt(1099 * 2^192 / 100)) = 262650619782058807908119467889
///      If the unit token is currency1: price = 1 / P
///          sqrtPriceX96 = floor(sqrt(100 * 2^192 / priceCents))
///      (floor(sqrt(floor(x))) == floor(sqrt(x)), so the integer division before the integer sqrt is exact.)
///      Range: TICK_OFFSET = 4055 ~= ln(1.5) / ln(1.0001) = 4054.85 ticks on each side of the start tick,
///      i.e. price / 1.5 .. price * 1.5 (-33% / +50%), symmetric in ticks, widened outwards to multiples of 60.
library V4PoolParams {
    uint24 internal constant FEE = 3000; // 0.30%
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant TICK_OFFSET = 4055;
    uint256 internal constant Q96 = 2 ** 96;

    function sqrtPriceX96For(uint256 priceCents, bool unitIsCurrency0) internal pure returns (uint160) {
        uint256 r = unitIsCurrency0 ? sqrt((priceCents << 192) / 100) : sqrt((uint256(100) << 192) / priceCents);
        return uint160(r);
    }

    function range(uint160 sqrtPriceX96) internal pure returns (int24 tickLower, int24 tickUpper) {
        int24 t = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
        tickLower = floorTo(t - TICK_OFFSET);
        tickUpper = -floorTo(-(t + TICK_OFFSET)); // ceil to spacing
    }

    function floorTo(int24 t) internal pure returns (int24) {
        int24 c = t / TICK_SPACING; // rounds toward zero
        if (t < 0 && t % TICK_SPACING != 0) c -= 1;
        return c * TICK_SPACING;
    }

    /// @notice Liquidity whose unit-token leg equals `units` (rounded down) for the given range at the start price.
    function liquidityForUnits(uint256 units, bool unitIsCurrency0, uint160 sqrtP, int24 tickLower, int24 tickUpper)
        internal pure returns (uint128)
    {
        uint160 sa = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sb = TickMath.getSqrtPriceAtTick(tickUpper);
        uint256 l = unitIsCurrency0
            ? FullMath.mulDiv(units, FullMath.mulDiv(sqrtP, sb, Q96), sb - sqrtP) // amount0 = L * (sb - sP) / (sP * sb)
            : FullMath.mulDiv(units, Q96, sqrtP - sa);                             // amount1 = L * (sP - sa)
        return uint128(l);
    }

    /// @notice Amounts the PoolManager charges (rounded up) to add `liq` at the start price.
    function amountsFor(uint128 liq, uint160 sqrtP, int24 tickLower, int24 tickUpper) internal pure returns (uint256 a0, uint256 a1) {
        a0 = SqrtPriceMath.getAmount0Delta(sqrtP, TickMath.getSqrtPriceAtTick(tickUpper), liq, true);
        a1 = SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(tickLower), sqrtP, liq, true);
    }

    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = 1 << ((_log2(x) >> 1) + 1); // > sqrt(x)
        uint256 y = (z + x / z) >> 1;
        while (y < z) { z = y; y = (z + x / z) >> 1; }
    }

    function _log2(uint256 x) private pure returns (uint256 r) {
        while (x > 1) { x >>= 1; r++; }
    }

    function key(address a, address b, address hooks) internal pure returns (PoolKey memory k) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), FEE, TICK_SPACING, IHooks(hooks));
    }
}

/// @notice Deploys the test unit token, the two v4 helpers, initializes the units / mUSDC pool (fee 0.30%,
///         tick spacing 60, no hook) on the existing PoolManager and seeds ~1,000 units of liquidity.
///         Env: PRICE_CENTS (default 1099 = 10.99 mUSDC per unit), SEED_UNITS (default 1000e6).
///         Run without --broadcast first, with --evm-version cancun (forge re-executes each tx against the
///         chain before sending, and the PoolManager's TLOAD/TSTORE need Cancun). Use a separate --out/--cache-path
///         (or FOUNDRY_OUT / FOUNDRY_CACHE_PATH) so the default Paris build in out/ is untouched.
///         Addresses must be read back from the chain afterwards.
contract DeployV4Pool is Script {
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant MUSDC = 0xee1a9ef855AF50eAd6a3E62974EAd4d85A9465b8;

    function run() external {
        vm.setEvmVersion('cancun'); // the PoolManager uses transient storage; local execution needs Cancun opcodes
        uint256 priceCents = vm.envOr('PRICE_CENTS', uint256(1099));
        uint256 seedUnits = vm.envOr('SEED_UNITS', uint256(1000e6));

        vm.startBroadcast();
        address me = msg.sender;
        UnitReceiptToken unit = new UnitReceiptToken();
        V4LiquidityHelper lh = new V4LiquidityHelper(PM);
        V4SwapHelper sh = new V4SwapHelper(PM);

        PoolKey memory k = V4PoolParams.key(address(unit), MUSDC, address(0));
        bool unitIs0 = Currency.unwrap(k.currency0) == address(unit);
        uint160 sqrtP = V4PoolParams.sqrtPriceX96For(priceCents, unitIs0);
        PM.initialize(k, sqrtP);

        (int24 lo, int24 hi) = V4PoolParams.range(sqrtP);
        uint128 liq = V4PoolParams.liquidityForUnits(seedUnits, unitIs0, sqrtP, lo, hi);
        (uint256 a0, uint256 a1) = V4PoolParams.amountsFor(liq, sqrtP, lo, hi);
        (uint256 needUnits, uint256 needUsd) = unitIs0 ? (a0, a1) : (a1, a0);

        unit.mint(me, needUnits);
        uint256 have = IMintable(MUSDC).balanceOf(me);
        if (have < needUsd) IMintable(MUSDC).mint(me, needUsd - have);
        unit.approve(address(lh), needUnits);
        IMintable(MUSDC).approve(address(lh), needUsd);
        lh.modifyLiquidity(k, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: int256(uint256(liq)), salt: bytes32(0)}));
        vm.stopBroadcast();

        console2.log('unit token', address(unit));
        console2.log('liquidity helper', address(lh));
        console2.log('swap helper', address(sh));
        console2.log('unit is currency0', unitIs0);
        console2.log('sqrtPriceX96', uint256(sqrtP));
        console2.logInt(lo);
        console2.logInt(hi);
        console2.log('liquidity', uint256(liq));
        console2.log('units seeded', needUnits);
        console2.log('mUSDC seeded', needUsd);
        console2.logBytes32(keccak256(abi.encode(k)));
    }
}
