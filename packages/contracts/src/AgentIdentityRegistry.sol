// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC1271 { function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4); }
interface IERC721Receiver { function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4); }

/// @title AgentIdentityRegistry - an agent identity registry that follows the function and event names of the
/// ERC-8004 (Draft) Identity Registry. Each agent is an ERC-721 token whose tokenURI is the agent's registration file.
/// @notice Our implementation of the same interface. On Robinhood Chain Testnet the factory uses the ERC-8004 registry that is already
/// deployed there (0x8004A818BFB912233c491871b3d84c89A494BD9e); this contract is what the tests run against and what the deploy script
/// uses on a chain that has no registry. The Reputation and Validation registries of ERC-8004 are not implemented.
/// @dev `agentWallet` is a reserved metadata key: it can only change through setAgentWallet (proof that the new wallet
/// agrees, by EIP-712 signature or ERC-1271) or unsetAgentWallet, and it is cleared when the token is transferred.
contract AgentIdentityRegistry {
    struct MetadataEntry { string metadataKey; bytes metadataValue; }

    string public constant name = 'SKUdesk Agent Identity';
    string public constant symbol = 'AGENT';
    string public constant version = '1.0.0';
    uint256 public constant MAX_DEADLINE_DELAY = 5 minutes;
    bytes32 private constant AGENT_WALLET_KEY = keccak256('agentWallet');
    bytes32 public constant AGENT_WALLET_TYPEHASH = keccak256('AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)');
    bytes32 private constant DOMAIN_TYPEHASH = keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');

    uint256 public totalAgents;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operators;
    mapping(uint256 => string) private _uri;
    mapping(uint256 => mapping(bytes32 => bytes)) private _meta;
    mapping(uint256 => address) private _agentWallet;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);

    error NotAuthorized(); error NoSuchAgent(uint256 agentId); error ReservedKey(); error ZeroAddress(); error NotOwnerOfToken();
    error DeadlineExpired(uint256 deadline); error DeadlineTooFar(uint256 deadline); error BadWalletSignature(); error UnsafeRecipient();

    // ---------------- ERC-8004 identity
    function register() external returns (uint256) { return _register('', new MetadataEntry[](0)); }
    function register(string calldata agentURI) external returns (uint256) { return _register(agentURI, new MetadataEntry[](0)); }
    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256) { return _register(agentURI, metadata); }

    function _register(string memory agentURI, MetadataEntry[] memory metadata) internal returns (uint256 id) {
        id = ++totalAgents;
        // all state is written BEFORE the token is minted: minting calls the registrant's onERC721Received, and a registrant that
        // transfers the token away inside that callback must find the agent wallet already set so the transfer can clear it
        _uri[id] = agentURI;
        _agentWallet[id] = msg.sender;   // default: the registrant
        emit Registered(id, agentURI, msg.sender);
        emit MetadataSet(id, 'agentWallet', 'agentWallet', abi.encode(msg.sender));
        for (uint256 i; i < metadata.length; ++i) _setMeta(id, metadata[i].metadataKey, metadata[i].metadataValue);
        _mint(msg.sender, id);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _requireApprovedOrOwner(agentId);
        _uri[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        _requireExists(agentId);
        if (keccak256(bytes(metadataKey)) == AGENT_WALLET_KEY) return abi.encode(_agentWallet[agentId]);
        return _meta[agentId][keccak256(bytes(metadataKey))];
    }
    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        _requireApprovedOrOwner(agentId);
        _setMeta(agentId, metadataKey, metadataValue);
    }
    function _setMeta(uint256 id, string memory key, bytes memory value) internal {
        if (keccak256(bytes(key)) == AGENT_WALLET_KEY) revert ReservedKey();
        _meta[id][keccak256(bytes(key))] = value;
        emit MetadataSet(id, key, key, value);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) { _requireExists(agentId); return _agentWallet[agentId]; }

    /// @notice Point the identity at a wallet. The new wallet must agree: an EIP-712 signature (EOA) or ERC-1271 (contract, e.g. the agent's AgentAccount).
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external {
        _requireApprovedOrOwner(agentId);
        if (newWallet == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        if (deadline > block.timestamp + MAX_DEADLINE_DELAY) revert DeadlineTooFar(deadline);
        bytes32 digest = keccak256(abi.encodePacked('\x19\x01', _domainSeparator(),
            keccak256(abi.encode(AGENT_WALLET_TYPEHASH, agentId, newWallet, _owners[agentId], deadline))));
        if (!_validSig(newWallet, digest, signature)) revert BadWalletSignature();
        _agentWallet[agentId] = newWallet;
        emit MetadataSet(agentId, 'agentWallet', 'agentWallet', abi.encode(newWallet));
    }
    function unsetAgentWallet(uint256 agentId) external {
        _requireApprovedOrOwner(agentId);
        _agentWallet[agentId] = address(0);
        emit MetadataSet(agentId, 'agentWallet', 'agentWallet', abi.encode(address(0)));
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes('ERC8004IdentityRegistry')), keccak256(bytes('1')), block.chainid, address(this)));
    }
    function domainSeparator() external view returns (bytes32) { return _domainSeparator(); }

    function _validSig(address who, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (who.code.length != 0) {
            (bool ok, bytes memory ret) = who.staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, sig));
            return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
        }
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]); bytes32 s = bytes32(sig[32:64]); uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0 || (v != 27 && v != 28)) return false;
        address a = ecrecover(digest, v, r, s);
        return a != address(0) && a == who;
    }

    // ---------------- ERC-721
    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f; }
    function balanceOf(address a) external view returns (uint256) { if (a == address(0)) revert ZeroAddress(); return _balances[a]; }
    function ownerOf(uint256 id) public view returns (address o) { o = _owners[id]; if (o == address(0)) revert NoSuchAgent(id); }
    function tokenURI(uint256 id) external view returns (string memory) { _requireExists(id); return _uri[id]; }
    function getApproved(uint256 id) external view returns (address) { _requireExists(id); return _approved[id]; }
    function isApprovedForAll(address o, address op) public view returns (bool) { return _operators[o][op]; }
    function approve(address to, uint256 id) external {
        address o = ownerOf(id);
        if (msg.sender != o && !_operators[o][msg.sender]) revert NotAuthorized();
        _approved[id] = to; emit Approval(o, to, id);
    }
    function setApprovalForAll(address op, bool ok) external { _operators[msg.sender][op] = ok; emit ApprovalForAll(msg.sender, op, ok); }
    function transferFrom(address from, address to, uint256 id) public {
        _requireApprovedOrOwner(id);
        if (_owners[id] != from) revert NotOwnerOfToken();
        if (to == address(0)) revert ZeroAddress();
        delete _approved[id];
        _balances[from]--; _balances[to]++; _owners[id] = to;
        emit Transfer(from, to, id);
        if (_agentWallet[id] != address(0)) {   // the wallet link does not follow the token to a new owner
            _agentWallet[id] = address(0);
            emit MetadataSet(id, 'agentWallet', 'agentWallet', abi.encode(address(0)));
        }
    }
    function safeTransferFrom(address from, address to, uint256 id) external { safeTransferFrom(from, to, id, ''); }
    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) returns (bytes4 r) {
                if (r != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch { revert UnsafeRecipient(); }
        }
    }
    /// @dev Like the reference registry, mint with the ERC-721 receiver check (a contract registrant must be able to hold the token).
    function _mint(address to, uint256 id) internal {
        _balances[to]++; _owners[id] = to; emit Transfer(address(0), to, id);
        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, address(0), id, '') returns (bytes4 r) { if (r != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient(); }
            catch { revert UnsafeRecipient(); }
        }
    }
    function _requireExists(uint256 id) internal view { if (_owners[id] == address(0)) revert NoSuchAgent(id); }
    function _requireApprovedOrOwner(uint256 id) internal view {
        address o = ownerOf(id);
        if (msg.sender != o && _approved[id] != msg.sender && !_operators[o][msg.sender]) revert NotAuthorized();
    }
}
