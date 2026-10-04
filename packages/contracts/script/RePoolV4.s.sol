// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from 'forge-std/Script.sol';
import {VmSafe} from 'forge-std/Vm.sol';
import {IPoolManager} from '../src/v4/core/interfaces/IPoolManager.sol';
import {PoolKey} from '../src/v4/core/types/PoolKey.sol';
import {Currency} from '../src/v4/core/types/Currency.sol';
import {ModifyLiquidityParams} from '../src/v4/core/types/PoolOperation.sol';
import {TickMath} from '../src/v4/core/libraries/TickMath.sol';
import {V4LiquidityHelper} from '../src/v4/V4LiquidityHelper.sol';
import {V4PoolParams} from './DeployV4Pool.s.sol';

interface IRePoolToken {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// @title RePoolMath - price and range math for the re-pool, generalised from V4PoolParams.
/// @dev Price is given as PRICE_NUM / PRICE_DEN stable per unit (human units). In raw base units:
///      rawNum / rawDen = (num * 10^decStable) / (den * 10^decUnit), reduced by the common power of ten.
///      Uniswap price = currency1 per currency0, sqrtPriceX96 = sqrt(price) * 2^96, so (same method as
///      V4PoolParams.sqrtPriceX96For, which is the 6/6-decimal case with den = 100):
///        unit is currency0: sqrtPriceX96 = floor(sqrt(rawNum * 2^192 / rawDen))
///        unit is currency1: sqrtPriceX96 = floor(sqrt(rawDen * 2^192 / rawNum))
///      Range: RANGE_BPS sets the upper bound as price * (1 + bps / 10000); the tick offset is
///      ceil(log_1.0001(1 + bps / 10000)) ticks, applied on both sides of the start tick (symmetric in ticks,
///      so the lower bound is price / (1 + bps / 10000)), widened outwards to multiples of 60.
///      RANGE_BPS = 5000 gives an offset of 4055 ticks, i.e. exactly V4PoolParams.TICK_OFFSET.
library RePoolMath {
    error PriceOutOfBounds();
    error RangeOutOfBounds();

    function rawPrice(uint256 num, uint256 den, uint8 decUnit, uint8 decStable)
        internal pure returns (uint256 rawNum, uint256 rawDen)
    {
        if (num == 0 || den == 0) revert PriceOutOfBounds();
        (rawNum, rawDen) = decStable >= decUnit ? (num * 10 ** (decStable - decUnit), den) : (num, den * 10 ** (decUnit - decStable));
        if (rawNum >= 2 ** 64 || rawDen >= 2 ** 64) revert PriceOutOfBounds(); // keeps x << 192 inside 256 bits
    }

    function sqrtPriceX96(uint256 num, uint256 den, uint8 decUnit, uint8 decStable, bool unitIsCurrency0)
        internal pure returns (uint160)
    {
        (uint256 rn, uint256 rd) = rawPrice(num, den, decUnit, decStable);
        uint256 r = unitIsCurrency0 ? V4PoolParams.sqrt((rn << 192) / rd) : V4PoolParams.sqrt((rd << 192) / rn);
        if (r < TickMath.MIN_SQRT_PRICE || r >= TickMath.MAX_SQRT_PRICE) revert PriceOutOfBounds();
        return uint160(r);
    }

    /// @notice ceil(log_1.0001(1 + bps / 10000)), computed with the v4 TickMath on the exact sqrt ratio.
    function tickOffset(uint256 bps) internal pure returns (int24 off) {
        if (bps == 0 || bps > 1_000_000) revert RangeOutOfBounds(); // up to x101
        uint160 s = uint160(V4PoolParams.sqrt(((10_000 + bps) << 192) / 10_000));
        off = TickMath.getTickAtSqrtPrice(s);
        if (TickMath.getSqrtPriceAtTick(off) < s) off += 1;
    }

    function range(int24 tick, int24 off) internal pure returns (int24 lo, int24 hi) {
        lo = V4PoolParams.floorTo(tick - off);
        hi = -V4PoolParams.floorTo(-(tick + off)); // ceil to spacing
        if (lo < TickMath.MIN_TICK || hi > TickMath.MAX_TICK) revert RangeOutOfBounds();
    }
}

/// @notice Re-pool the Uniswap v4 reference pool against a NEW stable test token, reusing the deployed unit token
///         (tIP16P) and the deployed, generic V4LiquidityHelper. It deploys nothing.
///         Steps: sort (UNIT, STABLE) into a PoolKey (fee 3000, tick spacing 60, no hook), initialize at
///         PRICE_NUM / PRICE_DEN stable per unit (skipped if slot0 is already set at that price), mint only the
///         missing balances (only if the deployer owns the token), approve the helper for the exact amounts, and
///         add liquidity through the helper. Every check runs in forge's simulation before anything is sent, so a
///         failed check broadcasts nothing.
///         Env: STABLE_TOKEN (required), UNIT_TOKEN (default tIP16P), PRICE_NUM / PRICE_DEN (default 1099 / 100),
///         LIQ_UNITS (default 1000000000 = 1,000 units at 6 decimals), RANGE_BPS (default 5000 = x1.5 / /1.5),
///         MAX_TICK_DRIFT (default 5: an already-initialized pool must sit within 5 ticks of the target),
///         DEPLOYER (default: the script sender).
///         Run with --evm-version cancun and a separate --out / --cache-path (see docs/v4-pool.md, "Re-pool").
///         Writes deployments/v4-pool-<symbol>-46630.json only under `forge script --broadcast` on chain 46630.
///         Idempotent: if the deployer already has liquidity at the same range in that pool, it does nothing.
contract RePoolV4 is Script {
    uint256 public constant CHAIN_ID = 46630;
    IPoolManager public constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address public constant UNIT_DEFAULT = 0x8875C482eC20c82bE0f62c16d6F94B92a6050a2A; // tIP16P
    V4LiquidityHelper public constant LH = V4LiquidityHelper(0xF0BDaC9d6A849992D5825ad20A73E6bf1B47e3D4);
    address public constant SWAP_HELPER = 0xFAbd4D06F31Fc3d5E19b360fFC9A2135645D3Bcb;
    address internal constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;
    uint256 internal constant POOLS_SLOT = 6; // StateLibrary.POOLS_SLOT
    uint256 internal constant MIN_GAS_PRICE = 0.01 gwei; // floor when the simulation reports 0
    uint256 internal constant PRICE_HEADROOM = 3; // balance must cover 3x the estimated cost

    struct Params {
        address stable;
        address unit;
        uint256 priceNum;
        uint256 priceDen;
        uint256 liqUnits;
        uint256 rangeBps;
        uint256 maxTickDrift;
    }

    struct Plan {
        PoolKey key;
        bytes32 id;
        bool unitIs0;
        uint8 decUnit;
        uint8 decStable;
        string stableSymbol;
        uint160 targetSqrtP;
        int24 targetTick;
        bool initialized; // slot0 already set before this run
        uint160 sqrtP; // price the liquidity is sized at (target, or the current price if already initialized)
        int24 lo;
        int24 hi;
        uint128 liq;
        uint128 existingLiq; // deployer's liquidity already at [lo, hi]
        uint256 needUnit;
        uint256 needStable;
        uint256 mintUnit;
        uint256 mintStable;
        uint256 txCount;
        uint256 gasEstimate;
        uint256 costWei;
        bool skipped; // idempotent no-op
    }

    error WrongChain(uint256 chainId);
    error MissingStableToken();
    error NoCode(address token);
    error SameToken();
    error NoDeployer();
    error PoolPriceMismatch(int24 currentTick, int24 targetTick);
    error PriceOutsideRange();
    error ZeroLiquidity();
    error ShortAndNotOwner(address token, uint256 have, uint256 need);
    error InsufficientEth(uint256 have, uint256 need);
    error ReadBackMismatch();

    function run() external {
        Params memory p = paramsFromEnv();
        rePool(p, vm.envOr('DEPLOYER', msg.sender));
    }

    function paramsFromEnv() public view returns (Params memory p) {
        p.stable = vm.envOr('STABLE_TOKEN', address(0));
        if (p.stable == address(0)) revert MissingStableToken();
        p.unit = vm.envOr('UNIT_TOKEN', UNIT_DEFAULT);
        p.priceNum = vm.envOr('PRICE_NUM', uint256(1099));
        p.priceDen = vm.envOr('PRICE_DEN', uint256(100));
        p.liqUnits = vm.envOr('LIQ_UNITS', uint256(1000e6));
        p.rangeBps = vm.envOr('RANGE_BPS', uint256(5000));
        p.maxTickDrift = vm.envOr('MAX_TICK_DRIFT', uint256(5));
    }

    function defaultParams(address stable) public pure returns (Params memory) {
        return Params(stable, UNIT_DEFAULT, 1099, 100, 1000e6, 5000, 5);
    }

    /// @notice The whole re-pool. Called by run() and by the fork tests (same code path).
    function rePool(Params memory p, address me) public returns (Plan memory pl) {
        vm.setEvmVersion('cancun'); // the PoolManager uses transient storage (TLOAD/TSTORE)
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        if (me == address(0) || me == FOUNDRY_DEFAULT_SENDER) revert NoDeployer();

        pl = plan(p, me);
        _printPlan(p, pl, me);
        if (pl.existingLiq > 0) {
            pl.skipped = true;
            console2.log('NOTHING TO DO: the deployer already has liquidity at this range in this pool. No transaction planned.');
            return pl;
        }

        (pl.gasEstimate, pl.txCount) = _estimateGas(p, pl, me);
        uint256 gasPrice = tx.gasprice > block.basefee ? tx.gasprice : block.basefee;
        if (gasPrice < MIN_GAS_PRICE) gasPrice = MIN_GAS_PRICE;
        pl.costWei = pl.gasEstimate * gasPrice;
        console2.log('planned txs', pl.txCount);
        console2.log('estimated gas (incl. 21000/tx + calldata, +30%)', pl.gasEstimate);
        console2.log('gas price used for the check (wei)', gasPrice);
        console2.log('estimated cost (wei)', pl.costWei);
        console2.log('deployer ETH balance (wei)', me.balance);
        if (me.balance < pl.costWei * PRICE_HEADROOM) revert InsufficientEth(me.balance, pl.costWei * PRICE_HEADROOM);

        vm.startBroadcast(me);
        _execute(p, pl, me);
        vm.stopBroadcast();

        // read back (in the simulation, before anything is sent)
        (uint160 s,) = slot0(pl.id);
        if (s != pl.sqrtP || positionLiquidity(pl.id, me, pl.lo, pl.hi) != pl.liq) revert ReadBackMismatch();
        console2.log('read back OK: slot0 and position liquidity match the plan');
        _printWorkerVars(pl);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) && block.chainid == CHAIN_ID) _writeDeployment(p, pl, me);
    }

    // ------------------------------------------------------------------ planning (no state change)
    function plan(Params memory p, address me) public view returns (Plan memory pl) {
        if (p.stable == address(0)) revert MissingStableToken();
        if (p.stable == p.unit) revert SameToken();
        if (p.stable.code.length == 0) revert NoCode(p.stable);
        if (p.unit.code.length == 0) revert NoCode(p.unit);
        pl.decUnit = _decimals(p.unit);
        pl.decStable = _decimals(p.stable);
        pl.stableSymbol = _symbol(p.stable);
        pl.key = V4PoolParams.key(p.unit, p.stable, address(0));
        pl.id = keccak256(abi.encode(pl.key));
        pl.unitIs0 = Currency.unwrap(pl.key.currency0) == p.unit;
        pl.targetSqrtP = RePoolMath.sqrtPriceX96(p.priceNum, p.priceDen, pl.decUnit, pl.decStable, pl.unitIs0);
        pl.targetTick = TickMath.getTickAtSqrtPrice(pl.targetSqrtP);
        (pl.lo, pl.hi) = RePoolMath.range(pl.targetTick, RePoolMath.tickOffset(p.rangeBps));

        (uint160 cur, int24 curTick) = slot0(pl.id);
        pl.initialized = cur != 0;
        // Idempotent: once the deployer has liquidity at this range, a re-run is a no-op whatever the price is now
        // (trades after the seed move it). Checked before the price-drift and funding checks.
        pl.existingLiq = positionLiquidity(pl.id, me, pl.lo, pl.hi);
        if (pl.existingLiq > 0) {
            pl.sqrtP = cur;
            return pl;
        }
        if (cur == 0) {
            pl.sqrtP = pl.targetSqrtP;
        } else {
            int256 d = int256(curTick) - int256(pl.targetTick);
            if (d < 0) d = -d;
            if (uint256(d) > p.maxTickDrift) revert PoolPriceMismatch(curTick, pl.targetTick);
            pl.sqrtP = cur;
        }
        if (pl.sqrtP <= TickMath.getSqrtPriceAtTick(pl.lo) || pl.sqrtP >= TickMath.getSqrtPriceAtTick(pl.hi)) revert PriceOutsideRange();

        pl.liq = V4PoolParams.liquidityForUnits(p.liqUnits, pl.unitIs0, pl.sqrtP, pl.lo, pl.hi);
        if (pl.liq == 0) revert ZeroLiquidity();
        (uint256 a0, uint256 a1) = V4PoolParams.amountsFor(pl.liq, pl.sqrtP, pl.lo, pl.hi);
        (pl.needUnit, pl.needStable) = pl.unitIs0 ? (a0, a1) : (a1, a0);
        pl.mintUnit = _shortfall(p.unit, me, pl.needUnit);
        pl.mintStable = _shortfall(p.stable, me, pl.needStable);
    }

    function _shortfall(address token, address me, uint256 need) internal view returns (uint256 mintAmt) {
        uint256 have = IRePoolToken(token).balanceOf(me);
        if (have >= need) return 0;
        if (_owner(token) != me) revert ShortAndNotOwner(token, have, need);
        return need - have;
    }

    // ------------------------------------------------------------------ execution
    function _execute(Params memory p, Plan memory pl, address me) internal {
        if (!pl.initialized) PM.initialize(pl.key, pl.targetSqrtP);
        if (pl.mintUnit > 0) IRePoolToken(p.unit).mint(me, pl.mintUnit);
        if (pl.mintStable > 0) IRePoolToken(p.stable).mint(me, pl.mintStable);
        IRePoolToken(p.unit).approve(address(LH), pl.needUnit); // exact, consumed to 0 by the helper's transferFrom
        IRePoolToken(p.stable).approve(address(LH), pl.needStable);
        LH.modifyLiquidity(pl.key, ModifyLiquidityParams({
            tickLower: pl.lo, tickUpper: pl.hi, liquidityDelta: int256(uint256(pl.liq)), salt: bytes32(0)
        }));
    }

    /// @dev Runs the same calls as the sender inside a state snapshot, measures execution gas per call, adds the
    ///      21000 intrinsic gas and calldata gas per transaction and a 30% margin, then reverts the snapshot.
    ///      L1 data fees of the rollup are not modelled here; the 3x balance headroom covers them at testnet prices.
    function _estimateGas(Params memory p, Plan memory pl, address me) internal returns (uint256 total, uint256 n) {
        uint256 snap = vm.snapshotState();
        vm.startPrank(me);
        uint256 g;
        if (!pl.initialized) {
            g = gasleft(); PM.initialize(pl.key, pl.targetSqrtP);
            total += _tx('initialize(PoolKey, sqrtPriceX96) on PoolManager', g - gasleft(), 4 + 6 * 32); n++;
        }
        if (pl.mintUnit > 0) {
            g = gasleft(); IRePoolToken(p.unit).mint(me, pl.mintUnit);
            total += _tx('mint unit token to deployer', g - gasleft(), 4 + 2 * 32); n++;
        }
        if (pl.mintStable > 0) {
            g = gasleft(); IRePoolToken(p.stable).mint(me, pl.mintStable);
            total += _tx('mint stable token to deployer', g - gasleft(), 4 + 2 * 32); n++;
        }
        g = gasleft(); IRePoolToken(p.unit).approve(address(LH), pl.needUnit);
        total += _tx('approve unit token -> V4LiquidityHelper (exact)', g - gasleft(), 4 + 2 * 32); n++;
        g = gasleft(); IRePoolToken(p.stable).approve(address(LH), pl.needStable);
        total += _tx('approve stable token -> V4LiquidityHelper (exact)', g - gasleft(), 4 + 2 * 32); n++;
        g = gasleft();
        LH.modifyLiquidity(pl.key, ModifyLiquidityParams(pl.lo, pl.hi, int256(uint256(pl.liq)), bytes32(0)));
        total += _tx('V4LiquidityHelper.modifyLiquidity(key, range, liquidity)', g - gasleft(), 4 + 9 * 32); n++;
        vm.stopPrank();
        vm.revertToState(snap);
    }

    function _tx(string memory what, uint256 execGas, uint256 calldataBytes) internal pure returns (uint256 est) {
        est = (execGas + 21_000 + 16 * calldataBytes) * 13 / 10;
        console2.log(string.concat('  tx: ', what, ' | est. gas ', vm.toString(est)));
    }

    // ------------------------------------------------------------------ v4-core storage reads (StateLibrary layout)
    function _state(bytes32 id) internal pure returns (bytes32) { return keccak256(abi.encode(id, POOLS_SLOT)); }

    function slot0(bytes32 id) public view returns (uint160 sqrtP, int24 tick) {
        uint256 w = uint256(PM.extsload(_state(id)));
        sqrtP = uint160(w);
        tick = int24(uint24(w >> 160));
    }

    function activeLiquidity(bytes32 id) public view returns (uint128) {
        return uint128(uint256(PM.extsload(bytes32(uint256(_state(id)) + 3))));
    }

    /// @notice Liquidity of `owner`'s position held by V4LiquidityHelper (user salt 0) at [lo, hi].
    function positionLiquidity(bytes32 id, address owner, int24 lo, int24 hi) public view returns (uint128) {
        bytes32 salt = keccak256(abi.encode(owner, bytes32(0))); // V4LiquidityHelper.positionSalt(owner, 0)
        bytes32 posKey = keccak256(abi.encodePacked(address(LH), lo, hi, salt));
        return uint128(uint256(PM.extsload(keccak256(abi.encode(posKey, uint256(_state(id)) + 6)))));
    }

    // ------------------------------------------------------------------ token reads
    function _decimals(address t) internal view returns (uint8) {
        (bool ok, bytes memory r) = t.staticcall(abi.encodeWithSignature('decimals()'));
        require(ok && r.length >= 32, 'token has no decimals()');
        return abi.decode(r, (uint8));
    }

    function _owner(address t) internal view returns (address) {
        (bool ok, bytes memory r) = t.staticcall(abi.encodeWithSignature('owner()'));
        return ok && r.length >= 32 ? abi.decode(r, (address)) : address(0);
    }

    /// @dev Symbol if it is 1-16 characters of [A-Za-z0-9], otherwise the first 4 bytes of the address (0x12345678).
    function _symbol(address t) internal view returns (string memory) {
        (bool ok, bytes memory r) = t.staticcall(abi.encodeWithSignature('symbol()'));
        if (ok && r.length >= 64) {
            string memory s = abi.decode(r, (string));
            bytes memory b = bytes(s);
            bool good = b.length > 0 && b.length <= 16;
            for (uint256 i; good && i < b.length; i++) {
                bytes1 c = b[i];
                good = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
            }
            if (good) return s;
        }
        bytes memory a = bytes(vm.toString(t));
        bytes memory out = new bytes(10);
        for (uint256 i; i < 10; i++) out[i] = a[i];
        return string(out);
    }

    // ------------------------------------------------------------------ output
    function _printPlan(Params memory p, Plan memory pl, address me) internal pure {
        console2.log('--- RePoolV4 plan (chain 46630) ---');
        console2.log('deployer', me);
        console2.log('unit token', p.unit);
        console2.log('stable token', p.stable);
        console2.log(string.concat('stable symbol ', pl.stableSymbol));
        console2.log('currency0', Currency.unwrap(pl.key.currency0));
        console2.log('currency1', Currency.unwrap(pl.key.currency1));
        console2.log('unit is currency0', pl.unitIs0);
        console2.log(string.concat('price (stable per unit) ', _dec6(p.priceNum, p.priceDen)));
        console2.log('target sqrtPriceX96', uint256(pl.targetSqrtP));
        console2.log(string.concat('target tick ', vm.toString(pl.targetTick)));
        console2.log(string.concat('range ', vm.toString(pl.lo), ' .. ', vm.toString(pl.hi)));
        console2.log('already initialized', pl.initialized);
        console2.log('liquidity', uint256(pl.liq));
        console2.log('unit amount (exact approval)', pl.needUnit);
        console2.log('stable amount (exact approval)', pl.needStable);
        console2.log('unit to mint', pl.mintUnit);
        console2.log('stable to mint', pl.mintStable);
        console2.log('deployer liquidity already at this range', uint256(pl.existingLiq));
        console2.log('pool id');
        console2.logBytes32(pl.id);
    }

    /// @notice The non-secret wrangler vars that point the Worker's GET /api/v4/pool at this pool.
    function _printWorkerVars(Plan memory pl) internal pure {
        console2.log('wrangler.jsonc "vars" for the Worker (apps/web), after the transactions are confirmed:');
        console2.log(string.concat('  "V4_POOL_ID": "', vm.toString(pl.id), '",'));
        console2.log(string.concat('  "V4_TOKEN0": "', vm.toString(Currency.unwrap(pl.key.currency0)), '",'));
        console2.log(string.concat('  "V4_TOKEN1": "', vm.toString(Currency.unwrap(pl.key.currency1)), '",'));
        console2.log(string.concat('  "V4_TICK_LOWER": "', vm.toString(pl.lo), '",'));
        console2.log(string.concat('  "V4_TICK_UPPER": "', vm.toString(pl.hi), '",'));
        console2.log(string.concat('  "V4_TOKEN1_SYMBOL": "', pl.stableSymbol, '"'));
    }

    function _dec6(uint256 num, uint256 den) internal pure returns (string memory) {
        uint256 scaled = (num * 1e6 + den / 2) / den;
        bytes memory frac = bytes(vm.toString(scaled % 1e6));
        while (frac.length < 6) frac = bytes.concat('0', frac);
        return string.concat(vm.toString(scaled / 1e6), '.', string(frac));
    }

    function _writeDeployment(Params memory p, Plan memory pl, address me) internal {
        string memory o = 'repool';
        vm.serializeUint(o, 'chainId', block.chainid);
        vm.serializeAddress(o, 'poolManager', address(PM));
        vm.serializeAddress(o, 'unitToken', p.unit);
        vm.serializeAddress(o, 'stableToken', p.stable);
        vm.serializeString(o, 'stableTokenSymbol', pl.stableSymbol);
        vm.serializeUint(o, 'unitDecimals', pl.decUnit);
        vm.serializeUint(o, 'stableDecimals', pl.decStable);
        vm.serializeAddress(o, 'liquidityHelper', address(LH));
        vm.serializeAddress(o, 'swapHelper', SWAP_HELPER);
        vm.serializeAddress(o, 'currency0', Currency.unwrap(pl.key.currency0));
        vm.serializeAddress(o, 'currency1', Currency.unwrap(pl.key.currency1));
        vm.serializeBool(o, 'unitIsCurrency0', pl.unitIs0);
        vm.serializeUint(o, 'fee', pl.key.fee);
        vm.serializeInt(o, 'tickSpacing', pl.key.tickSpacing);
        vm.serializeAddress(o, 'hooks', address(0));
        vm.serializeBytes32(o, 'poolId', pl.id);
        vm.serializeBytes32(o, 'poolStateSlot', _state(pl.id));
        vm.serializeString(o, 'initialPriceStablePerUnit', _dec6(p.priceNum, p.priceDen));
        vm.serializeString(o, 'initialSqrtPriceX96', vm.toString(uint256(pl.targetSqrtP)));
        vm.serializeInt(o, 'initialTick', pl.targetTick);
        vm.serializeBool(o, 'wasAlreadyInitialized', pl.initialized);
        vm.serializeInt(o, 'tickLower', pl.lo);
        vm.serializeInt(o, 'tickUpper', pl.hi);
        vm.serializeUint(o, 'rangeBps', p.rangeBps);
        vm.serializeString(o, 'seedLiquidity', vm.toString(uint256(pl.liq)));
        vm.serializeString(o, 'seedUnits', vm.toString(pl.needUnit));
        vm.serializeString(o, 'seedStable', vm.toString(pl.needStable));
        vm.serializeAddress(o, 'positionOwner', address(LH));
        vm.serializeBytes32(o, 'positionSalt', keccak256(abi.encode(me, bytes32(0))));
        vm.serializeAddress(o, 'deployer', me);
        vm.serializeString(o, 'txHashes', 'see broadcast/RePoolV4.s.sol/46630/run-latest.json');
        string memory w = 'workerVars';
        vm.serializeString(w, 'V4_POOL_ID', vm.toString(pl.id));
        vm.serializeString(w, 'V4_TOKEN0', vm.toString(Currency.unwrap(pl.key.currency0)));
        vm.serializeString(w, 'V4_TOKEN1', vm.toString(Currency.unwrap(pl.key.currency1)));
        vm.serializeString(w, 'V4_TICK_LOWER', vm.toString(pl.lo));
        vm.serializeString(w, 'V4_TICK_UPPER', vm.toString(pl.hi));
        string memory wj = vm.serializeString(w, 'V4_TOKEN1_SYMBOL', pl.stableSymbol);
        vm.serializeString(o, 'workerVars', wj);
        string memory json = vm.serializeString(o, 'note',
            'Written from the forge simulation right before broadcast. Read slot0 and liquidity back from the chain to confirm.');
        string memory path = string.concat(vm.projectRoot(), '/deployments/v4-pool-', pl.stableSymbol, '-46630.json');
        vm.writeJson(json, path);
        console2.log(string.concat('wrote ', path));
    }
}
