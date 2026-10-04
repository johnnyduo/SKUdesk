// Ingest against misbehaving nodes and chains: a lagging getLogs node, real reorgs that ORPHAN logs, a node that is behind, a dense log window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKET_TOPICS, TOPICS, clearPoints, fillRows, newLedger, type RawLog } from '../../src/lib/market-core.ts';
import { hydrate, type MarketSnapshot } from '../../src/lib/market-snap.ts';
import { CONFIRMATIONS, MAX_LOGS_PER_RUN, REWIND_BLOCKS, runMarketIngest } from '../market/ingest.ts';
import { getMeta, rowsFrom, metaUpdate } from '../market/repo.ts';
import { FAKE_SCHEDULE, startFakeRpc } from '../../test/market/helpers/fake-rpc.mjs';
import { DEPLOY, FX, HEAD, catchUp, harness, ledgerOf, snapshotOf } from './helpers/market-harness.ts';

/** Every book of the snapshot with its full order content, sorted: catches a lost order, a lost fill, a lost book. */
const booksOf = (snap: MarketSnapshot) => JSON.stringify([...snap.hot.books].sort((a, b) => a.e - b.e || (a.m < b.m ? -1 : 1)).map((b) => [b.m, b.e, b.o.map((o) => [o.i, o.t, o.h, o.s, o.p, o.u, o.f]), b.c ? [b.c.p, b.c.v, b.c.b, b.c.s, b.c.f, b.c.tx] : null]));
const expectedBooks = (logs: RawLog[]) => {
  const l = ledgerOf(logs); const hashFrom = Math.max(...[...l.books.values()].map((b) => b.epoch)) - 29; // commit hashes ship for the newest 30 epochs only
  return JSON.stringify([...l.books.values()].sort((a, b) => a.epoch - b.epoch || (a.market < b.market ? -1 : 1)).map((b) => [b.market, b.epoch, b.orders.map((o) => [o.index, o.trader, b.epoch >= hashFrom && o.hash ? o.hash : undefined, o.side, o.price, o.units, o.filled]), b.clear ? [b.clear.price, b.clear.volume, b.clear.buys, b.clear.sells, b.clear.forfeited, b.clear.tx] : null]));
};
const sameState = async (h: ReturnType<typeof harness>, logs: RawLog[]) => {
  const snap = (await snapshotOf(h))!; assert.ok(snap, 'valid snapshot');
  const l = newLedger(); hydrate(l, snap); const want = ledgerOf(logs);
  assert.deepEqual(clearPoints(l), clearPoints(want));
  assert.deepEqual(fillRows(l, FAKE_SCHEDULE), fillRows(want, FAKE_SCHEDULE));
  assert.equal(booksOf(snap), expectedBooks(logs), 'books (orders, fills, clears) differ');
};

test('a getLogs node that lags 200 blocks behind the tip leaves no permanent hole once it catches up', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD, lagLogs: 200 }); const h = harness(rpc.url);
  try {
    await catchUp(h);
    rpc.setHead(HEAD + 2000); rpc.setLag(0);
    for (let i = 0; i < 4; i++) { await runMarketIngest(h.env, h.deps); h.tick(); }
    await sameState(h, FX.logs);
  } finally { await rpc.close(); }
});

// reorgs that orphan logs

