// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Test USDG - testnet stand-in for the Robinhood Chain stablecoin USDG (6 decimals). NOT real USDG.
/// @notice Owner-only mint. Exists because the testnet USDG proxy has a restricted mint and the faucet does not drip it. The vault and the
/// market take the token address as a constructor argument, so real USDG is a one-argument swap. (The contract keeps its original file and class name.)
contract MockUSDC {
    string public constant name = 'Test USDG (testnet stand-in)';
    string public constant symbol = 'mUSDG';
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    error NotOwner();
    error Insufficient();
    error Allowance();

    constructor() { owner = msg.sender; }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        totalSupply += amount; balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) { if (a < amount) revert Allowance(); allowance[from][msg.sender] = a - amount; }
        _move(from, to, amount); return true;
    }
    function _move(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert Insufficient();
        balanceOf[from] -= amount; balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
