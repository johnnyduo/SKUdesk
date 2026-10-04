// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from 'forge-std/Test.sol';
import {Vm} from 'forge-std/Vm.sol';
import {SKUdeskCore} from '../src/SKUdeskCore.sol';
import {EconLib} from '../src/EconLib.sol';
import {MockUSDC} from '../src/MockUSDC.sol';
import {MandateVault} from '../src/MandateVault.sol';
import {AgentAccount} from '../src/AgentAccount.sol';
import {AgentFactory} from '../src/AgentFactory.sol';
import {AgentIdentityRegistry} from '../src/AgentIdentityRegistry.sol';
import {PackedUserOperation, IEntryPoint} from '../src/IEntryPoint.sol';

/// The EntryPoint is the REAL v0.7 runtime code copied from chain 46630 (test/fixtures/entrypoint-v0.7.hex),
/// installed at its canonical address, so these tests exercise the same contract the testnet account talks to.
contract AgentBase is Test {
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    bytes32 constant EP_CODEHASH = 0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58;
    bytes32 constant PROD = keccak256('CASE-IP16PRO-CLEAR-MAG-001');
    bytes32 constant SNAP = keccak256('snapshot-1');
    uint256 constant CENT = 10_000;

    MockUSDC usdc; AgentIdentityRegistry reg; AgentFactory factory;
    address human = address(0xB0B); address supplier = address(0x5011); address market = address(0xBEEF);
    address bundler = address(0xB0D1E); address thief = address(0xDEAD);
    uint256 agentPk = 0xA6E47; address agentKey;
    MandateVault vault; AgentAccount account; uint256 agentId;

    function setUp() public virtual {
        vm.etch(EP, vm.parseBytes(vm.readFile('test/fixtures/entrypoint-v0.7.hex')));
        require(EP.codehash == EP_CODEHASH, 'fixture is the chain code');
        agentKey = vm.addr(agentPk);
        usdc = new MockUSDC();
        reg = new AgentIdentityRegistry();
        factory = new AgentFactory(address(usdc), EP, reg);
        address[] memory payees = new address[](1); payees[0] = supplier;
        address[] memory payers = new address[](1); payers[0] = market;
        vm.prank(human);
        (, address v, address a, uint256 id) = factory.createAgent(AgentFactory.Params(agentKey, 500_000, 250_000, 1800, 180, 'data:application/json;base64,e30=', payees, payers));
        vault = MandateVault(v); account = AgentAccount(payable(a)); agentId = id;
        usdc.mint(human, 5_000_000_000);
        vm.startPrank(human); usdc.approve(address(vault), type(uint256).max); vault.deposit(5_000_000_000); vm.stopPrank();
        usdc.mint(market, 10_000_000_000);
        vm.prank(market); usdc.approve(address(vault), type(uint256).max);
        vm.deal(human, 10 ether); vm.deal(bundler, 1 ether);
        vm.prank(human); account.addDeposit{value: 1 ether}();
        vm.warp(1_000_000);
    }

    function HQ() internal pure returns (EconLib.Quote memory) { return EconLib.Quote(590, 42, 12, 8, 5, 2, 1099, 800, 65, 200, 4); }
    function qh(EconLib.Quote memory q) internal pure returns (bytes32) { return keccak256(abi.encode(q)); }
    function heroCall(uint256 units, int256 net, uint256 bps) internal view returns (bytes memory) {
        EconLib.Quote memory q = HQ();
        return abi.encodeCall(SKUdeskCore.commitOpportunity, (PROD, qh(q), SNAP, block.timestamp, units, q, net, bps));
    }
    function oppHash() internal pure returns (bytes32) { return keccak256(abi.encode(PROD, qh(EconLib.Quote(590, 42, 12, 8, 5, 2, 1099, 800, 65, 200, 4)), SNAP)); }

    function wrap(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(AgentAccount.execute, (target, value, data));
    }
    function userOp(address sender, bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = sender;
        op.nonce = IEntryPoint(EP).getNonce(sender, 0);
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(600_000) << 128) | uint256(2_000_000));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32(uint256(1 gwei));   // no priority tip: the account refuses one
    }
    function sign(PackedUserOperation memory op, uint256 pk) internal view returns (PackedUserOperation memory) {
        bytes32 h = IEntryPoint(EP).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked('\x19Ethereum Signed Message:\n32', h)));
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }
    function send(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1); ops[0] = op;
        vm.prank(bundler); IEntryPoint(EP).handleOps(ops, payable(bundler));
    }
    /// handleOps revert data for one op (empty if it did not revert)
    function sendExpectRevert(PackedUserOperation memory op) internal returns (bytes memory data) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1); ops[0] = op;
        vm.prank(bundler);
        try IEntryPoint(EP).handleOps(ops, payable(bundler)) { revert('expected handleOps to revert'); } catch (bytes memory d) { data = d; }
    }
    function contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool ok = true;
            for (uint256 j; j < needle.length; ++j) if (hay[i + j] != needle[j]) { ok = false; break; }
            if (ok) return true;
        }
        return false;
    }
    function signedOp(bytes memory callData) internal view returns (PackedUserOperation memory) { return sign(userOp(address(account), callData), agentPk); }
}

