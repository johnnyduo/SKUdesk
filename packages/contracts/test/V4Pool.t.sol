// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from 'forge-std/Test.sol';
import {IPoolManager} from '../src/v4/core/interfaces/IPoolManager.sol';
import {PoolKey} from '../src/v4/core/types/PoolKey.sol';
import {PoolId} from '../src/v4/core/types/PoolId.sol';
import {Currency} from '../src/v4/core/types/Currency.sol';
import {BalanceDelta} from '../src/v4/core/types/BalanceDelta.sol';
import {ModifyLiquidityParams} from '../src/v4/core/types/PoolOperation.sol';
import {TickMath} from '../src/v4/core/libraries/TickMath.sol';
import {FullMath} from '../src/v4/core/libraries/FullMath.sol';
import {UnitReceiptToken} from '../src/v4/UnitReceiptToken.sol';
import {V4LiquidityHelper} from '../src/v4/V4LiquidityHelper.sol';
import {V4SwapHelper} from '../src/v4/V4SwapHelper.sol';
import {V4PoolParams} from '../script/DeployV4Pool.s.sol';

interface IMusdc {
    function owner() external view returns (address);
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// @notice Pure (non-fork) checks of the V4PoolParams math. No RPC needed, so these always run.
contract V4PoolPureTest is Test {
    uint256 constant PRICE_CENTS = 1099; // 10.99 mUSDC per unit
    uint160 constant SQRT_10_99_X96 = 262650619782058807908119467889;

    function test_sqrtPriceMath_isExactFloor() public pure {
        uint160 s = V4PoolParams.sqrtPriceX96For(PRICE_CENTS, true);
        assertEq(s, SQRT_10_99_X96);
        // s^2 <= 10.99 * 2^192 < (s+1)^2, checked in integers (times 100)
        assertLe(uint256(s) * s * 100, PRICE_CENTS << 192);
        assertGt((uint256(s) + 1) * (uint256(s) + 1) * 100, PRICE_CENTS << 192);
        uint160 inv = V4PoolParams.sqrtPriceX96For(PRICE_CENTS, false);
        assertLe(uint256(inv) * inv * PRICE_CENTS, uint256(100) << 192);
        assertGt((uint256(inv) + 1) * (uint256(inv) + 1) * PRICE_CENTS, uint256(100) << 192);
    }

    function test_range_alignedAndAboutHalfEitherSide() public pure {
        (int24 lo, int24 hi) = V4PoolParams.range(SQRT_10_99_X96);
        assertEq(lo, 19860); // tick(10.99) = 23971; 23971 - 4055 = 19916 -> floor to 60
        assertEq(hi, 28080); // 23971 + 4055 = 28026 -> ceil to 60
        assertEq(lo % 60, 0);
        assertEq(hi % 60, 0);
        (int24 lo1, int24 hi1) = V4PoolParams.range(V4PoolParams.sqrtPriceX96For(PRICE_CENTS, false));
        assertEq(lo1, -28080); // inverse ordering: tick(1/10.99) = -23972
        assertEq(hi1, -19860);
    }
}

/// @notice Fork tests against the real Uniswap v4 PoolManager on Robinhood Chain Testnet (46630).
///         Read-only fork: nothing is broadcast. Skipped (with a reason) when the RPC is unreachable.
///         RPC: env ROBINHOOD_RPC, default https://rpc.testnet.chain.robinhood.com
contract V4PoolTest is Test {
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant MUSDC = 0xee1a9ef855AF50eAd6a3E62974EAd4d85A9465b8;
    uint256 constant PRICE_CENTS = 1099; // 10.99 mUSDC per unit
    uint256 constant SEED_UNITS = 1000e6;
    // floor(sqrt(1099 * 2^192 / 100)), see V4PoolParams; checked against an integer bracket below.
    uint160 constant SQRT_10_99_X96 = 262650619782058807908119467889;
    // 0xc0ffee sorts below mUSDC (unit = currency0); 0xfff...4110 sorts above it (unit = currency1).
    address constant UNIT_LOW = address(0x0000000000000000000000000000000000C0FFEE);
    address constant UNIT_HIGH = address(uint160(type(uint160).max - 0xbeef));

    V4LiquidityHelper lh;
    V4SwapHelper sh;
    address lp = makeAddr('lp');
    address trader = makeAddr('trader');

    struct Pool { PoolKey key; bytes32 id; bool unitIs0; UnitReceiptToken unit; uint160 sqrtP; int24 lo; int24 hi; uint128 liq; }

    function setUp() public {
        string memory rpc = vm.envOr('ROBINHOOD_RPC', string('https://rpc.testnet.chain.robinhood.com'));
        try vm.createSelectFork(rpc) returns (uint256) {}
        catch {
            vm.skip(true, 'V4Pool fork tests skipped: Robinhood Chain Testnet RPC unreachable (set ROBINHOOD_RPC)');
            return;
        }
        vm.setEvmVersion('cancun'); // PoolManager uses transient storage (TLOAD/TSTORE)
        require(address(PM).code.length > 0, 'no PoolManager on fork');
        lh = new V4LiquidityHelper(PM);
        sh = new V4SwapHelper(PM);
    }

    // ---------------------------------------------------------------- storage reads (v4-core layout)
    // PoolManager._pools is at slot 6 (StateLibrary.POOLS_SLOT); Pool.State = {slot0, feeGrowth0, feeGrowth1,
    // liquidity (+3), ticks (+4), tickBitmap (+5), positions (+6)}.
    function _state(bytes32 id) internal pure returns (bytes32) { return keccak256(abi.encode(id, uint256(6))); }

    function _slot0(bytes32 id) internal view returns (uint160 sqrtP, int24 tick, uint24 protocolFee, uint24 lpFee) {
        uint256 w = uint256(PM.extsload(_state(id)));
        sqrtP = uint160(w);
        tick = int24(uint24(w >> 160));
        protocolFee = uint24(w >> 184);
        lpFee = uint24(w >> 208);
    }

    function _liquidity(bytes32 id) internal view returns (uint128) {
        return uint128(uint256(PM.extsload(bytes32(uint256(_state(id)) + 3))));
    }

    function _tickGross(bytes32 id, int24 t) internal view returns (uint128 gross, int128 net) {
        uint256 w = uint256(PM.extsload(keccak256(abi.encode(int256(t), uint256(_state(id)) + 4))));
        gross = uint128(w);
        net = int128(int256(w >> 128));
    }

    function _positionLiquidity(bytes32 id, address owner, int24 lo, int24 hi, bytes32 salt) internal view returns (uint128) {
        bytes32 posKey = keccak256(abi.encodePacked(owner, lo, hi, salt));
        return uint128(uint256(PM.extsload(keccak256(abi.encode(posKey, uint256(_state(id)) + 6)))));
    }

    // ---------------------------------------------------------------- setup helpers
    function _musdc(address to, uint256 amt) internal {
        vm.prank(IMusdc(MUSDC).owner());
        IMusdc(MUSDC).mint(to, amt);
    }

    function _init(address unitAt) internal returns (Pool memory p) {
        deployCodeTo('UnitReceiptToken.sol:UnitReceiptToken', unitAt);
        p.unit = UnitReceiptToken(unitAt);
        p.key = V4PoolParams.key(unitAt, MUSDC, address(0));
        p.id = keccak256(abi.encode(p.key));
        p.unitIs0 = Currency.unwrap(p.key.currency0) == unitAt;
        p.sqrtP = V4PoolParams.sqrtPriceX96For(PRICE_CENTS, p.unitIs0);
        PM.initialize(p.key, p.sqrtP);
        (p.lo, p.hi) = V4PoolParams.range(p.sqrtP);
        p.liq = V4PoolParams.liquidityForUnits(SEED_UNITS, p.unitIs0, p.sqrtP, p.lo, p.hi);
    }

    function _addLiquidity(Pool memory p) internal returns (uint256 units, uint256 usd) {
        (uint256 a0, uint256 a1) = V4PoolParams.amountsFor(p.liq, p.sqrtP, p.lo, p.hi);
        (units, usd) = p.unitIs0 ? (a0, a1) : (a1, a0);
        p.unit.mint(lp, units);
        _musdc(lp, usd);
        vm.startPrank(lp);
        p.unit.approve(address(lh), units);
        IMusdc(MUSDC).approve(address(lh), usd);
        BalanceDelta d = lh.modifyLiquidity(p.key, ModifyLiquidityParams(p.lo, p.hi, int256(uint256(p.liq)), bytes32(0)));
        vm.stopPrank();
        assertEq(-int256(d.amount0()), int256(a0), 'delta0 = charged amount0');
        assertEq(-int256(d.amount1()), int256(a1), 'delta1 = charged amount1');
    }

    function _noDust(Pool memory p) internal view {
        assertEq(p.unit.balanceOf(address(lh)), 0, 'units stuck in liquidity helper');
        assertEq(p.unit.balanceOf(address(sh)), 0, 'units stuck in swap helper');
        assertEq(IMusdc(MUSDC).balanceOf(address(lh)), 0, 'mUSDC stuck in liquidity helper');
        assertEq(IMusdc(MUSDC).balanceOf(address(sh)), 0, 'mUSDC stuck in swap helper');
    }

    /// Constant-product expectation from the virtual reserves of a single in-range position:
    /// x = L * 2^96 / sqrtP, y = L * sqrtP / 2^96, amountInLessFee = amountIn * (1e6 - 3000) / 1e6,
    /// out = reserveOut * inLessFee / (reserveIn + inLessFee).
    function _expectedOut(uint128 liq, uint160 sqrtP, bool zeroForOne, uint256 amountIn) internal pure returns (uint256) {
        uint256 x = FullMath.mulDiv(liq, 2 ** 96, sqrtP);
        uint256 y = FullMath.mulDiv(liq, sqrtP, 2 ** 96);
        uint256 inLessFee = amountIn * (1e6 - 3000) / 1e6;
        return zeroForOne ? FullMath.mulDiv(y, inLessFee, x + inLessFee) : FullMath.mulDiv(x, inLessFee, y + inLessFee);
    }

    function _swap(Pool memory p, bool sellUnits, uint256 amountIn) internal returns (uint256 out) {
        bool zeroForOne = sellUnits == p.unitIs0;
        (uint160 before,,,) = _slot0(p.id);
        uint256 expected = _expectedOut(_liquidity(p.id), before, zeroForOne, amountIn);
        if (sellUnits) p.unit.mint(trader, amountIn);
        else _musdc(trader, amountIn);
        address tin = sellUnits ? address(p.unit) : MUSDC;
        address tout = sellUnits ? MUSDC : address(p.unit);
        uint256 outBefore = IMusdc(tout).balanceOf(trader);
        uint256 inBefore = IMusdc(tin).balanceOf(trader);
        vm.startPrank(trader);
        IMusdc(tin).approve(address(sh), amountIn);
        out = sh.swapExactIn(p.key, zeroForOne, amountIn, expected - 2);
        vm.stopPrank();
        assertEq(inBefore - IMusdc(tin).balanceOf(trader), amountIn, 'exact input spent');
        assertEq(IMusdc(tout).balanceOf(trader) - outBefore, out, 'output delivered to trader');
        // the pool rounds against the trader: at most the expectation, and within 2 base units of it
        assertLe(out, expected, 'out <= constant-product expectation');
        assertApproxEqAbs(out, expected, 2, 'out ~= constant-product expectation');
        (uint160 afterP,,,) = _slot0(p.id);
        if (zeroForOne) assertLt(afterP, before, 'price of currency0 fell');
        else assertGt(afterP, before, 'price of currency0 rose');
    }

    // ---------------------------------------------------------------- tests
    function test_initialize_slot0_unitIsCurrency0() public {
        Pool memory p = _init(UNIT_LOW);
        assertTrue(p.unitIs0);
        assertEq(Currency.unwrap(p.key.currency1), MUSDC);
        assertEq(p.key.fee, 3000);
        assertEq(p.key.tickSpacing, 60);
        assertEq(address(p.key.hooks), address(0));
        assertEq(p.id, PoolId.unwrap(p.key.toId()));
        (uint160 sqrtP, int24 tick, uint24 protocolFee, uint24 lpFee) = _slot0(p.id);
        assertEq(sqrtP, SQRT_10_99_X96);
        assertEq(tick, 23971);
        assertEq(tick, TickMath.getTickAtSqrtPrice(SQRT_10_99_X96));
        assertEq(protocolFee, 0);
        assertEq(lpFee, 3000);
        assertEq(_liquidity(p.id), 0);
        // tick spacing 60 is enforced: a misaligned range reverts
        vm.expectRevert(abi.encodeWithSignature('TickMisaligned(int24,int24)', p.lo + 1, int24(60)));
        lh.modifyLiquidity(p.key, ModifyLiquidityParams(p.lo + 1, p.hi, 1e6, bytes32(0)));
    }

    function test_addLiquidity_inRange_unitIsCurrency0() public {
        Pool memory p = _init(UNIT_LOW);
        uint256 pmUnits = p.unit.balanceOf(address(PM));
        uint256 pmUsd = IMusdc(MUSDC).balanceOf(address(PM));
        (uint256 units, uint256 usd) = _addLiquidity(p);
        // ~1,000 units and ~10,990 mUSDC (range symmetric in ticks -> about equal value on both sides)
        assertApproxEqAbs(units, SEED_UNITS, 1);
        assertGt(usd, 10_900e6);
        assertLt(usd, 11_100e6);
        assertEq(p.unit.balanceOf(address(PM)) - pmUnits, units, 'units reached the PoolManager');
        assertEq(IMusdc(MUSDC).balanceOf(address(PM)) - pmUsd, usd, 'mUSDC reached the PoolManager');
        assertEq(p.unit.balanceOf(lp), 0);
        assertEq(IMusdc(MUSDC).balanceOf(lp), 0);
        assertEq(_liquidity(p.id), p.liq, 'active liquidity = position liquidity');
        (uint128 g0, int128 n0) = _tickGross(p.id, p.lo);
        (uint128 g1, int128 n1) = _tickGross(p.id, p.hi);
        assertEq(g0, p.liq);
        assertEq(g1, p.liq);
        assertEq(n0, int128(p.liq));
        assertEq(n1, -int128(p.liq));
        assertEq(_positionLiquidity(p.id, address(lh), p.lo, p.hi, lh.positionSalt(lp, bytes32(0))), p.liq);
        _noDust(p);
    }

    function test_swap_bothDirections_unitIsCurrency0() public {
        Pool memory p = _init(UNIT_LOW);
        _addLiquidity(p);
        uint256 usdOut = _swap(p, true, 10e6); // sell 10 units
        assertGt(usdOut, 108e6); // ~10.99 * 10 * 0.997 minus price impact
        assertLt(usdOut, 10.99e6 * 10);
        uint256 unitsOut = _swap(p, false, 100e6); // sell 100 mUSDC
        assertGt(unitsOut, 9e6);
        assertLt(unitsOut, uint256(100e6) * 100 / 1099);
        _noDust(p);
    }

    function test_inverseOrdering_unitIsCurrency1() public {
        Pool memory p = _init(UNIT_HIGH);
        assertFalse(p.unitIs0);
        assertEq(Currency.unwrap(p.key.currency0), MUSDC);
        (uint160 sqrtP, int24 tick,, uint24 lpFee) = _slot0(p.id);
        assertEq(sqrtP, V4PoolParams.sqrtPriceX96For(PRICE_CENTS, false));
        assertEq(tick, -23972);
        assertEq(lpFee, 3000);
        (uint256 units, uint256 usd) = _addLiquidity(p);
        assertApproxEqAbs(units, SEED_UNITS, 1);
        assertGt(usd, 10_900e6);
        assertLt(usd, 11_100e6);
        assertEq(_liquidity(p.id), p.liq);
        _swap(p, true, 10e6);
        _swap(p, false, 100e6);
        _noDust(p);
    }

    function test_removeLiquidity_onlyOwnNamespace() public {
        Pool memory p = _init(UNIT_LOW);
        (uint256 units, uint256 usd) = _addLiquidity(p);
        // a stranger cannot remove the LP's position: its salt maps to an empty position
        vm.prank(trader);
        vm.expectRevert(bytes4(keccak256('SafeCastOverflow()'))); // liquidity underflow on the stranger's empty position
        lh.modifyLiquidity(p.key, ModifyLiquidityParams(p.lo, p.hi, -int256(uint256(p.liq)), bytes32(0)));
        // the LP removes everything and gets back the deposit minus at most 1 base unit of rounding per side
        vm.prank(lp);
        lh.modifyLiquidity(p.key, ModifyLiquidityParams(p.lo, p.hi, -int256(uint256(p.liq)), bytes32(0)));
        assertApproxEqAbs(p.unit.balanceOf(lp), units, 1);
        assertLe(p.unit.balanceOf(lp), units);
        assertApproxEqAbs(IMusdc(MUSDC).balanceOf(lp), usd, 1);
        assertLe(IMusdc(MUSDC).balanceOf(lp), usd);
        assertEq(_liquidity(p.id), 0);
        _noDust(p);
    }

    function test_swap_minOutEnforced_and_callbackGuarded() public {
        Pool memory p = _init(UNIT_LOW);
        _addLiquidity(p);
        uint256 expected = _expectedOut(p.liq, p.sqrtP, true, 10e6);
        p.unit.mint(trader, 10e6);
        vm.startPrank(trader);
        p.unit.approve(address(sh), 10e6);
        vm.expectRevert(abi.encodeWithSelector(V4SwapHelper.InsufficientOutput.selector, expected, expected + 1));
        sh.swapExactIn(p.key, true, 10e6, expected + 1);
        vm.stopPrank();
        vm.expectRevert(V4SwapHelper.NotPoolManager.selector);
        sh.unlockCallback('');
        vm.expectRevert(V4LiquidityHelper.NotPoolManager.selector);
        lh.unlockCallback('');
    }
}
