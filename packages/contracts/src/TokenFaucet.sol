// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20Min} from './IERC20Min.sol';

/// @title TokenFaucet - hands out testnet mUSDG (worthless test tokens) so a visitor can fund their own vault.
/// @notice Pre-funded by the token owner. One drip per address per cooldown. Not part of any money path.
contract TokenFaucet {
    IERC20Min public immutable token;
    uint256 public immutable amount;
    uint256 public immutable cooldown;
    mapping(address => uint256) public nextDripAt;
    event Dripped(address indexed to, uint256 amount);
    error TooSoon(uint256 nextAt); error Empty(uint256 balance, uint256 needed); error TransferFailed();

    constructor(address _token, uint256 _amount, uint256 _cooldown) { token = IERC20Min(_token); amount = _amount; cooldown = _cooldown; }

    function drip() external {
        if (block.timestamp < nextDripAt[msg.sender]) revert TooSoon(nextDripAt[msg.sender]);
        uint256 bal = token.balanceOf(address(this));
        if (bal < amount) revert Empty(bal, amount);
        nextDripAt[msg.sender] = block.timestamp + cooldown;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Dripped(msg.sender, amount);
    }
}
