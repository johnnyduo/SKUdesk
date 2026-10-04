// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// @title EconLib - integer-cent unit economics, mirrors packages/economics (TS).
/// @notice All money in cents (uint256). bps fees round UP (conservative). Margin floors DOWN.
/// @dev Operation-for-operation mirror: landed=mirror sum; fee=ceilDiv(base*bps,10000);
/// net=sell-fee-fulfill-ret-landed-chain; marginBps=floor(net*10000/sell).
library EconLib {
    struct Quote { uint256 purchaseCents; uint256 shipCents; uint256 dutyCents; uint256 taxCents; uint256 procFeeCents; uint256 payFeeCents; uint256 sellCents; uint256 mktFeeBps; uint256 fulfillCents; uint256 retBps; uint256 chainCents; }
    struct Result { uint256 landed; uint256 mktFee; uint256 ret; int256 net; uint256 marginBps; uint256 breakeven; uint256 maxBuy; }
    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) { return (a + b - 1) / b; }
    function landedOf(Quote memory q) internal pure returns (uint256) {
        return q.purchaseCents + q.shipCents + q.dutyCents + q.taxCents + q.procFeeCents + q.payFeeCents;
    }
    function quote(Quote memory q) internal pure returns (Result memory r) {
        r.landed = landedOf(q);
        r.mktFee = ceilDiv(q.sellCents * q.mktFeeBps, 10000);
        r.ret = ceilDiv(q.sellCents * q.retBps, 10000);
        int256 sell = int256(q.sellCents);
        r.net = sell - int256(r.mktFee) - int256(q.fulfillCents) - int256(r.ret) - int256(r.landed) - int256(q.chainCents);
        r.marginBps = q.sellCents == 0 || r.net < 0 ? 0 : uint256(r.net) * 10000 / q.sellCents;
        r.breakeven = r.landed + r.mktFee + q.fulfillCents + r.ret + q.chainCents;
        uint256 other = r.landed - q.purchaseCents;
        r.maxBuy = r.breakeven > other ? r.breakeven - other : 0;
    }
    function batchProfit(int256 netPerUnit, uint256 units, uint256 fixedBatch) internal pure returns (int256) {
        return netPerUnit * int256(units) - int256(fixedBatch);
    }
}