contract FactoryTest is AgentBase {
    function testCreatesEverythingAndHandsItToTheCaller() public view {
        require(vault.owner() == human, 'vault owner is the human');
        require(vault.agent() == address(account), 'vault agent is the locked account');
        require(account.vault() == address(vault) && account.signer() == agentKey && account.owner() == human, 'account bound');
        require(account.entryPoint() == EP, 'canonical entrypoint');
        require(reg.ownerOf(agentId) == human, 'identity NFT owned by the human');
        require(factory.agentCount() == 1 && factory.agentsOf(human)[0] == 0, 'indexed');
        require(vault.dailySpendCap() == 500_000 && vault.maxExec() == 250_000 && vault.minMarginBps() == 1800 && vault.quoteTTL() == 180, 'policy');
        require(vault.payee(supplier) && vault.payer(market) && !vault.payee(thief), 'allowlists');
        require(address(vault.token()) == address(usdc), 'token');
    }
    function testIdentityRecordsVaultAndAccount() public view {
        require(abi.decode(reg.getMetadata(agentId, 'vault'), (address)) == address(vault), 'vault in identity');
        require(abi.decode(reg.getMetadata(agentId, 'agentAccount'), (address)) == address(account), 'account in identity');
        require(abi.decode(reg.getMetadata(agentId, 'chainId'), (uint256)) == block.chainid, 'chain');
        require(keccak256(bytes(reg.tokenURI(agentId))) == keccak256('data:application/json;base64,e30='), 'uri');
    }
    function testTwoUsersGetSeparateAgents() public {
        address[] memory none = new address[](0);
        vm.prank(thief);
        (uint256 i2, address v2, address a2,) = factory.createAgent(AgentFactory.Params(address(0x77), 100, 50, 1800, 180, '', none, none));
        require(i2 == 1 && v2 != address(vault) && a2 != address(account), 'new vault and account');
        require(MandateVault(v2).owner() == thief, 'each owner owns their own vault');
        require(MandateVault(v2).agent() == a2, 'agent wired');
        vm.expectRevert(SKUdeskCore.Unauthorized.selector);
        vm.prank(thief); vault.pause(true);   // the second user has no power over the first vault
    }
    function testRejectsZeroAgentKey() public {
        address[] memory none = new address[](0);
        vm.expectRevert(AgentFactory.BadAgentKey.selector);
        factory.createAgent(AgentFactory.Params(address(0), 100, 50, 1800, 180, '', none, none));
    }
    function testRejectsBadMarginAndTooManyPayees() public {
        address[] memory none = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.BadMargin.selector, uint256(50)));
        factory.createAgent(AgentFactory.Params(address(0x77), 100, 50, 50, 180, '', none, none));
        vm.expectRevert(abi.encodeWithSelector(MandateVault.BadMargin.selector, uint256(9001)));
        factory.createAgent(AgentFactory.Params(address(0x77), 100, 50, 9001, 180, '', none, none));
        address[] memory nine = new address[](9);
        vm.expectRevert(AgentFactory.TooMany.selector);
        factory.createAgent(AgentFactory.Params(address(0x77), 100, 50, 1800, 180, '', nine, none));
    }
    function testOwnerCanStillUseEveryOwnerFunctionOnTheNewVault() public {
        vm.startPrank(human);
        vault.pause(true); require(vault.paused(), 'pause'); vault.pause(false);
        vault.setPolicy(1, 1, 1800, 1); vault.setPayee(thief, true); vault.setPayer(thief, true);
        vault.withdraw(1_000_000); vm.stopPrank();
        require(usdc.balanceOf(human) == 1_000_000, 'withdraw');
    }
}

