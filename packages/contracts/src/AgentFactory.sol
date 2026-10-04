// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {MandateVault} from './MandateVault.sol';
import {AgentAccount} from './AgentAccount.sol';
import {AgentIdentityRegistry} from './AgentIdentityRegistry.sol';

/// @title AgentFactory - one transaction creates a user's agent: a mandate vault (owned by the caller), a locked
/// ERC-4337 account that is the vault's only agent, and an identity NFT (ERC-8004 style) owned by the caller.
contract AgentFactory {
    address public immutable token;
    address public immutable entryPoint;
    AgentIdentityRegistry public immutable registry;

    struct Params {
        address agentKey;       // the key the agent software signs UserOperations with
        uint256 dailyCap;       // cents
        uint256 maxPerTrade;    // cents
        uint256 minMarginBps;
        uint256 quoteTTL;       // seconds
        string agentURI;        // ERC-8004 registration file (https:, ipfs: or data: URI)
        address[] payees;       // suppliers the vault may pay
        address[] payers;       // buyers the vault may pull proceeds from
    }
    struct AgentInfo { address owner; address vault; address account; uint256 agentId; address signer; uint64 createdAt; }

    AgentInfo[] public agents;
    mapping(address => uint256[]) private _byOwner;

    event AgentCreated(uint256 indexed index, address indexed owner, address vault, address account, uint256 indexed agentId, address signer);
    error BadAgentKey();
    error TooMany();

    constructor(address _token, address _entryPoint, AgentIdentityRegistry _registry) {
        token = _token; entryPoint = _entryPoint; registry = _registry;
    }

    function createAgent(Params calldata p) external returns (uint256 index, address vault, address account, uint256 agentId) {
        if (p.agentKey == address(0)) revert BadAgentKey();
        if (p.payees.length > 8 || p.payers.length > 8) revert TooMany();
        AgentAccount acct = new AgentAccount(entryPoint, address(this));
        MandateVault v = new MandateVault(token, address(acct), msg.sender, p.dailyCap, p.maxPerTrade, p.minMarginBps, p.quoteTTL, p.payees, p.payers);
        acct.init(address(v), p.agentKey, msg.sender);

        AgentIdentityRegistry.MetadataEntry[] memory md = new AgentIdentityRegistry.MetadataEntry[](3);
        md[0] = AgentIdentityRegistry.MetadataEntry('vault', abi.encode(address(v)));
        md[1] = AgentIdentityRegistry.MetadataEntry('agentAccount', abi.encode(address(acct)));
        md[2] = AgentIdentityRegistry.MetadataEntry('chainId', abi.encode(block.chainid));
        agentId = registry.register(p.agentURI, md);
        registry.transferFrom(address(this), msg.sender, agentId);

        index = agents.length;
        agents.push(AgentInfo(msg.sender, address(v), address(acct), agentId, p.agentKey, uint64(block.timestamp)));
        _byOwner[msg.sender].push(index);
        emit AgentCreated(index, msg.sender, address(v), address(acct), agentId, p.agentKey);
        return (index, address(v), address(acct), agentId);
    }

    /// @dev The reference ERC-8004 registry mints with _safeMint, so the factory (which registers on the user's behalf and then hands the token over) must accept ERC-721 tokens.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC721Received.selector; }

    function agentCount() external view returns (uint256) { return agents.length; }
    function agentsOf(address owner) external view returns (uint256[] memory) { return _byOwner[owner]; }
}
