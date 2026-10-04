// node --test test/market/market-loader.test.ts   (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEvents, clearPoints, decodeLogs, newLedger, summarize, type MarketEvent, type RawLog } from '../../src/lib/market-core.ts';
import { createBackfill, isLimitError, planRanges, readyFor, splitOnLimit, type Range } from '../../src/lib/market-loader.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-logs.json', import.meta.url), 'utf8')) as { logs: RawLog[] };
const EVENTS = decodeLogs(FX.logs);
const MARKETS = [...new Set(EVENTS.map((e) => e.market))];
const FROM = 127948591, TO = 127999285;
const inRange = (r: Range) => EVENTS.filter((e) => e.block >= r.from && e.block <= r.to);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('planRanges: newest first, contiguous, covers exactly [from, to]', () => {
  assert.deepEqual(planRanges(10, 34, 10), [{ from: 25, to: 34 }, { from: 15, to: 24 }, { from: 10, to: 14 }]);
  assert.deepEqual(planRanges(5, 5, 10), [{ from: 5, to: 5 }]);
  assert.deepEqual(planRanges(6, 5, 10), []);
  assert.deepEqual(planRanges(1, 10, 0), []);
  const r = planRanges(FROM, TO, 5000); let next = TO;
  for (const x of r) { assert.equal(x.to, next); assert.ok(x.from <= x.to); next = x.from - 1; }
  assert.equal(next, FROM - 1);
});

test('backfill with out-of-order completion: same ledger as one pass, contiguousFrom only moves down, ready never claims a stale last price', async () => {
  const ranges = planRanges(FROM, TO, 3000); let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const l = newLedger(); const seen: number[] = []; let readyAt = -1; let chunks = 0;
  const final = (() => { const f = newLedger(); applyEvents(f, EVENTS); return clearPoints(f); })();
  const bf = createBackfill(ranges, async (r) => { await sleep(Math.floor(rand() * 15)); return inRange(r); }, (ev, _r, p) => {
    applyEvents(l, ev); chunks++; seen.push(p.contiguousFrom);
    const now = clearPoints(l);
    if (readyAt < 0 && readyFor(now, MARKETS, p)) {
      readyAt = chunks;
      for (const m of MARKETS) assert.equal(summarize(now[m] ?? []).last, summarize(final[m] ?? []).last, `last price of ${m} is final when ready flips`);
    }
  });
  const p = await bf.run(3);
  assert.equal(p.complete, true); assert.equal(chunks, ranges.length); assert.ok(readyAt > 0);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] <= seen[i - 1], 'contiguousFrom never moves up');
  assert.deepEqual(clearPoints(l), final);
});

test('a failing range stays pending; run() rejects, the next run() loads only what is missing', async () => {
  const ranges = planRanges(FROM, TO, 10000); let fail = true; const fetched: number[] = [];
  const bf = createBackfill(ranges, async (r) => { fetched.push(r.from); if (fail && r === ranges[1]) throw new Error('429'); return inRange(r); }, () => {});
  await assert.rejects(bf.run(1), /429/);
  assert.equal(bf.progress().complete, false);
  assert.equal(bf.progress().contiguousFrom, ranges[0].from, 'the newest chunk is in; the hole below it stops the contiguous region');
  fail = false; fetched.length = 0;
  const p = await bf.run(2);
  assert.equal(p.complete, true);
  assert.ok(!fetched.includes(ranges[0].from), 'loaded ranges are not fetched twice');
});

test('readyFor: a market with no trade yet holds readiness until history is complete', () => {
  const p = { contiguousFrom: 100, done: 1, total: 3, complete: false };
  const pt = (block: number, volume: number) => ({ epoch: block, time: 0, price: 5, volume, buys: 1, sells: 1, forfeited: 0, tx: '', block });
  assert.equal(readyFor({ a: [pt(150, 2)], b: [pt(120, 1), pt(160, 0)] }, ['a', 'b'], p), true);
  assert.equal(readyFor({ a: [pt(150, 2)], b: [pt(90, 1)] }, ['a', 'b'], p), false, 'b last traded below the contiguous region');
  assert.equal(readyFor({ a: [pt(150, 2)] }, ['a', 'b'], p), false);
  assert.equal(readyFor({ a: [pt(150, 2)] }, ['a', 'b'], { ...p, complete: true }), true);
  assert.equal(readyFor({ A: [] } as any, ['A'], { ...p, complete: true }), true);
});

