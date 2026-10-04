// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from 'forge-std/Test.sol';
import {IPoolManager} from '../src/v4/core/interfaces/IPoolManager.sol';
import {PoolKey} from '../src/v4/core/types/PoolKey.sol';
import {Currency} from '../src/v4/core/types/Currency.sol';
import {TickMath} from '../src/v4/core/libraries/TickMath.sol';
import {FullMath} from '../src/v4/core/libraries/FullMath.sol';
import {V4SwapHelper} from '../src/v4/V4SwapHelper.sol';
import {V4PoolParams} from '../script/DeployV4Pool.s.sol';
import {RePoolV4, RePoolMath} from '../script/RePoolV4.s.sol';

/// @notice Throwaway 6-decimal owner-mint stable token, deployed only inside the fork.
contract ThrowawayStable6 {
    string public constant name = 'Throwaway stable (fork test only)';
    string public constant symbol = 'xSTBLTEST';
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public immutable owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address o) { owner = o; }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, 'not owner');
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, 'allowance');
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, 'balance');
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

interface IToken {
    function owner() external view returns (address);
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function allowance(address o, address s) external view returns (uint256);
}

/// @notice Exposes the deployment-file writer, which the script only reaches under `forge script --broadcast`.
contract RePoolV4WriteHarness is RePoolV4 {
    function writeDeployment(Params memory p, Plan memory pl, address me) external { _writeDeployment(p, pl, me); }
}

/// @notice Pure checks of RePoolMath (no RPC): the defaults reproduce V4PoolParams exactly.
contract RePoolV4PureTest is Test {
    function test_defaults_matchDeployV4PoolMath_bothOrderings() public pure {
        for (uint256 i; i < 2; i++) {
            bool unitIs0 = i == 0;
            uint160 s = RePoolMath.sqrtPriceX96(1099, 100, 6, 6, unitIs0);
            assertEq(s, V4PoolParams.sqrtPriceX96For(1099, unitIs0));
            (int24 lo, int24 hi) = RePoolMath.range(TickMath.getTickAtSqrtPrice(s), RePoolMath.tickOffset(5000));
            (int24 lo0, int24 hi0) = V4PoolParams.range(s);
            assertEq(lo, lo0);
            assertEq(hi, hi0);
        }
        assertEq(RePoolMath.sqrtPriceX96(1099, 100, 6, 6, true), 262650619782058807908119467889);
        assertEq(RePoolMath.tickOffset(5000), V4PoolParams.TICK_OFFSET); // ceil(ln 1.5 / ln 1.0001) = 4055
        assertEq(RePoolMath.tickOffset(1), 1);
        assertEq(RePoolMath.tickOffset(10_000), 6932); // ceil(ln 2 / ln 1.0001) = ceil(6931.8)
    }

    function test_decimalsAdjust_18decimalStable() public pure {
        // 10.99 stable (18 dec) per unit (6 dec): raw price 10.99e12, same sqrt as an exact rational.
        uint160 s = RePoolMath.sqrtPriceX96(1099, 100, 6, 18, true);
        assertEq(s, uint160(V4PoolParams.sqrt((uint256(1099e12) << 192) / 100)));
    }
}