contract AccountTest is AgentBase {
    function testHonestUserOpCommitsThroughTheRealEntryPoint() public {
        send(signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374))));
        (, , , uint256 spend, , bool exists,) = vault.opps(oppHash());
        require(exists && spend == 158160, 'opportunity committed by the account');
        require(vault.spentToday() == 158160, 'spend derived on-chain');
    }
    function testFullLotLifecycleThroughTheAccount() public {
        send(signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374))));
        send(signedOp(wrap(address(vault), 0, abi.encodeCall(SKUdeskCore.mintLot, (oppHash())))));
        send(signedOp(wrap(address(vault), 0, abi.encodeCall(SKUdeskCore.fundLot, (1)))));
        send(signedOp(wrap(address(vault), 0, abi.encodeCall(SKUdeskCore.markPurchased, (1, supplier, 140_000_000)))));
        send(signedOp(wrap(address(vault), 0, abi.encodeCall(SKUdeskCore.markReceived, (1)))));
        send(signedOp(wrap(address(vault), 0, abi.encodeCall(SKUdeskCore.markListed, (1)))));
        send(signedOp(wrap(address(vault), 0, abi.encodeCall(SKUdeskCore.markSold, (1)))));
        send(signedOp(wrap(address(vault), 0, abi.encodeCall(SKUdeskCore.settle, (1, market, 263_000_000)))));
        require(uint8(vault.statusOf(1)) == uint8(SKUdeskCore.LS.SETTLED), 'settled');
        require(usdc.balanceOf(supplier) == 140_000_000, 'supplier paid by the vault');
        require(usdc.balanceOf(address(vault)) == 5_000_000_000 - 140_000_000 + 263_000_000, 'vault cash conserved');
    }
    function testVaultRulesStillApplyThroughTheAccount() public {
        // a lying agent: the UserOp is accepted by the account but the vault refuses; nothing is committed
        send(signedOp(wrap(address(vault), 0, heroCall(240, 390, 2374))));
        (, , , , , bool exists,) = vault.opps(oppHash());
        require(!exists && vault.spentToday() == 0, 'vault refused the lie');
        // a spend above the per-trade cap: 659 * 400 = 263,600 cents > 250,000
        send(signedOp(wrap(address(vault), 0, heroCall(400, 261, 2374))));
        require(vault.spentToday() == 0, 'vault refused the oversized trade');
    }
    function testRevertReasonOfTheVaultIsVisibleInTheEntryPointLog() public {
        vm.recordLogs();
        send(signedOp(wrap(address(vault), 0, heroCall(400, 261, 2374))));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256('UserOperationRevertReason(bytes32,address,uint256,bytes)')) {
                (, bytes memory reason) = abi.decode(logs[i].data, (uint256, bytes));
                require(bytes4(reason) == SKUdeskCore.SpendCap.selector, 'the vault custom error is passed through unchanged');
                found = true;
            }
        }
        require(found, 'revert reason emitted');
    }

    // ---- attacks: each one must be refused by the ACCOUNT before anything executes
    function testWrongSignerRejected() public {
        PackedUserOperation memory op = sign(userOp(address(account), wrap(address(vault), 0, heroCall(240, 261, 2374))), 0xBAD);
        bytes memory d = sendExpectRevert(op);
        require(contains(d, bytes('AA24')), 'AA24 signature error');
        (, , , , , bool exists,) = vault.opps(oppHash());
        require(!exists, 'nothing happened');
    }
    function testTamperedCallDataRejected() public {
        PackedUserOperation memory op = signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374)));
        op.callData = wrap(address(vault), 0, heroCall(1, 261, 2374));   // changed after signing
        bytes memory d = sendExpectRevert(op);
        require(contains(d, bytes('AA24')), 'signature no longer matches');
    }
    function testCannotCallTheTokenToDrainFunds() public {
        bytes memory steal = abi.encodeWithSelector(usdc.transfer.selector, thief, 1_000_000_000);
        bytes memory d = sendExpectRevert(signedOp(wrap(address(usdc), 0, steal)));
        require(contains(d, abi.encodeWithSelector(AgentAccount.TargetNotAllowed.selector, address(usdc))), 'target refused');
        require(usdc.balanceOf(thief) == 0, 'nothing stolen');
    }
    function testCannotCallAnyOtherContract() public {
        bytes memory d = sendExpectRevert(signedOp(wrap(thief, 0, hex'12345678')));
        require(contains(d, abi.encodeWithSelector(AgentAccount.TargetNotAllowed.selector, thief)), 'target refused');
    }
    function testCannotSendEth() public {
        bytes memory d = sendExpectRevert(signedOp(wrap(address(vault), 1, heroCall(240, 261, 2374))));
        require(contains(d, abi.encodeWithSelector(AgentAccount.ValueNotAllowed.selector, uint256(1))), 'value refused');
        d = sendExpectRevert(signedOp(wrap(thief, 1 ether, '')));
        require(thief.balance == 0, 'no ETH to the thief');
    }
    function testCannotCallOwnerFunctionsOnTheVault() public {
        bytes[5] memory ownerCalls = [
            abi.encodeCall(SKUdeskCore.withdraw, (1_000_000)),
            abi.encodeCall(SKUdeskCore.setPolicy, (type(uint256).max, type(uint256).max, 1800, 1)),
            abi.encodeCall(SKUdeskCore.setAgent, (thief)),
            abi.encodeCall(SKUdeskCore.setPayee, (thief, true)),
            abi.encodeCall(SKUdeskCore.pause, (true))
        ];
        for (uint256 i; i < ownerCalls.length; ++i) {
            bytes memory d = sendExpectRevert(signedOp(wrap(address(vault), 0, ownerCalls[i])));
            require(contains(d, abi.encodeWithSelector(AgentAccount.SelectorNotAllowed.selector, bytes4(ownerCalls[i]))), 'owner selector refused');
        }
        require(vault.agent() == address(account) && !vault.payee(thief) && !vault.paused(), 'vault untouched');
    }
    function testEveryAgentFunctionPassesTheAccountLock() public {
        // each agent function must get past the account's selector check (the vault then judges it on its own rules)
        bytes[10] memory calls = [
            heroCall(240, 261, 2374), abi.encodeCall(SKUdeskCore.mintLot, (bytes32(uint256(1)))), abi.encodeCall(SKUdeskCore.fundLot, (1)),
            abi.encodeCall(SKUdeskCore.markPurchased, (1, supplier, 1)), abi.encodeCall(SKUdeskCore.markReceived, (1)), abi.encodeCall(SKUdeskCore.markListed, (1)),
            abi.encodeCall(SKUdeskCore.markSold, (1)), abi.encodeCall(SKUdeskCore.settle, (1, market, 1)), abi.encodeCall(SKUdeskCore.cancel, (1)), abi.encodeCall(SKUdeskCore.refund, (1))
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(EP);
            try account.execute(address(vault), 0, calls[i]) {} catch (bytes memory d) {
                require(bytes4(d) != AgentAccount.SelectorNotAllowed.selector, 'agent function wrongly blocked by the account');
            }
        }
    }
    function testNotWrappedInExecuteRejected() public {
        bytes memory d = sendExpectRevert(signedOp(heroCall(240, 261, 2374)));
        require(contains(d, abi.encodeWithSelector(AgentAccount.BadCall.selector)), 'must be execute(...)');
    }
    function testShortCallDataRejected() public {
        bytes memory d = sendExpectRevert(signedOp(hex'aa'));
        require(contains(d, abi.encodeWithSelector(AgentAccount.BadCall.selector)), 'bad call');
    }
    function testReplayedUserOpRejected() public {
        PackedUserOperation memory op = signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374)));
        send(op);
        bytes memory d = sendExpectRevert(op);
        require(contains(d, bytes('AA25')), 'AA25 invalid nonce');
    }
    function testDirectCallsToTheAccountRejected() public {
        vm.expectRevert(AgentAccount.NotEntryPoint.selector);
        vm.prank(agentKey); account.execute(address(vault), 0, heroCall(240, 261, 2374));
        PackedUserOperation memory op = signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374)));
        vm.expectRevert(AgentAccount.NotEntryPoint.selector);
        vm.prank(agentKey); account.validateUserOp(op, bytes32(0), 0);
    }
    function testAgentKeyCannotCallTheVaultDirectly() public {
        EconLib.Quote memory q = HQ();
        vm.expectRevert(SKUdeskCore.Unauthorized.selector);
        vm.prank(agentKey); vault.commitOpportunity(PROD, qh(q), SNAP, block.timestamp, 240, q, 261, 2374);
    }
    function testHighSSignatureRejected() public {
        PackedUserOperation memory op = userOp(address(account), wrap(address(vault), 0, heroCall(240, 261, 2374)));
        bytes32 h = IEntryPoint(EP).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, keccak256(abi.encodePacked('\x19Ethereum Signed Message:\n32', h)));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        op.signature = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));   // the malleated twin
        bytes memory d = sendExpectRevert(op);
        require(contains(d, bytes('AA24')), 'malleated signature refused');
    }

    function testGasLimitsAndTipAreBounded() public {
        PackedUserOperation memory op = userOp(address(account), wrap(address(vault), 0, heroCall(240, 261, 2374)));
        op.accountGasLimits = bytes32((uint256(5_000_000) << 128) | uint256(2_000_000));    // huge verification gas
        bytes memory d = sendExpectRevert(sign(op, agentPk));
        require(contains(d, abi.encodeWithSelector(AgentAccount.GasTooHigh.selector, uint256(5_000_000), uint256(2_000_000), uint256(100_000))), 'verification gas capped');
        op = userOp(address(account), wrap(address(vault), 0, heroCall(240, 261, 2374)));
        op.accountGasLimits = bytes32((uint256(600_000) << 128) | uint256(9_000_000));      // huge call gas
        d = sendExpectRevert(sign(op, agentPk)); require(contains(d, abi.encodePacked(AgentAccount.GasTooHigh.selector)), 'call gas capped');
        op = userOp(address(account), wrap(address(vault), 0, heroCall(240, 261, 2374)));
        op.preVerificationGas = 10_000_000;
        d = sendExpectRevert(sign(op, agentPk)); require(contains(d, abi.encodePacked(AgentAccount.GasTooHigh.selector)), 'pre-verification gas capped');
        op = userOp(address(account), wrap(address(vault), 0, heroCall(240, 261, 2374)));
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(1 gwei));                   // a tip for the bundler (the agent itself)
        d = sendExpectRevert(sign(op, agentPk)); require(contains(d, abi.encodeWithSelector(AgentAccount.TipNotAllowed.selector, uint256(1 gwei))), 'tip refused');
    }
    function testTheAgentCannotPayItselfFromTheDeposit() public {
        // an honest-looking op with the maximum allowed gas: whoever bundles it earns nothing beyond the real gas cost
        uint256 before = account.deposit();
        send(signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374))));
        uint256 spent = before - account.deposit();
        require(spent < 0.01 ether, 'one op costs a small, bounded amount');
    }

    // ---- owner controls
    function testOwnerRotatesTheKey() public {
        uint256 newPk = 0xBEEF1; address newKey = vm.addr(newPk);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        vm.prank(thief); account.setSigner(newKey);
        vm.prank(human); account.setSigner(newKey);
        bytes memory d = sendExpectRevert(signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374))));   // old key now refused
        require(contains(d, bytes('AA24')), 'old key refused');
        send(sign(userOp(address(account), wrap(address(vault), 0, heroCall(240, 261, 2374))), newPk));
        (, , , , , bool exists,) = vault.opps(oppHash());
        require(exists, 'new key works');
    }
    function testOwnerKillSwitchStillStopsTheAgent() public {
        vm.prank(human); vault.pause(true);
        send(signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374))));
        (, , , , , bool exists,) = vault.opps(oppHash());
        require(!exists, 'paused vault refuses the account');
    }
    function testOnlyOwnerWithdrawsTheGasDeposit() public {
        vm.expectRevert(AgentAccount.NotOwner.selector);
        vm.prank(thief); account.withdrawDeposit(payable(thief), 1);
        uint256 before = human.balance;
        vm.prank(human); account.withdrawDeposit(payable(human), 0.5 ether);
        require(human.balance == before + 0.5 ether, 'owner took ETH back');
        require(account.deposit() == 0.5 ether, 'deposit view');
    }
    function testInitOnlyOnceAndOnlyByFactory() public {
        vm.expectRevert(AgentAccount.NotFactory.selector);
        vm.prank(thief); account.init(thief, thief, thief);
        vm.expectRevert(AgentAccount.NotFactory.selector);   // even the human cannot rebind it
        vm.prank(human); account.init(thief, thief, thief);
        vm.expectRevert(AgentAccount.AlreadyInitialized.selector);
        vm.prank(address(factory)); account.init(thief, thief, thief);
    }
    function testAccountSelfPaysPrefundWhenDepositEmpty() public {
        vm.prank(human); account.withdrawDeposit(payable(human), 1 ether);   // empty the EntryPoint deposit
        vm.deal(address(account), 1 ether);                                   // the account holds ETH instead
        send(signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374))));
        (, , , , , bool exists,) = vault.opps(oppHash());
        require(exists, 'prefund paid from the account balance');
    }
    function testNoDepositNoExecution() public {
        vm.prank(human); account.withdrawDeposit(payable(human), 1 ether);
        bytes memory d = sendExpectRevert(signedOp(wrap(address(vault), 0, heroCall(240, 261, 2374))));
        require(contains(d, bytes('AA23')), 'account could not prefund, op refused');
    }
}

