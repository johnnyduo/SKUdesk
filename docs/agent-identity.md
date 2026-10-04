# Agent identity (ERC-8004) on Robinhood Chain Testnet

The agent is registered in the ERC-8004 Identity Registry that is deployed on Robinhood Chain Testnet (chain id 46630).

| Item | Value |
|---|---|
| Registry (ERC-1967 proxy, name `AgentIdentity`, symbol `AGENT`, version 2.0.0) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Implementation behind the proxy | `0x7274e874CA62410a93Bd8bf61c69d8045E399c02` (source not verified on the explorer) |
| Agent id (ERC-721 token id) | **119** |
| Owner / agent wallet | `0x3EC91B7dfF57403aE298e503FAe4f5815B4C1818` (the same address the SKUdeskCore vault authorizes as agent) |
| Registration transaction | `0xc1ea4528252142cb7dd06fcb37c8cdfc1fd3551cb6fac720b5dfe1eba996118d` (block 128175533) |
| `setAgentURI` transaction (adds `registrations`) | `0xd2bf6b77d7ea24b3f47d5ade132262a9ce6c181f06a793d71a82c7fca1cfd683` |
| `setAgentURI` transaction (card updated to the new vault and the mUSDG token name, 2026-10-03) | `0x0b6c2161d0a804246cca6126320464b39cd3dcb8e259e5886227d337a78e82eb` (block 128252826) |
| Vault the agent card points to | `0x3799747B933Ed7FEfAd6097998749Fd95fCD8c2A` (SKUdeskCore; the agent address is its authorized agent — checked on chain) |

The token URI is a `data:application/json;base64,…` URI, so the agent card lives in the transaction data and needs no hosting. Decode it with:

```bash
cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e "tokenURI(uint256)(string)" 119 \
  --rpc-url https://rpc.testnet.chain.robinhood.com | tr -d '"' | sed 's#^data:application/json;base64,##' | base64 -d | python3 -m json.tool
```

## What the card says (and does not say)

Name `SKUdesk agent`; service `web` → the site; `x402Support: false`; `supportedTrust: []` (no trust claims such as reputation or validation are made); the vault address; and the `registrations` entry linking id 119 to this registry. The description states: testnet only, settlement token is mUSDG (a test token with no value), contracts source-verified but not audited.

## Notes

- The registry is a shared public contract run by someone else (its `owner()` is `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`); it is upgradeable behind an ERC-1967 proxy, and its implementation source is not verified, so this identity is only as durable as that registry.
- Updating the card later is one `setAgentURI(119, <new uri>)` transaction from the agent wallet.
- The reputation and validation registries of ERC-8004 were not checked or used.
- The registration was done on 2026-10-03 with the agent key from the git-ignored `.env` (the key was never printed or committed).