const ONE_PASS = (() => { const f = newLedger(); applyEvents(f, EVENTS); return clearPoints(f); })();
const mk = (prefix: string) => { const m = MARKETS.find((x) => x.startsWith(prefix)); assert.ok(m, prefix); return m as string; };
const noop = () => {};

test('a throwing onChunk never marks its range done; the next run() re-processes exactly that chunk', async () => {
  const ranges: Range[] = [{ from: 127999000, to: 127999285 }, { from: 127998500, to: 127998999 }, { from: FROM, to: 127998499 }];
  const m = mk('0x9bfaa4'); // last trade 127998944 sits in the middle chunk
  const l = newLedger(); let calls = 0; let healthy = false; const fetched: Range[] = []; const folded: Range[] = [];
  const bf = createBackfill(ranges, async (r) => { fetched.push(r); return inRange(r); }, (ev, r) => {
    calls++; if (!healthy && calls === 2) throw new Error('cache write failed');
    applyEvents(l, ev); folded.push(r);
  });
  await assert.rejects(bf.run(1), /cache write failed/);
  const p = bf.progress();
  assert.equal(p.done, 1); assert.equal(p.complete, false); assert.equal(p.contiguousFrom, ranges[0].from);
  assert.equal(readyFor(clearPoints(l), [m], p), false, 'the market whose last trade is in the failed chunk is not ready');
  healthy = true; fetched.length = 0;
  const q = await bf.run(1);
  assert.equal(q.complete, true); assert.equal(q.done, 3);
  assert.deepEqual(fetched, [ranges[1], ranges[2]], 'only the unfinished ranges are fetched again');
  assert.deepEqual(folded, ranges, 'every range folded exactly once');
  assert.deepEqual(clearPoints(l), ONE_PASS);
});

test('concurrency is sanitized: NaN, 0, negative -> 1 worker; Infinity and oversize are bounded by the work; the limit is honoured', async () => {
  const ranges = planRanges(1, 10, 1); // 10 chunks
  for (const [c, limit] of [[NaN, 1], [0, 1], [-4, 1], [Infinity, 10], [99, 10], [3, 3], [2.9, 2]] as const) {
    let cur = 0, max = 0, chunks = 0;
    const bf = createBackfill(ranges, async () => { cur++; max = Math.max(max, cur); await sleep(3); cur--; return []; }, () => { chunks++; });
    const p = await bf.run(c);
    assert.equal(p.complete, true, `complete for ${c}`); assert.equal(chunks, 10, `chunks for ${c}`);
    assert.equal(max, limit, `max in flight for ${c}`);
  }
});

test('overlapping run() calls share one pass: no double fetch, no double onChunk; a later run() works after success or failure', async () => {
  const ranges = planRanges(1, 3, 1); let fetches = 0, chunks = 0; let fail = true;
  const bf = createBackfill(ranges, async (r) => { fetches++; await sleep(5); if (fail && r === ranges[1]) throw new Error('boom'); return []; }, () => { chunks++; });
  const [a, b] = [bf.run(2), bf.run(2)];
  await assert.rejects(Promise.all([a, b]), /boom/);
  assert.equal(fetches, 3); assert.equal(chunks, 2, 'the failed range was not folded');
  fail = false; fetches = 0; chunks = 0;
  const [c, d] = await Promise.all([bf.run(2), bf.run(2)]);
  assert.equal(c.complete, true); assert.equal(d.complete, true);
  assert.equal(fetches, 1); assert.equal(chunks, 1, 'only the failed range is retried, once');
  assert.equal((await bf.run(2)).complete, true); assert.equal(fetches, 1, 'a run() after completion fetches nothing');
});

test('ready rule: a chunk arriving out of order never makes a market ready until the chunk with its newest trade is in', async () => {
  const ranges = planRanges(FROM, TO, 3000); // 17 chunks; ranges[0] holds every market's newest trade
  const ms = [mk('0x874760'), mk('0x9bfaa4')]; // both also traded in the oldest chunk, so "has any trade" holds long before they are ready
  const l = newLedger(); let release: () => void = noop; const gate = new Promise<void>((r) => { release = r; });
  const bf = createBackfill(ranges, async (r) => { if (r === ranges[0]) await gate; return inRange(r); }, (ev) => { applyEvents(l, ev); });
  const running = bf.run(2);
  for (let i = 0; i < 400 && bf.progress().done < ranges.length - 1; i++) await sleep(5);
  const p = bf.progress();
  assert.equal(p.done, ranges.length - 1); assert.equal(p.complete, false); assert.equal(p.contiguousFrom, ranges[0].to + 1);
  const now = clearPoints(l);
  for (const m of ms) assert.ok((now[m] ?? []).some((x) => x.volume > 0), 'the older chunks already hold a traded clear for the market');
  assert.equal(readyFor(now, ms, p), false, 'a stale last price must not look ready');
  release(); const done = await running;
  assert.equal(done.complete, true); assert.equal(readyFor(clearPoints(l), ms, done), true);
  assert.deepEqual(clearPoints(l), ONE_PASS);
});

