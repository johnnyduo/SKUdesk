// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SKUdeskCore} from './SKUdeskCore.sol';

/// @title MandateVault - SKUdeskCore with the owner and the policy fixed at construction.
/// @notice SKUdeskCore (already deployed and verified) sets owner = msg.sender and has no ownership transfer, so a
/// factory cannot hand a vault to a user. This subclass takes the owner as an argument and changes no rule.
contract MandateVault is SKUdeskCore {
    error BadOwner();
    error BadMargin(uint256 bps);

    constructor(
        address _token, address _agent, address _owner,
        uint256 daily, uint256 maxPerTrade, uint256 marginBps, uint256 ttl,
        address[] memory payees, address[] memory payers
    ) SKUdeskCore(_token, _agent) {
        if (_owner == address(0)) revert BadOwner();
        if (marginBps < 100 || marginBps > 9000) revert BadMargin(marginBps);   // same bounds as setPolicy
        owner = _owner;
        dailySpendCap = daily; maxExec = maxPerTrade; minMarginBps = marginBps; quoteTTL = ttl;
        for (uint256 i; i < payees.length; ++i) payee[payees[i]] = true;
        for (uint256 i; i < payers.length; ++i) payer[payers[i]] = true;
        emit PolicyUpdated(daily, maxPerTrade, marginBps, ttl);
    }
}