async function reorgCase(pick: (logs: RawLog[], anchor: number) => RawLog[], prepare: (logs: RawLog[], anchor: number) => void = () => {}) {
  const logs = FX.logs.map((l) => ({ ...l }));
  prepare(logs, HEAD - CONFIRMATIONS);
  const rpc = await startFakeRpc({ logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await catchUp(h);
    const anchor = (await getMeta(h.db as any))!.anchor_block!;
    assert.equal(anchor, HEAD - CONFIRMATIONS);
    const victims = pick(logs, anchor); assert.ok(victims.length > 0, 'something is orphaned');
    for (const v of victims) logs.splice(logs.indexOf(v), 1); // present on fork a, absent on fork b
    rpc.setFork('b'); rpc.setHead(HEAD + 5);
    const first = await runMarketIngest(h.env, h.deps); assert.equal(first.reorg, true);
    for (let i = 0; i < 6; i++) { h.tick(); await runMarketIngest(h.env, h.deps); }
    await sameState(h, logs);
  } finally { await rpc.close(); }
}
const blockOf = (l: RawLog) => parseInt(l.blockNumber, 16);

test('reorg with orphaned logs inside the rewind depth: they disappear from the stored books (needs the rewind delete)', async () => {
  await reorgCase((logs, anchor) => logs.filter((l) => blockOf(l) > anchor - 1500 && blockOf(l) <= anchor).slice(-4));
});

test('reorg with an orphaned log in a book that STRADDLES the rewind point: the whole book is re-read from its first block', async () => {
  const point = HEAD - CONFIRMATIONS - REWIND_BLOCKS;
  let market = '';
  await reorgCase((logs) => {
    // the fork drops the book's last log (after the rewind point); the book's commits (before the point) must be re-read too
    return logs.filter((l) => l.topics[1] === market && blockOf(l) > point).slice(-1);
  }, (logs) => {
    // make the newest book that has commits start 100 blocks before the rewind point (commits moved earlier), so it straddles the point
    const commits = logs.filter((l) => l.topics[0] === TOPICS.commit);
    const newest = commits.reduce((a, l) => (l.topics[2] > a.topics[2] ? l : a));
    market = newest.topics[1];
    const book = commits.filter((l) => l.topics[1] === newest.topics[1] && l.topics[2] === newest.topics[2]);
    book.forEach((l, i) => { l.blockNumber = '0x' + (point - 100 + i).toString(16); });
    assert.ok(logs.some((l) => l.topics[1] === market && l.topics[2] === newest.topics[2] && blockOf(l) > point), 'the book continues after the point');
  });
});

// a node that is merely behind is not a reorg

test('a node that is behind (anchor block unknown) is not a reorg: nothing is deleted, rewritten or lowered; a good node continues', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await catchUp(h);
    let tip = HEAD;
    for (let i = 0; i < 6; i++) {
      tip += 400; const lagging = i % 2 === 1;
      const before = { meta: await getMeta(h.db as any), rows: JSON.stringify(await rowsFrom(h.db as any, 0)) };
      h.sql.length = 0;
      rpc.setHead(lagging ? tip - 500 : tip);
      const s = await runMarketIngest(h.env, h.deps); h.tick();
      if (lagging) {
        assert.deepEqual([s.reason, s.reorg, s.books], ['rpc_behind', false, 0]);
        assert.deepEqual(await getMeta(h.db as any), before.meta, 'the meta row is untouched (head not lowered below the cursor)');
        assert.equal(JSON.stringify(await rowsFrom(h.db as any, 0)), before.rows);
        const writes = h.sql.filter((q) => /^\s*(DELETE|UPDATE|INSERT)/.test(q) && !/lease_until/.test(q)); // the lease itself is the only write
        assert.deepEqual(writes, []);
      } else assert.equal(s.reorg, false);
    }
    await sameState(h, FX.logs);
  } finally { await rpc.close(); }
});

test('a head below the cursor is never stored, even without an anchor', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD }); const h = harness(rpc.url);
  try {
    await catchUp(h);
    await metaUpdate(h.db as any, { anchor_block: null, anchor_hash: null }).run();
    const before = await getMeta(h.db as any);
    rpc.setHead(HEAD - 3000);
    const s = await runMarketIngest(h.env, h.deps);
    assert.equal(s.reason, 'rpc_behind');
    assert.deepEqual(await getMeta(h.db as any), before);
  } finally { await rpc.close(); }
});

// the per-run log cap

/** 1500 logs, one per block, in the first 1500 blocks after the deploy block (the fixture's events cloned with new block numbers). */
function denseLogs(n = 1500): RawLog[] {
  return Array.from({ length: n }, (_, i) => ({ ...FX.logs[i % FX.logs.length], blockNumber: '0x' + (DEPLOY + i).toString(16), logIndex: '0x' + i.toString(16) }));
}