test('readyFor / planRanges edges: an empty market list is not ready on a partial load; an empty plan is complete', async () => {
  const partial = { contiguousFrom: 100, done: 1, total: 3, complete: false };
  assert.equal(readyFor({}, [], partial), false);
  assert.equal(readyFor({}, [], { ...partial, complete: true }), true);
  const bf = createBackfill(planRanges(6, 5, 10), async () => { throw new Error('never'); }, noop);
  assert.deepEqual(bf.progress(), { contiguousFrom: 0, done: 0, total: 0, complete: true });
  assert.deepEqual(await bf.run(3), { contiguousFrom: 0, done: 0, total: 0, complete: true });
});

// adaptive range splitting (the RPC refuses a getLogs that matches more than 10,000 logs)

/** A fetcher that refuses any range holding more than `max` of the given blocks with the RPC's limit error; records every range asked for. */
const capped = (blocks: number[], max: number, err = (n: number) => new Error(`query returned more than ${max} results (${n})`)) => {
  const asked: Range[] = [];
  const fetch = async (r: Range) => { asked.push(r); const got = blocks.filter((b) => b >= r.from && b <= r.to); if (got.length > max) throw err(got.length); return got; };
  return { asked, fetch };
};

test('isLimitError: the result-cap refusals match, rate limiting and other failures do not', () => {
  for (const m of ['query returned more than 10000 results', 'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range', 'exceed maximum block range: 5000', 'too many logs', 'limit exceeded: 10000 logs'])
    assert.equal(isLimitError(new Error(m)), true, m);
  assert.equal(isLimitError({ message: 'RPC Request failed.', details: 'query returned more than 10000 results' }), true, 'viem puts the node message in details');
  for (const m of ['rate limited', 'Rate limit reached', 'Too Many Requests', 'HTTP request failed. Status: 429', 'injected failure', 'execution reverted', 'fetch failed'])
    assert.equal(isLimitError(new Error(m)), false, m);
  for (const x of [undefined, null, 42, {}]) assert.equal(isLimitError(x), false, String(x));
});

test('splitOnLimit: a refused range is halved until every part is accepted; the result is the whole range in order', async () => {
  const blocks = Array.from({ length: 100 }, (_, i) => 1000 + i * 3); // 100 logs in [1000, 1297]
  const c = capped(blocks, 30);
  const got = await splitOnLimit({ from: 1000, to: 1299 }, c.fetch);
  assert.deepEqual(got, blocks, 'every log exactly once, ascending');
  assert.equal(c.asked[0].from, 1000); assert.equal(c.asked[0].to, 1299);
  const accepted = c.asked.filter((r) => blocks.filter((b) => b >= r.from && b <= r.to).length <= 30);
  assert.equal(accepted.reduce((n, r) => n + r.to - r.from + 1, 0), 300, 'the accepted parts tile the range exactly');
  for (const r of c.asked) assert.ok(r.from <= r.to && r.from >= 1000 && r.to <= 1299, 'never an empty or out-of-range part');
});

test('splitOnLimit: any other error is not split (it propagates, one request)', async () => {
  let n = 0; const boom = new Error('rate limited');
  await assert.rejects(splitOnLimit({ from: 1, to: 1000 }, async () => { n++; throw boom; }), (e) => e === boom);
  assert.equal(n, 1);
});

test('splitOnLimit: recursion stops at a single block; a block that alone exceeds the cap rejects with the limit error', async () => {
  const c = capped([7, 7, 7], 2); // three logs in block 7: no split can make it fit
  await assert.rejects(splitOnLimit({ from: 5, to: 8 }, c.fetch), /more than 2 results/);
  assert.ok(c.asked.every((r) => r.from <= r.to), 'never a range below one block');
  assert.ok(c.asked.some((r) => r.from === 7 && r.to === 7), 'went down to the single block');
  assert.ok(c.asked.length <= 2 * 4 - 1, 'bounded: at most 2n-1 requests for n blocks');
  const one = capped([3, 3], 1);
  await assert.rejects(splitOnLimit({ from: 3, to: 3 }, one.fetch), /more than 1 results/);
  assert.equal(one.asked.length, 1, 'a one-block range is never split');
});
