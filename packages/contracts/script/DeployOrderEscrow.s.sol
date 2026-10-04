// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from 'forge-std/Script.sol';
import {VmSafe} from 'forge-std/Vm.sol';
import {OrderEscrow} from '../src/OrderEscrow.sol';

/// Deploys OrderEscrow (one SKU, one named verifier) against the already-deployed BlindBook and its payment token.
/// Env: DEPLOYER_PRIVATE_KEY, ESCROW_VERIFIER (required, the delivery verifier / operator address).
/// Optional: MARKET_ID (the catalog id string, default CASE-IP16PRO-CLEAR-MAG-001, hashed with keccak256 like DeployBook; a 0x + 64 hex value is taken as the bytes32 id),
/// ESCROW_BPS (bond, default 2000), ACCEPT_WINDOW 900, SHIP_WINDOW 1800, VERIFY_WINDOW 1800, DISPUTE_WINDOW 600, RESOLVE_WINDOW 900 (seconds),
/// BOOK_FILE (default deployments/blindbook-<chainid>.json, which supplies .book and .token).
/// OVERWRITE=1 is required to run on chain 46630 when deployments/orders-46630.json already exists (the script refuses otherwise).
/// Writes deployments/orders-46630.json ONLY when the script runs with --broadcast on chain 46630 (a dry run or any other chain never writes).
/// CAVEAT: `forge script --broadcast` executes run() once as a local pass BEFORE it sends any transaction, and the file is written in that pass.
/// So the file can name an address whose broadcast then failed or was never mined. After the broadcast ALWAYS verify with
/// `cast code <escrow> --rpc-url <rpc>` (non-empty) before trusting or committing the file. The file carries no block number or timestamp of its own and
/// every value in it is read back from the contract in that local pass. Take the real deploy block from
/// broadcast/DeployOrderEscrow.s.sol/46630/run-latest.json (receipt blockNumber).
contract DeployOrderEscrow is Script {
    string constant DEFAULT_MARKET = 'CASE-IP16PRO-CLEAR-MAG-001';
    /// keccak256(abi.encode("SKU1", model, variant, condition)): no ship-to in the SKU.
    function sku() public pure returns (bytes32) { return keccak256(abi.encode('SKU1', 'iPhone 16 Pro Clear MagSafe Case', 'iPhone 16 Pro', 'new-sealed')); }
    function marketIdOf(string memory s) public pure returns (bytes32) {
        bytes memory b = bytes(s);
        if (b.length == 66 && b[0] == '0' && (b[1] == 'x' || b[1] == 'X')) return bytes32(vm.parseBytes32(s));
        return keccak256(b);
    }
    function run() external {
        string memory outFile = 'deployments/orders-46630.json';
        if (block.chainid == 46630 && vm.exists(outFile) && !vm.envOr('OVERWRITE', false)) revert('deployments/orders-46630.json exists: set OVERWRITE=1 to replace it');
        uint256 pk = vm.envUint('DEPLOYER_PRIVATE_KEY');
        address verifier = vm.envAddress('ESCROW_VERIFIER');
        string memory file = vm.envOr('BOOK_FILE', string.concat('deployments/blindbook-', vm.toString(block.chainid), '.json'));
        string memory bb = vm.readFile(file);
        address book = vm.parseJsonAddress(bb, '.book'); address token = vm.parseJsonAddress(bb, '.token'); uint256 bookBlock = vm.parseJsonUint(bb, '.deployBlock');
        bytes32 market = marketIdOf(vm.envOr('MARKET_ID', DEFAULT_MARKET));
        uint256 bps = vm.envOr('ESCROW_BPS', uint256(2000));
        uint256[5] memory w = [vm.envOr('ACCEPT_WINDOW', uint256(900)), vm.envOr('SHIP_WINDOW', uint256(1800)), vm.envOr('VERIFY_WINDOW', uint256(1800)), vm.envOr('DISPUTE_WINDOW', uint256(600)), vm.envOr('RESOLVE_WINDOW', uint256(900))];
        vm.startBroadcast(pk);
        OrderEscrow esc = new OrderEscrow(token, book, market, sku(), verifier, bps, w[0], w[1], w[2], w[3], w[4]);
        vm.stopBroadcast();
        console.log('OrderEscrow', address(esc)); console.log('verifier (trusted, named)', verifier);
        bool real = block.chainid == 46630 && vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        if (!real) { console.log('not writing deployments/orders-46630.json: needs --broadcast on chain 46630'); return; }
        // read everything back from the contract rather than echoing the inputs
        string memory j = string.concat('{"chainId":', vm.toString(block.chainid), ',"escrow":"', vm.toString(address(esc)), '","book":"', vm.toString(address(esc.book())), '","token":"', vm.toString(address(esc.token())),
            '","market":"', vm.toString(esc.MARKET()), '","sku":"', vm.toString(esc.SKU()), '","verifier":"', vm.toString(esc.verifier()), '","bondBps":', vm.toString(esc.bondBps()),
            ',"acceptWindow":', vm.toString(esc.acceptWindow()), ',"shipWindow":', vm.toString(esc.shipWindow()), ',"verifyWindow":', vm.toString(esc.verifyWindow()),
            ',"disputeWindow":', vm.toString(esc.disputeWindow()), ',"resolveWindow":', vm.toString(esc.resolveWindow()), ',"logsFromBlock":', vm.toString(bookBlock), '}');
        vm.writeFile(outFile, j);
    }
}
