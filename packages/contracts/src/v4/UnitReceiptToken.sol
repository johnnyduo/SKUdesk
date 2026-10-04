// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title UnitReceiptToken - SKUdesk test unit token (IP16P-CLR), 6 decimals, owner-only mint.
/// @notice Test token for the Uniswap v4 reference pool (units vs mUSDC) on Robinhood Chain Testnet.
///         It has no value and carries no claim on goods: holding it does not entitle anyone to any product,
///         delivery, refund or payment. It exists only so the pool has a unit-side currency.
contract UnitReceiptToken {
    string public constant name = 'SKUdesk test unit (IP16P-CLR)';
    string public constant symbol = 'tIP16P';
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public immutable owner;
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
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert Allowance();
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert Insufficient();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