/// @notice Fork tests of script/RePoolV4.s.sol against the real PoolManager, tIP16P and V4LiquidityHelper on
///         Robinhood Chain Testnet (46630). Read-only fork: nothing is broadcast to the chain. Skipped when the RPC
///         is unreachable. RPC: env ROBINHOOD_RPC, default https://rpc.testnet.chain.robinhood.com
contract RePoolV4ForkTest is Test {
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant UNIT = 0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A; // tIP16P
    address constant LH = 0xF0BDaC9d6A849992D5825ad20A73E6bf1B47e3D4;
    V4SwapHelper constant SH = V4SwapHelper(0xFAbd4D06F31Fc3d5E19b360fFC9A2135645D3Bcb);
    // One address on each side of tIP16P (0x8875...), so both currency orderings are exercised.
    address constant STABLE_LOW = address(uint160(0x5714b1e0));
    address constant STABLE_HIGH = address(uint160(type(uint160).max - 0x5714b1e0));
    uint160 constant SQRT_UNIT0 = 262650619782058807908119467889; // floor(sqrt(1099 * 2^192 / 100))

    RePoolV4 s;
    address deployer;
    address trader = makeAddr('trader');

    function setUp() public {
        string memory rpc = vm.envOr('ROBINHOOD_RPC', string('https://rpc.testnet.chain.robinhood.com'));
        try vm.createSelectFork(rpc) returns (uint256) {}
        catch {
            vm.skip(true, 'RePoolV4 fork tests skipped: Robinhood Chain Testnet RPC unreachable (set ROBINHOOD_RPC)');
            return;
        }
        vm.setEvmVersion('cancun');
        require(address(PM).code.length > 0 && LH.code.length > 0 && address(SH).code.length > 0, 'v4 contracts missing on fork');
        deployer = IToken(UNIT).owner(); // the real tIP16P owner (project deployer); no key is needed in a fork
        vm.deal(deployer, 1 ether);
        s = new RePoolV4();
    }

    function _stableAt(address at, address owner) internal returns (address) {
        deployCodeTo('RePoolV4.t.sol:ThrowawayStable6', abi.encode(owner), at);
        return at;
    }

    function _priceBracket(uint160 sqrtP, bool unitIs0) internal pure {
        // stable per unit == 10.99 within floor rounding of the sqrt, checked in integers
        if (unitIs0) {
            assertLe(uint256(sqrtP) * sqrtP * 100, uint256(1099) << 192);
            assertGt((uint256(sqrtP) + 1) * (uint256(sqrtP) + 1) * 100, uint256(1099) << 192);
        } else {
            assertLe(uint256(sqrtP) * sqrtP * 1099, uint256(100) << 192);
            assertGt((uint256(sqrtP) + 1) * (uint256(sqrtP) + 1) * 1099, uint256(100) << 192);
        }
    }

    function _expectedOut(uint128 liq, uint160 sqrtP, bool zeroForOne, uint256 amountIn) internal pure returns (uint256) {
        uint256 x = FullMath.mulDiv(liq, 2 ** 96, sqrtP);
        uint256 y = FullMath.mulDiv(liq, sqrtP, 2 ** 96);
        uint256 inLessFee = amountIn * (1e6 - 3000) / 1e6;
        return zeroForOne ? FullMath.mulDiv(y, inLessFee, x + inLessFee) : FullMath.mulDiv(x, inLessFee, y + inLessFee);
    }

    function _runAndCheck(address stableAt, bool expectUnitIs0) internal {
        address stable = _stableAt(stableAt, deployer);
        uint256 unitBefore = IToken(UNIT).balanceOf(deployer);
        RePoolV4.Plan memory pl = s.rePool(s.defaultParams(stable), deployer);

        // ordering and key
        assertEq(pl.unitIs0, expectUnitIs0);
        assertEq(Currency.unwrap(pl.key.currency0), expectUnitIs0 ? UNIT : stable);
        assertEq(Currency.unwrap(pl.key.currency1), expectUnitIs0 ? stable : UNIT);
        assertEq(pl.key.fee, 3000);
        assertEq(pl.key.tickSpacing, 60);
        assertEq(address(pl.key.hooks), address(0));
        assertFalse(pl.skipped);
        assertFalse(pl.initialized);
        assertGt(pl.txCount, 0);

        // slot0 price == 10.99 stable per unit within rounding
        (uint160 sqrtP, int24 tick) = s.slot0(pl.id);
        assertEq(sqrtP, V4PoolParams.sqrtPriceX96For(1099, expectUnitIs0));
        if (expectUnitIs0) assertEq(sqrtP, SQRT_UNIT0);
        assertEq(tick, expectUnitIs0 ? int24(23971) : int24(-23972));
        _priceBracket(sqrtP, expectUnitIs0);
        assertEq(pl.lo, expectUnitIs0 ? int24(19860) : int24(-28080));
        assertEq(pl.hi, expectUnitIs0 ? int24(28080) : int24(-19860));

        // liquidity > 0 in range, owned by the deployer's namespace in the helper
        assertGt(pl.liq, 0);
        assertTrue(tick >= pl.lo && tick < pl.hi);
        assertEq(s.activeLiquidity(pl.id), pl.liq);
        assertEq(s.positionLiquidity(pl.id, deployer, pl.lo, pl.hi), pl.liq);
        assertApproxEqAbs(pl.needUnit, 1000e6, 1);
        assertGt(pl.needStable, 10_900e6);
        assertLt(pl.needStable, 11_100e6);
        assertEq(pl.mintStable, pl.needStable, 'stable fully minted (deployer started at 0)');
        assertEq(IToken(UNIT).balanceOf(deployer), unitBefore + pl.mintUnit - pl.needUnit);
        assertEq(IToken(stable).balanceOf(deployer), 0);
        assertEq(IToken(UNIT).allowance(deployer, LH), 0, 'exact approval consumed');
        assertEq(IToken(stable).allowance(deployer, LH), 0, 'exact approval consumed');

        // helpers hold nothing
        _noDust(stable);

        // 100-stable swap through the deployed V4SwapHelper vs constant product on the virtual reserves
        bool zeroForOne = !expectUnitIs0; // selling the stable
        uint256 expected = _expectedOut(pl.liq, sqrtP, zeroForOne, 100e6);
        vm.prank(deployer);
        IToken(stable).mint(trader, 100e6);
        vm.startPrank(trader);
        IToken(stable).approve(address(SH), 100e6);
        uint256 out = SH.swapExactIn(pl.key, zeroForOne, 100e6, expected - 2);
        vm.stopPrank();
        assertLe(out, expected);
        assertApproxEqAbs(out, expected, 2, 'swap out ~= constant-product expectation');
        assertEq(IToken(UNIT).balanceOf(trader), out);
        assertGt(out, 9e6); // ~9.07 units for 100 stable at 10.99 less fee and impact
        assertLt(out, uint256(100e6) * 100 / 1099);
        _noDust(stable);

        // idempotency: a second run plans nothing and changes nothing
        uint128 liqBefore = s.activeLiquidity(pl.id);
        (uint160 pBefore,) = s.slot0(pl.id);
        uint256 uBal = IToken(UNIT).balanceOf(deployer);
        uint256 sBal = IToken(stable).balanceOf(deployer);
        RePoolV4.Plan memory again = s.rePool(s.defaultParams(stable), deployer);
        assertTrue(again.skipped);
        assertEq(again.txCount, 0);
        assertEq(again.existingLiq, pl.liq);
        assertEq(s.activeLiquidity(pl.id), liqBefore);
        (uint160 pAfter,) = s.slot0(pl.id);
        assertEq(pAfter, pBefore);
        assertEq(IToken(UNIT).balanceOf(deployer), uBal);
        assertEq(IToken(stable).balanceOf(deployer), sBal);

        // never writes a deployment file outside `forge script --broadcast`
        assertFalse(vm.exists(string.concat(vm.projectRoot(), '/deployments/v4-pool-xSTBLTEST-46630.json')));
    }

    function _noDust(address stable) internal view {
        assertEq(IToken(UNIT).balanceOf(LH), 0, 'units in liquidity helper');
        assertEq(IToken(UNIT).balanceOf(address(SH)), 0, 'units in swap helper');
        assertEq(IToken(stable).balanceOf(LH), 0, 'stable in liquidity helper');
        assertEq(IToken(stable).balanceOf(address(SH)), 0, 'stable in swap helper');
    }

    // ---------------------------------------------------------------- tests
    function test_rePool_stableBelowUnit_stableIsCurrency0() public {
        assertLt(uint160(STABLE_LOW), uint160(UNIT));
        _runAndCheck(STABLE_LOW, false);
    }

    function test_rePool_stableAboveUnit_unitIsCurrency0() public {
        assertGt(uint160(STABLE_HIGH), uint160(UNIT));
        _runAndCheck(STABLE_HIGH, true);
    }

    function test_run_readsEnv() public {
        address stable = _stableAt(STABLE_HIGH, deployer);
        vm.setEnv('STABLE_TOKEN', vm.toString(stable));
        vm.setEnv('DEPLOYER', vm.toString(deployer));
        s.run();
        RePoolV4.Plan memory pl = s.plan(s.defaultParams(stable), deployer);
        assertGt(pl.existingLiq, 0, 'run() seeded the deployer position');
        assertEq(s.activeLiquidity(pl.id), pl.existingLiq);
        assertTrue(pl.unitIs0);
    }

    function test_alreadyInitializedAtTarget_skipsInitialize() public {
        address stable = _stableAt(STABLE_HIGH, deployer);
        RePoolV4.Plan memory p0 = s.plan(s.defaultParams(stable), deployer);
        PM.initialize(p0.key, p0.targetSqrtP); // someone else initialized it at the same price
        RePoolV4.Plan memory pl = s.rePool(s.defaultParams(stable), deployer);
        assertTrue(pl.initialized);
        assertEq(s.positionLiquidity(pl.id, deployer, pl.lo, pl.hi), pl.liq);
    }

    function test_refuses_poolInitializedAtAnotherPrice() public {
        address stable = _stableAt(STABLE_HIGH, deployer);
        RePoolV4.Params memory prm = s.defaultParams(stable);
        RePoolV4.Plan memory p0 = s.plan(s.defaultParams(stable), deployer);
        PM.initialize(p0.key, TickMath.getSqrtPriceAtTick(p0.targetTick + 100));
        vm.expectRevert(abi.encodeWithSelector(RePoolV4.PoolPriceMismatch.selector, p0.targetTick + 100, p0.targetTick));
        s.rePool(prm, deployer);
    }

    function test_refuses_wrongChain() public {
        address stable = _stableAt(STABLE_HIGH, deployer);
        RePoolV4.Params memory prm = s.defaultParams(stable);
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(RePoolV4.WrongChain.selector, uint256(1)));
        s.rePool(prm, deployer);
    }

    function test_refuses_insufficientEth() public {
        address stable = _stableAt(STABLE_HIGH, deployer);
        RePoolV4.Params memory prm = s.defaultParams(stable);
        vm.deal(deployer, 0);
        vm.expectPartialRevert(RePoolV4.InsufficientEth.selector);
        s.rePool(prm, deployer);
    }

    function test_refuses_shortAndNotOwner() public {
        address stable = _stableAt(STABLE_HIGH, makeAddr('someone-else'));
        RePoolV4.Params memory prm = s.defaultParams(stable);
        vm.expectPartialRevert(RePoolV4.ShortAndNotOwner.selector);
        s.rePool(prm, deployer);
    }

    function test_deploymentFile_format() public {
        address stable = _stableAt(STABLE_LOW, deployer);
        RePoolV4WriteHarness h = new RePoolV4WriteHarness();
        RePoolV4.Params memory prm = h.defaultParams(stable);
        RePoolV4.Plan memory pl = h.plan(prm, deployer);
        pl.stableSymbol = 'xWRITETEST'; // own file name, so the parallel "never writes" checks are unaffected
        h.writeDeployment(prm, pl, deployer);
        string memory path = string.concat(vm.projectRoot(), '/deployments/v4-pool-xWRITETEST-46630.json');
        string memory j = vm.readFile(path);
        vm.removeFile(path);
        assertEq(vm.parseJsonUint(j, '.chainId'), 46630);
        assertEq(vm.parseJsonAddress(j, '.stableToken'), stable);
        assertEq(vm.parseJsonAddress(j, '.currency0'), stable);
        assertEq(vm.parseJsonBytes32(j, '.poolId'), pl.id);
        assertEq(vm.parseJsonString(j, '.initialPriceStablePerUnit'), '10.990000');
        assertEq(vm.parseJsonInt(j, '.tickLower'), -28080);
        assertEq(vm.parseJsonString(j, '.workerVars.V4_TOKEN0'), vm.toString(stable));
        assertEq(vm.parseJsonString(j, '.workerVars.V4_TICK_LOWER'), '-28080');
        assertEq(vm.parseJsonString(j, '.workerVars.V4_TICK_UPPER'), '-19860');
        assertEq(vm.parseJsonString(j, '.workerVars.V4_TOKEN1_SYMBOL'), 'xWRITETEST');
    }

    function test_noMint_whenDeployerAlreadyHoldsEnough() public {
        address stable = _stableAt(STABLE_HIGH, deployer);
        vm.startPrank(deployer);
        IToken(stable).mint(deployer, 20_000e6);
        IToken(UNIT).mint(deployer, 2_000e6);
        vm.stopPrank();
        RePoolV4.Plan memory pl = s.rePool(s.defaultParams(stable), deployer);
        assertEq(pl.mintUnit, 0);
        assertEq(pl.mintStable, 0);
        assertEq(IToken(stable).balanceOf(deployer), 20_000e6 - pl.needStable);
    }
}