contract IdentityTest is AgentBase {
    function testHumanOwnsAndManagesTheIdentity() public {
        vm.expectRevert(AgentIdentityRegistry.NotAuthorized.selector);
        vm.prank(thief); reg.setAgentURI(agentId, 'https://evil');
        vm.prank(human); reg.setAgentURI(agentId, 'https://example.com/agent.json');
        require(keccak256(bytes(reg.tokenURI(agentId))) == keccak256('https://example.com/agent.json'), 'uri updated');
        vm.prank(human); reg.setMetadata(agentId, 'strategy', 'arbitrage');
        require(keccak256(reg.getMetadata(agentId, 'strategy')) == keccak256('arbitrage'), 'metadata');
    }
    function testDomainSeparatorMatchesEip712() public view {
        bytes32 expected = keccak256(abi.encode(
            keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
            keccak256('ERC8004IdentityRegistry'), keccak256('1'), block.chainid, address(reg)));
        require(reg.domainSeparator() == expected, 'EIP-712 domain includes chain id and contract');
    }
    function testAgentWalletKeyIsReserved() public {
        vm.expectRevert(AgentIdentityRegistry.ReservedKey.selector);
        vm.prank(human); reg.setMetadata(agentId, 'agentWallet', abi.encode(thief));
    }
    function testAgentWalletIsEmptyAfterTheFactoryHandsOverTheToken() public view {
        require(reg.getAgentWallet(agentId) == address(0), 'cleared on transfer');
    }
    function _digest(uint256 id, address wallet, address ownerAddr, uint256 deadline) internal view returns (bytes32) {
        return keccak256(abi.encodePacked('\x19\x01', reg.domainSeparator(), keccak256(abi.encode(reg.AGENT_WALLET_TYPEHASH(), id, wallet, ownerAddr, deadline))));
    }
    function testSetAgentWalletWithEoaSignature() public {
        uint256 pk = 0xCAFE; address w = vm.addr(pk); uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(agentId, w, human, dl));
        vm.prank(human); reg.setAgentWallet(agentId, w, dl, abi.encodePacked(r, s, v));
        require(reg.getAgentWallet(agentId) == w, 'wallet set');
        require(abi.decode(reg.getMetadata(agentId, 'agentWallet'), (address)) == w, 'reserved key reads the wallet');
    }
    function testSetAgentWalletToTheAgentAccountWithErc1271() public {
        uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, _digest(agentId, address(account), human, dl));   // the agent key vouches for its account
        vm.prank(human); reg.setAgentWallet(agentId, address(account), dl, abi.encodePacked(r, s, v));
        require(reg.getAgentWallet(agentId) == address(account), 'account is the agent wallet');
    }
    function testSetAgentWalletRejectsBadProofs() public {
        uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, _digest(agentId, address(account), human, dl));
        vm.expectRevert(AgentIdentityRegistry.BadWalletSignature.selector);
        vm.prank(human); reg.setAgentWallet(agentId, address(account), dl, abi.encodePacked(r, s, v));     // wrong key
        (v, r, s) = vm.sign(agentPk, _digest(agentId, address(account), human, dl));
        vm.expectRevert(AgentIdentityRegistry.NotAuthorized.selector);
        vm.prank(thief); reg.setAgentWallet(agentId, address(account), dl, abi.encodePacked(r, s, v));     // not the NFT owner
        vm.expectRevert(abi.encodeWithSelector(AgentIdentityRegistry.DeadlineExpired.selector, dl - 61));
        vm.prank(human); reg.setAgentWallet(agentId, address(account), dl - 61, abi.encodePacked(r, s, v));
        vm.expectRevert(abi.encodeWithSelector(AgentIdentityRegistry.DeadlineTooFar.selector, block.timestamp + 6 minutes));
        vm.prank(human); reg.setAgentWallet(agentId, address(account), block.timestamp + 6 minutes, abi.encodePacked(r, s, v));
    }
    function testSignatureIsBoundToTheOwnerSoItCannotFollowATransfer() public {
        uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, _digest(agentId, address(account), human, dl));
        vm.prank(human); reg.transferFrom(human, thief, agentId);
        vm.expectRevert(AgentIdentityRegistry.BadWalletSignature.selector);
        vm.prank(thief); reg.setAgentWallet(agentId, address(account), dl, abi.encodePacked(r, s, v));     // signed for the old owner
    }
    function testTransferClearsTheAgentWallet() public {
        uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, _digest(agentId, address(account), human, dl));
        vm.startPrank(human); reg.setAgentWallet(agentId, address(account), dl, abi.encodePacked(r, s, v));
        reg.transferFrom(human, thief, agentId); vm.stopPrank();
        require(reg.getAgentWallet(agentId) == address(0), 'wallet link cleared');
        require(reg.ownerOf(agentId) == thief && reg.balanceOf(human) == 0 && reg.balanceOf(thief) == 1, 'ownership moved');
    }
    function testUnsetAgentWallet() public {
        uint256 dl = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, _digest(agentId, address(account), human, dl));
        vm.startPrank(human); reg.setAgentWallet(agentId, address(account), dl, abi.encodePacked(r, s, v));
        reg.unsetAgentWallet(agentId); vm.stopPrank();
        require(reg.getAgentWallet(agentId) == address(0), 'unset');
    }
    function testRegisterOverloadsAndEvents() public {
        vm.expectEmit(true, true, false, true);
        emit AgentIdentityRegistry.Registered(2, 'ipfs://x', thief);
        vm.prank(thief); uint256 id = reg.register('ipfs://x');
        require(id == 2 && reg.ownerOf(2) == thief && reg.getAgentWallet(2) == thief, 'registered with owner as wallet');
        vm.prank(thief); require(reg.register() == 3, 'bare register');
        require(reg.totalAgents() == 3, 'count');
    }
    function testContractRegistrantMustAcceptTokens() public {
        vm.expectRevert(AgentIdentityRegistry.UnsafeRecipient.selector);
        vm.prank(address(usdc)); reg.register('x');           // a contract that cannot receive ERC-721 (like the real registry's _safeMint)
    }
    function testErc721Basics() public {
        require(reg.supportsInterface(0x80ac58cd) && reg.supportsInterface(0x5b5e139f) && reg.supportsInterface(0x01ffc9a7), 'erc165');
        vm.prank(human); reg.approve(thief, agentId);
        vm.prank(thief); reg.transferFrom(human, thief, agentId);
        require(reg.ownerOf(agentId) == thief && reg.getApproved(agentId) == address(0), 'approved transfer clears approval');
        vm.expectRevert(abi.encodeWithSelector(AgentIdentityRegistry.NoSuchAgent.selector, uint256(99)));
        reg.ownerOf(99);
        vm.expectRevert(AgentIdentityRegistry.NotAuthorized.selector);
        vm.prank(address(0x1234)); reg.transferFrom(thief, address(0x1234), agentId);
    }
}

