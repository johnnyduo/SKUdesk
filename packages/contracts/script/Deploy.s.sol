// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from 'forge-std/Script.sol';
import {MockUSDC} from '../src/MockUSDC.sol';
import {SKUdeskCore} from '../src/SKUdeskCore.sol';

/// Deploys the test USDG token (class MockUSDC) + SKUdeskCore, funds the vault, allowlists the test supplier and payer.
/// Env: DEPLOYER_PRIVATE_KEY, AGENT_ADDRESS. Writes deployments/<chainid>.json.
/// The "marketplace payer" is the deployer wallet (it stands in for a marketplace payout); the "supplier" is a fixed test address.
contract Deploy is Script {
    uint256 constant VAULT_FUND = 5_000_000_000; // $5,000.00 mUSDG (6 decimals)
    function run() external {
        uint256 pk = vm.envUint('DEPLOYER_PRIVATE_KEY');
        address deployer = vm.addr(pk);
        address agent = vm.envAddress('AGENT_ADDRESS');
        address supplier = address(uint160(uint256(keccak256('robinize-demo-supplier'))));
        vm.startBroadcast(pk);
        MockUSDC usdc = new MockUSDC();
        SKUdeskCore core = new SKUdeskCore(address(usdc), agent);
        usdc.mint(deployer, VAULT_FUND * 2);          // half to the vault, half as the test marketplace's payout float
        usdc.approve(address(core), type(uint256).max);
        core.deposit(VAULT_FUND);
        core.setPayee(supplier, true);
        core.setPayer(deployer, true);
        vm.stopBroadcast();
        string memory j = string.concat(
            '{"chainId":', vm.toString(block.chainid),
            ',"token":"', vm.toString(address(usdc)),
            '","core":"', vm.toString(address(core)),
            '","owner":"', vm.toString(deployer),
            '","agent":"', vm.toString(agent),
            '","supplier":"', vm.toString(supplier),
            '","payer":"', vm.toString(deployer),
            '","deployBlock":', vm.toString(block.number), '}');
        vm.writeFile(string.concat('deployments/', vm.toString(block.chainid), '.json'), j);
        console.log('token', address(usdc)); console.log('core', address(core));
    }
}
