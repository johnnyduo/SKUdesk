// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from 'forge-std/Script.sol';
import {BlindBook} from '../src/BlindBook.sol';

/// Deploys BlindBook against the already-deployed test USDG token (class MockUSDC) and lists every market in apps/web/src/data/catalog.json.
/// Env: DEPLOYER_PRIVATE_KEY. Reads deployments/<chainid>.json (token). Writes deployments/blindbook-<chainid>.json.
contract DeployBook is Script {
    // forge decodes JSON objects with their fields in ALPHABETICAL order: this struct must match that order exactly
    struct Mkt { string accent; string category; string id; string lot; string name; string priceBasis; uint256 referenceCents; string source; string subtitle; string symbol; uint256 tick; }
    function run() external {
        uint256 pk = vm.envUint('DEPLOYER_PRIVATE_KEY');
        string memory dep = vm.readFile(string.concat('deployments/', vm.toString(block.chainid), '.json'));
        address token = vm.parseJsonAddress(dep, '.token');
        string memory cat = vm.readFile('../../apps/web/src/data/catalog.json');
        Mkt[] memory ms = abi.decode(vm.parseJson(cat, '.markets'), (Mkt[]));
        vm.startBroadcast(pk);
        // NOTE: the JSON deliberately has no t0: forge's pre-broadcast simulation reports a different timestamp than the real deploy block,
        // so consumers must read t0() from the contract. defaults: epoch 45s, commit [0,20), reveal [20,35), clear from 35, bond 2 tokens. Overridable for fast local tests.
        uint256 epochLen = vm.envOr('EPOCH_LEN', uint256(45)); uint256 commitEnd = vm.envOr('COMMIT_END', uint256(20)); uint256 revealEnd = vm.envOr('REVEAL_END', uint256(35)); uint256 bond = vm.envOr('BOND', uint256(2_000_000));
        BlindBook book = new BlindBook(token, epochLen, commitEnd, revealEnd, bond);
        for (uint256 i = 0; i < ms.length; i++) book.listMarket(keccak256(bytes(ms[i].id)), ms[i].tick);
        vm.stopBroadcast();
        string memory j = string.concat('{"chainId":', vm.toString(block.chainid), ',"book":"', vm.toString(address(book)), '","token":"', vm.toString(token), '","deployBlock":', vm.toString(block.number), ',"epochLen":', vm.toString(epochLen), ',"commitEnd":', vm.toString(commitEnd), ',"revealEnd":', vm.toString(revealEnd), ',"bond":', vm.toString(bond), '}');
        vm.writeFile(string.concat('deployments/blindbook-', vm.toString(block.chainid), '.json'), j);
        console.log('BlindBook', address(book));
    }
}