import {TokenFaucet} from '../src/TokenFaucet.sol';
contract FaucetTest is AgentBase {
    TokenFaucet faucet;
    function setUp() public override {
        super.setUp();
        faucet = new TokenFaucet(address(usdc), 1_000_000_000, 1 days);
        usdc.mint(address(faucet), 3_000_000_000);
    }
    function testDripsOncePerDay() public {
        vm.prank(thief); faucet.drip();
        require(usdc.balanceOf(thief) == 1_000_000_000, 'received 1,000 mUSDC');
        vm.expectRevert(abi.encodeWithSelector(TokenFaucet.TooSoon.selector, block.timestamp + 1 days));
        vm.prank(thief); faucet.drip();
        vm.warp(block.timestamp + 1 days);
        vm.prank(thief); faucet.drip();
        require(usdc.balanceOf(thief) == 2_000_000_000, 'second drip after the cooldown');
    }
    function testEmptyFaucetSaysSo() public {
        for (uint256 i = 1; i <= 3; ++i) { vm.prank(address(uint160(i + 100))); faucet.drip(); }
        vm.expectRevert(abi.encodeWithSelector(TokenFaucet.Empty.selector, uint256(0), uint256(1_000_000_000)));
        vm.prank(address(0x999)); faucet.drip();
    }
    function testFaucetTokensFundANewVaultEndToEnd() public {
        vm.startPrank(thief); faucet.drip();
        address[] memory none = new address[](0);
        (, address v,,) = factory.createAgent(AgentFactory.Params(address(0x77), 100_000, 50_000, 1800, 180, '', none, none));
        usdc.approve(v, type(uint256).max); MandateVault(v).deposit(1_000_000_000); vm.stopPrank();
        require(MandateVault(v).free() == 1_000_000_000, 'funded from the faucet');
    }
}

