# Mutation check for the agent-factory contracts: remove one guard at a time and require the tests to fail.
# Usage: python3 scripts/mutate-agents.py   (restores every file; prints SURVIVORS: [] when every guard is covered)
import os, subprocess, sys
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'packages', 'contracts'))
M = [
 ('src/AgentAccount.sol', "        _checkCallData(op.callData);\n", "", "validate skips call-data check"),
 ('src/AgentAccount.sol', "if (target != vault) revert TargetNotAllowed(target);", "", "no target lock"),
 ('src/AgentAccount.sol', "if (value != 0) revert ValueNotAllowed(value);", "", "no value lock"),
 ('src/AgentAccount.sol', "if (!_agentSelector(sel)) revert SelectorNotAllowed(sel);", "", "no selector lock"),
 ('src/AgentAccount.sol', "if (!_signedBySigner(_ethSigned(userOpHash), op.signature)) validationData = SIG_VALIDATION_FAILED;", "", "signature never checked"),
 ('src/AgentAccount.sol', "if (msg.sender != entryPoint) revert NotEntryPoint();\n        _check(target, value, data);", "_check(target, value, data);", "execute callable by anyone"),
 ('src/AgentAccount.sol', "if (msg.sender != entryPoint) revert NotEntryPoint();\n        // The call rules", "// The call rules", "validate callable by anyone"),
 ('src/AgentAccount.sol', "if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;", "", "malleable sigs accepted"),
 ('src/AgentAccount.sol', "if (msg.sender != owner) revert NotOwner();\n        if (s == address(0))", "if (s == address(0))", "anyone rotates key"),
 ('src/AgentAccount.sol', "if (msg.sender != owner) revert NotOwner();\n        IEntryPoint", "IEntryPoint", "anyone withdraws deposit"),
 ('src/AgentAccount.sol', "if (msg.sender != factory) revert NotFactory();", "", "anyone can init"),
 ('src/AgentAccount.sol', "if (initialized) revert AlreadyInitialized();", "", "init twice"),
 ('src/AgentAccount.sol', "return a != address(0) && a == signer;", "return a != address(0);", "any signer accepted"),
 ('src/AgentAccount.sol', "if (!ok) revert PrefundFailed();", "", "prefund failure ignored"),
 ('src/AgentIdentityRegistry.sol', "if (!_validSig(newWallet, digest, signature)) revert BadWalletSignature();", "", "wallet proof skipped"),
 ('src/AgentIdentityRegistry.sol', "if (block.timestamp > deadline) revert DeadlineExpired(deadline);", "", "deadline not enforced"),
 ('src/AgentIdentityRegistry.sol', "if (deadline > block.timestamp + MAX_DEADLINE_DELAY) revert DeadlineTooFar(deadline);", "", "far deadline allowed"),
 ('src/AgentIdentityRegistry.sol', "_agentWallet[id] = address(0);\n            emit MetadataSet(id, 'agentWallet', 'agentWallet', abi.encode(address(0)));\n        }\n    }\n    function safeTransferFrom(address from, address to, uint256 id) external", "}\n    }\n    function safeTransferFrom(address from, address to, uint256 id) external", "wallet survives transfer"),
 ('src/AgentIdentityRegistry.sol', "if (keccak256(bytes(key)) == AGENT_WALLET_KEY) revert ReservedKey();", "", "reserved key writable"),
 ('src/AgentIdentityRegistry.sol', "if (msg.sender != o && _approved[id] != msg.sender && !_operators[o][msg.sender]) revert NotAuthorized();", "", "anyone is approved"),
 ('src/AgentIdentityRegistry.sol', "_owners[agentId], deadline))));", "address(0), deadline))));", "signature not bound to owner"),
 ('src/AgentIdentityRegistry.sol', "block.chainid, address(this)));", "uint256(0), address(this)));", "domain without chain id"),
 ('src/AgentFactory.sol', "registry.transferFrom(address(this), msg.sender, agentId);", "", "NFT stays with factory"),
 ('src/AgentFactory.sol', "address(acct), msg.sender, p.dailyCap", "address(acct), address(this), p.dailyCap", "factory owns the vault"),
 ('src/AgentFactory.sol', "acct.init(address(v), p.agentKey, msg.sender);", "acct.init(address(v), p.agentKey, address(this));", "factory owns the account"),
 ('src/AgentFactory.sol', "if (p.payees.length > 8 || p.payers.length > 8) revert TooMany();", "", "no payee cap"),
 ('src/MandateVault.sol', "owner = _owner;", "owner = msg.sender;", "vault owner = deployer"),
 ('src/MandateVault.sol', "if (marginBps < 100 || marginBps > 9000) revert BadMargin(marginBps);", "", "no margin bounds"),
 ('src/MandateVault.sol', "payee[payees[i]] = true;", "", "payees ignored"),
 ('src/AgentIdentityRegistry.sol', "block.chainid, address(this)));", "uint256(0), address(this)));", "domain without chain id"),
 ('src/AgentIdentityRegistry.sol', "keccak256(bytes('ERC8004IdentityRegistry'))", "keccak256(bytes('x'))", "wrong domain name"),
 ('src/AgentAccount.sol', 'if (tip != 0) revert TipNotAllowed(tip);', '', 'tips accepted'),
 ('src/AgentAccount.sol', '|| op.preVerificationGas > MAX_PRE_VERIFICATION_GAS) revert', ') revert', 'pre-verification gas uncapped'),
 ('src/AgentAccount.sol', 'if (verificationGas > MAX_VERIFICATION_GAS ||', 'if (', 'verification gas uncapped'),
 ('src/AgentAccount.sol', '|| callGas > MAX_CALL_GAS', '', 'call gas uncapped'),
 ('src/TokenFaucet.sol', "if (block.timestamp < nextDripAt[msg.sender]) revert TooSoon(nextDripAt[msg.sender]);", "", "no faucet cooldown check"),
 ('src/TokenFaucet.sol', "nextDripAt[msg.sender] = block.timestamp + cooldown;", "", "cooldown never recorded"),
 ('src/TokenFaucet.sol', "if (bal < amount) revert Empty(bal, amount);", "", "empty faucet not reported"),
]
def run_tests():
    return subprocess.run("forge test --match-path test/AgentFactory.t.sol >/dev/null 2>&1", shell=True).returncode

# a mutant counts as killed only if the suite passes WITHOUT it and fails WITH it (a compile error or a missing forge must not look like a kill)
if run_tests() != 0:
    print("BASELINE FAILS: the unmodified tests do not pass, nothing to mutate"); sys.exit(2)
survived = []
seen = set()
for (f, a, b, name) in M:
    if (f, a, b) in seen: continue
    seen.add((f, a, b))
    src = open(f).read()
    if a not in src: print("NOT FOUND:", name); survived.append(name + " (pattern missing)"); continue
    try:
        open(f, 'w').write(src.replace(a, b, 1))
        killed = run_tests() != 0
    finally:
        open(f, 'w').write(src)          # always restore, even on Ctrl-C
    print(('KILLED   ' if killed else 'SURVIVED ') + name, flush=True)
    if not killed: survived.append(name)
print("SURVIVORS:", survived)
sys.exit(1 if survived else 0)
