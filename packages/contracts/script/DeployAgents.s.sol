// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from 'forge-std/Script.sol';
import {AgentIdentityRegistry} from '../src/AgentIdentityRegistry.sol';
import {AgentFactory} from '../src/AgentFactory.sol';
import {TokenFaucet} from '../src/TokenFaucet.sol';
import {MockUSDC} from '../src/MockUSDC.sol';

/// Deploys the identity registry and the agent factory against the already-deployed MockUSDC and the canonical ERC-4337 v0.7 EntryPoint.
/// Env: DEPLOYER_PRIVATE_KEY. Reads deployments/<chainid>.json (token). Writes deployments/agents-<chainid>.json.
contract DeployAgents is Script {
    address constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant ERC8004_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;   // Identity Registry on Robinhood Chain Testnet
    function run() external {
        uint256 pk = vm.envUint('DEPLOYER_PRIVATE_KEY');
        string memory dep = vm.readFile(string.concat('deployments/', vm.toString(block.chainid), '.json'));
        address token = vm.parseJsonAddress(dep, '.token');
        require(ENTRY_POINT_V07.code.length != 0, 'EntryPoint v0.7 is not deployed on this chain');
        vm.startBroadcast(pk);
        // Use the ERC-8004 Identity Registry that already exists on the chain (a reference deployment run by a third party).
        // On a chain without it (a local test chain) deploy our own implementation of the same interface.
        AgentIdentityRegistry registry = ERC8004_REGISTRY.code.length != 0 ? AgentIdentityRegistry(ERC8004_REGISTRY) : new AgentIdentityRegistry();
        AgentFactory factory = new AgentFactory(token, ENTRY_POINT_V07, registry);
        TokenFaucet faucet = TokenFaucet(vm.envOr('FAUCET', address(0)));       // FAUCET=<address> reuses an existing faucet
        if (address(faucet) == address(0)) {
            faucet = new TokenFaucet(token, 1_000_000_000, 1 days);             // 1,000 mUSDG per address per day
            MockUSDC(token).mint(address(faucet), 500_000_000_000);             // 500,000 mUSDG (deployer is the token owner)
        }
        vm.stopBroadcast();
        string memory j = string.concat('{"chainId":', vm.toString(block.chainid), ',"factory":"', vm.toString(address(factory)), '","registry":"', vm.toString(address(registry)), '","faucet":"', vm.toString(address(faucet)),
            '","entryPoint":"', vm.toString(ENTRY_POINT_V07), '","token":"', vm.toString(token), '","deployBlock":', vm.toString(block.number), '}');
        vm.writeFile(string.concat('deployments/agents-', vm.toString(block.chainid), '.json'), j);
        console.log('AgentFactory', address(factory)); console.log('TokenFaucet', address(faucet)); console.log('AgentIdentityRegistry', address(registry));
    }
}