/// A contract registrant that moves the new token to a buyer inside onERC721Received.
contract ReentrantRegistrant {
    AgentIdentityRegistry reg; address buyer; uint256 public lastId;
    constructor(AgentIdentityRegistry r, address b) { reg = r; buyer = b; }
    function go() external returns (uint256) { return reg.register('ipfs://x'); }
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        lastId = id; reg.transferFrom(address(this), buyer, id);   // sell the token inside the mint callback
        return this.onERC721Received.selector;
    }
}
contract RegistryReentrancyTest is AgentBase {
    function testTransferInsideTheMintCallbackStillClearsTheAgentWallet() public {
        ReentrantRegistrant r = new ReentrantRegistrant(reg, thief);
        uint256 id = r.go();
        require(reg.ownerOf(id) == thief, 'the buyer owns the token');
        require(reg.getAgentWallet(id) == address(0), 'the seller must not stay linked as the agent wallet');
        require(keccak256(bytes(reg.tokenURI(id))) == keccak256('ipfs://x'), 'uri was set');
    }
}

/// Exact gas caps of the agent account: the cap itself passes validation, one more is refused.
contract GasCapEdgeTest is AgentBase {
    function _op(uint256 verification, uint256 callGas, uint256 preVerification) internal view returns (PackedUserOperation memory op) {
        op = userOp(address(account), wrap(address(vault), 0, heroCall(240, 261, 2374)));
        op.accountGasLimits = bytes32((verification << 128) | callGas); op.preVerificationGas = preVerification;
        return sign(op, agentPk);
    }
    function testExactCapsPassAndOnePastEachIsRefused() public {
        send(_op(account.MAX_VERIFICATION_GAS(), account.MAX_CALL_GAS(), account.MAX_PRE_VERIFICATION_GAS()));
        (, , , , , bool ok,) = vault.opps(oppHash()); require(ok, 'an op at every cap executes');
        bytes memory d = sendExpectRevert(_op(account.MAX_VERIFICATION_GAS() + 1, 2_000_000, 100_000));
        require(contains(d, abi.encodePacked(AgentAccount.GasTooHigh.selector)), 'verification gas +1 refused');
        d = sendExpectRevert(_op(600_000, account.MAX_CALL_GAS() + 1, 100_000));
        require(contains(d, abi.encodePacked(AgentAccount.GasTooHigh.selector)), 'call gas +1 refused');
        d = sendExpectRevert(_op(600_000, 2_000_000, account.MAX_PRE_VERIFICATION_GAS() + 1));
        require(contains(d, abi.encodePacked(AgentAccount.GasTooHigh.selector)), 'pre-verification gas +1 refused');
    }
    function testEveryOwnerFunctionOfTheVaultIsRefusedByTheAccount() public {
        bytes[7] memory ownerCalls = [
            abi.encodeCall(SKUdeskCore.deposit, (1)), abi.encodeCall(SKUdeskCore.withdraw, (1)), abi.encodeCall(SKUdeskCore.setPolicy, (1, 1, 1800, 1)),
            abi.encodeCall(SKUdeskCore.setAgent, (thief)), abi.encodeCall(SKUdeskCore.setPayee, (thief, true)),
            abi.encodeCall(SKUdeskCore.setPayer, (thief, true)), abi.encodeCall(SKUdeskCore.pause, (true))
        ];
        for (uint256 i; i < ownerCalls.length; ++i) {
            bytes memory d = sendExpectRevert(signedOp(wrap(address(vault), 0, ownerCalls[i])));
            require(contains(d, abi.encodeWithSelector(AgentAccount.SelectorNotAllowed.selector, bytes4(ownerCalls[i]))), 'owner selector refused');
        }
    }
}
