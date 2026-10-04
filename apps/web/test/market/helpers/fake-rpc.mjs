// A tiny local JSON-RPC server that answers like the Robinhood testnet RPC from captured logs. Used by the market store test and
// by worker/scripts/smoke.mjs (so `wrangler dev` ingests real fixture events without touching the network). Plain JS on purpose.
//   const rpc = await startFakeRpc({ logs, head: 127999300 }); ... rpc.url ... rpc.calls ... rpc.setHead(n) ... rpc.setFork('b') ... await rpc.close();
//   maxLogs: like the real RPC's 10,000-log cap, an eth_getLogs that would return more than this many logs is refused; rpc.logRanges records every [from, to] asked for.
import { createServer } from 'node:http';

export const FAKE_SCHEDULE = { t0: 1790958692, epochLen: 45, commitEnd: 20, revealEnd: 35, bond: 2000000 };
const SELECTORS = { '0xc116690c': 't0', '0xd2b3996f': 'epochLen', '0x3eee4e27': 'commitEnd', '0xa6e66477': 'revealEnd', '0x64c9ec6f': 'bond' };
const hex = (n) => '0x' + Number(n).toString(16);
const word = (n) => '0x' + Number(n).toString(16).padStart(64, '0');

export async function startFakeRpc({ logs, head, schedule = FAKE_SCHEDULE, chainId = 46630, failGetLogs = 0, delayMs = 0, lagLogs = 0, maxLogs = Infinity }) {
  const calls = []; const logRanges = []; let tip = head; let fork = 'a'; let failures = failGetLogs; let lag = lagLogs; // lag: eth_getLogs behaves like a load-balanced node that many blocks behind the tip and silently clamps toBlock
  const blockHash = (n) => '0x' + (fork + n.toString(16)).padStart(64, '0');
  const timeOf = (n) => schedule.t0 + 1000 + Math.floor((n - 127690064) / 6.6);
  const block = (n) => (n > tip ? null : { number: hex(n), hash: blockHash(n), parentHash: blockHash(n - 1), timestamp: hex(timeOf(n)), transactions: [], logsBloom: '0x' + '0'.repeat(512), gasLimit: '0x1', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x1', miner: '0x' + '0'.repeat(40), extraData: '0x', nonce: '0x0000000000000000', sha3Uncles: '0x' + '0'.repeat(64), size: '0x1', stateRoot: '0x' + '0'.repeat(64), receiptsRoot: '0x' + '0'.repeat(64), transactionsRoot: '0x' + '0'.repeat(64), totalDifficulty: '0x1', uncles: [], mixHash: '0x' + '0'.repeat(64) });
  function answer(req) {
    const { id, method, params = [] } = req; calls.push(method);
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'eth_chainId': return ok(hex(chainId));
      case 'eth_blockNumber': return ok(hex(tip));
      case 'eth_getBlockByNumber': { const t = params[0]; const n = t === 'latest' || t === 'safe' || t === 'finalized' ? tip : parseInt(t, 16); return ok(block(n)); }
      case 'eth_call': { const k = SELECTORS[String(params[0]?.data ?? '').slice(0, 10)]; return k ? ok(word(schedule[k])) : { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } }; }
      case 'eth_getLogs': {
        if (failures > 0) { failures--; return { jsonrpc: '2.0', id, error: { code: -32005, message: 'rate limited' } }; }
        const f = params[0] ?? {}; const from = parseInt(f.fromBlock, 16), to = Math.min(parseInt(f.toBlock, 16), tip - lag);
        logRanges.push([parseInt(f.fromBlock, 16), parseInt(f.toBlock, 16)]);
        const want = Array.isArray(f.topics?.[0]) ? f.topics[0] : f.topics?.[0] ? [f.topics[0]] : null;
        const out = logs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= from && b <= to && (!want || want.includes(l.topics[0])); });
        if (out.length > maxLogs) return { jsonrpc: '2.0', id, error: { code: -32005, message: `query returned more than ${maxLogs} results` } };
        return ok(out);
      }
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
    }
  }
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      let out; try { const j = JSON.parse(body); out = Array.isArray(j) ? j.map(answer) : answer(j); } catch { out = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, calls, logRanges, setHead: (n) => { tip = n; }, setLag: (n) => { lag = n; }, setFork: (f) => { fork = f; }, close: () => new Promise((r) => server.close(r)) };
}