test('a dense window (1500 logs in 2000 blocks): the run shrinks the window, stops on a chunk boundary and never exceeds the log cap', async () => {
  const logs = denseLogs();
  const rpc = await startFakeRpc({ logs, head: HEAD }); const h = harness(rpc.url);
  try {
    const s = await runMarketIngest(h.env, h.deps);
    assert.ok(s.logs > 0 && s.logs <= MAX_LOGS_PER_RUN, `${s.logs} logs`);
    assert.equal(s.code, undefined);
    const widths = rpc.logRanges.map(([a, b]) => b - a + 1);
    assert.equal(widths[0], 2000, 'the full window was tried first and refused because it holds 1500 logs');
    assert.ok(widths.slice(1).every((w) => w === 1000), 'then 1000-block windows: ' + widths.join());
    assert.equal(s.to, DEPLOY + 999, 'the cursor stops on the 1000-block chunk boundary');
    // no block is split: every log of a block at or below the cursor was read, none above it
    const inside = logs.filter((l) => blockOf(l) <= s.to && MARKET_TOPICS.includes(l.topics[0])).length;
    assert.equal(inside, s.logs);
    // the rest follows in later runs, each within the cap
    let r; let runs = 0;
    do { h.tick(); r = await runMarketIngest(h.env, h.deps); runs++; assert.ok(r.logs <= MAX_LOGS_PER_RUN); } while (r.reason !== 'caught_up' && runs < 30);
    assert.equal(r.reason, 'caught_up');
  } finally { await rpc.close(); }
});

test('a node that knows the head but not the anchor block (pruned or partial) is behind, not a reorg: nothing deleted or written', async () => {
  const rpc = await startFakeRpc({ logs: FX.logs, head: HEAD });
  let hide = '';
  const h = harness(rpc.url, {}, async (i, init) => {
    const res = await fetch(i, init); if (!hide) return res;
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }[];
    const out = (await res.json()) as { id: number; result: unknown }[];
    for (const r of out) { const c = body.find((x) => x.id === r.id)!; if (c.method === 'eth_getBlockByNumber' && c.params[0] === hide) r.result = null; }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    await catchUp(h);
    hide = '0x' + (await getMeta(h.db as any))!.anchor_block!.toString(16);
    rpc.setHead(HEAD + 100);
    const before = JSON.stringify(await getMeta(h.db as any)); const rows = JSON.stringify(await rowsFrom(h.db as any, 0));
    const s = await runMarketIngest(h.env, h.deps);
    assert.deepEqual([s.reason, s.reorg], ['rpc_behind', false]);
    assert.equal(JSON.stringify(await getMeta(h.db as any)), before); assert.equal(JSON.stringify(await rowsFrom(h.db as any, 0)), rows);
  } finally { await rpc.close(); }
});

// bursts: the re-read overlap must not eat the log cap

/** `perBlock` market logs in every block of [from, from + blocks): the fixture's events cloned with new block numbers. */
function burst(from: number, blocks: number, perBlock: number): RawLog[] {
  const src = FX.logs.filter((l) => MARKET_TOPICS.includes(l.topics[0])); const out: RawLog[] = [];
  for (let b = 0; b < blocks; b++) for (let k = 0; k < perBlock; k++) out.push({ ...src[(b * perBlock + k) % src.length], blockNumber: '0x' + (from + b).toString(16), logIndex: '0x' + k.toString(16) });
  return out;
}
async function burstCase(logs: RawLog[], head: number) {
  const rpc = await startFakeRpc({ logs, head }); const h = harness(rpc.url);
  try {
    let prev = DEPLOY - 1; let s; let runs = 0; let progress = 0;
    do {
      s = await runMarketIngest(h.env, h.deps); runs++; h.tick();
      const cursor = (await getMeta(h.db as any))!.next_block - 1;
      assert.ok(cursor >= prev, `run ${runs}: the cursor went backwards ${prev} -> ${cursor}`);
      assert.ok(s.logs <= MAX_LOGS_PER_RUN, `run ${runs}: ${s.logs} logs`);
      if (s.reason !== 'caught_up') assert.ok(cursor > prev, `run ${runs}: no progress (cursor ${cursor}, reason ${s.reason})`);
      if (cursor > prev) progress++;
      prev = cursor;
    } while (s.reason !== 'caught_up' && runs < 80);
    assert.equal(s.reason, 'caught_up', `not caught up after ${runs} runs`);
    assert.ok(progress > 3);
    await sameState(h, logs); // nothing skipped, no block split
  } finally { await rpc.close(); }
}

test('3 logs per block from the deploy block: every run advances the cursor until caught up', async () => {
  await burstCase(burst(DEPLOY, 3000, 3), DEPLOY + 4012);
});

test('6 logs per block in a burst after a quiet stretch: the cursor never goes backwards and advances every run', async () => {
  await burstCase(burst(DEPLOY + 1000, 1000, 6), DEPLOY + 4012);
});
