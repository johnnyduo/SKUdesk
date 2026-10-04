// The public UI shows evidence, not playback theatre: no Replay buttons or REPLAY labels anywhere in the built site, and
// the pages that had them now carry provenance and live chain proof. The contract's replay PROTECTION (error Replay,
// the "No replay" gate, attack names in run.json) is a different thing and is not matched here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const DIST = new URL('../../dist/', import.meta.url);
if (!existsSync(DIST)) throw new Error('dist/ not found: run `npm run build` in apps/web first');
const files = (dir = '') => readdirSync(new URL(dir, DIST), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(dir + e.name + '/') : /\.(html|js)$/.test(e.name) ? [dir + e.name] : []);
const read = (f) => readFileSync(new URL(f, DIST), 'utf8');
const page = (p) => read(p);
// Run facts come from run.json, so a fresh agent run does not break these tests.
const RUN = JSON.parse(readFileSync(new URL('../../src/data/run.json', import.meta.url), 'utf8'));
const NTX = RUN.events.filter((e) => e.tx).length;
const BLOCKS = RUN.events.filter((e) => e.tx).map((e) => e.tx.block);
const n = (x) => x.toLocaleString('en-US');

// [label, pattern]. This list is the single place to extend.
export const GONE = [
  ['Replay the run', /Replay the run/],
  ['Replay the gates', /Replay the gates/],
  ['Play again', /Play again/],
  // case-sensitive on purpose: the contract vocabulary 'Stale · Replay · BadQuoteHash' is not the old pill
  ['REPLAY · (pill)', /\bREPLAY\s*(?:·|\\xB7|\\u00B7|&middot;|&#183;)/],
  ['replayed from the chain', /replayed from the chain/i],
  ['Replay from the start', /Replay from the start/],
  ['cinematic replay', /cinematic replay/i],
  ['replays a run', /replays a run/i],
  ['replay re-shows', /replay re-shows/i],
  ['Replaying the build-time verdicts', /Replaying the build-time/i],
  ['REPLAY / DEV', /REPLAY \/ DEV/],
  ['it is a replay of', /it is a replay of/i],
  ['the replay below', /the replay below/i],
  ['replayed with every cheating attempt', /replayed with every/i],
  ['replays the agent run', /replays the agent run/i],
  ['The page replays what it said', /page replays what it said/i],
  ['REPLAY tag', />\s*REPLAY\s*</],
  ['What is real in this replay', /real in this replay/i],
  ['transactions, replayed here', /transactions,\s*replayed here/i],
  // the old playback control group on /app/agent (aria-label="Playback", or the same string in a bundle)
  ['Playback control group', /["'>]Playback\\?["'<]/],
  // the /market sealed-book replay (removed: Recent results lists finished epochs instead)
  ['Replay last epoch', /Replay last epoch/],
  ['REPLAY of epoch', /REPLAY of epoch/],
  ['Stop replay', /Stop replay/],
];

/** Labels of every banned string found in `text` (a file's contents). SSR puts <!-- --> between adjacent text nodes, so comments are removed first. */
export const scan = (_file, text, gone = GONE) => {
  const t = text.replace(/<!--[\s\S]*?-->/g, '');
  return gone.filter(([, re]) => re.test(t)).map(([l]) => l);
};

test('no removed replay string survives anywhere in the built site (HTML and JS)', () => {
  const hits = [];
  for (const f of files()) for (const l of scan(f, read(f))) hits.push(`${f}: ${l}`);
  assert.deepEqual(hits, []);
});

// Fixtures: the guard must catch every removed string and must leave the contract's replay-protection vocabulary alone.
// One positive sample per label: the test below fails if a label is added to GONE without one.
const SAMPLES = {
  'Replay the run': '<button>Replay the run</button>',
  'Replay the gates': '<button class="btn">Replay the gates</button>',
  'Play again': '<button>Play again</button>',
  'REPLAY · (pill)': '<span class="pill">REPLAY · 29 events</span>',
  'replayed from the chain': '<p>Every verdict is replayed from the chain.</p>',
  'Replay from the start': '<button>Replay from the start</button>',
  'cinematic replay': '<p>A cinematic replay of the run.</p>',
  'replays a run': '<p>The page replays a run.</p>',
  'replay re-shows': '<p>The replay re-shows them one by one.</p>',
  'Replaying the build-time verdicts': '<p>Replaying the build-time verdicts.</p>',
  'REPLAY / DEV': '<span>REPLAY / DEV</span>',
  'it is a replay of': '<p>This is a run: it is a replay of one agent.</p>',
  'the replay below': '<p>See the replay below.</p>',
  'replayed with every cheating attempt': '<span>The run, replayed with every cheating attempt.</span>',
  'replays the agent run': '<li>/show (replays the agent run; not live)</li>',
  'The page replays what it said': '<p>Gemini ran once. The page replays what it said.</p>',
  'REPLAY tag': '<b class="tag">REPLAY</b>',
  'What is real in this replay': '<div role="region" aria-label="What is real in this replay">',
  'transactions, replayed here': '<p>the run itself is 9 real transactions, replayed here.</p>',
  'Playback control group': '<div class="dk-bar" role="group" aria-label="Playback">',
  'Replay last epoch': '<button aria-label="Replay last epoch">',
  'REPLAY of epoch': '<span>REPLAY of epoch 12, not live</span>',
  'Stop replay': '<button>Stop replay</button>',
};

test('guard fixtures: every label has a sample and each sample is caught (HTML and JS)', () => {
  const labels = GONE.map(([l]) => l);
  assert.deepEqual([...labels].sort(), Object.keys(SAMPLES).sort(), 'GONE and SAMPLES must list the same labels');
  for (const [label, html] of Object.entries(SAMPLES)) {
    assert.ok(scan('x.html', html).includes(label), `not caught in HTML: ${label}`);
    assert.ok(scan('_astro/a.js', `e.jsx("p",{children:${JSON.stringify(html)}})`).includes(label), `not caught in JS: ${label}`);
  }
  // SSR splits text nodes with comments
  assert.ok(scan('x.html', '<button>Replay<!-- --> the run</button>').includes('Replay the run'));
  assert.ok(scan('x.html', '<button>Play<!-- --> again</button>').includes('Play again'));
});

test('guard fixtures: the contract replay-protection vocabulary is not flagged', () => {
  const ok = [
    '<span class="err">Replay</span>',
    '<li>No replay</li>',
    '<li>No replay · x</li>',
    '<p>Stale · Replay · BadQuoteHash</p>',
    '<p>Replay blocked.</p>',
    '<td>Pair the Replay error with the No replay gate</td>',
    '<p>replays and stale-dated quotes all revert</p>',
    '<p>The agent replays the same opportunity</p>',
    '<code>Stale</code>, <code>Replay</code> and <code>BadQuoteHash</code>',
    'e.jsx("td",{children:"Inputs and replay"})',
    '<p>Playback of nothing here: the word inside a sentence is fine</p>',
  ];
  for (const html of ok) assert.deepEqual(scan('x.html', html), [], html);
});

test('guard fixtures: the sealed-book replay strings are banned in every file, the market page and its Terminal bundle included', () => {
  const book = '"data-testid":"sealed-book","Replay last epoch","Stop replay","REPLAY of epoch 3, not live"';
  for (const f of ['market/index.html', '_astro/Terminal.BCTZDHp6.js', 'show/index.html', '_astro/SealedBook.js', 'market/other/index.html']) {
    assert.deepEqual(scan(f, book), ['Replay last epoch', 'REPLAY of epoch', 'Stop replay'], f);
  }
});

test('/show carries provenance, the walkthrough button, the proof summary and the verify list', () => {
  const html = page('show/index.html');
  assert.match(html, /data-testid="run-provenance"/);
  assert.match(html, />ON-CHAIN RUN</);
  assert.ok(html.includes(`Blocks ${n(Math.min(...BLOCKS))} to ${n(Math.max(...BLOCKS))}. Not live: this page walks through a finished run`));
  assert.match(html, /Walk through the run/);
  assert.match(html, /data-testid="proof-summary"/);
  assert.match(html, /Verify it yourself/);
  assert.equal(new Set([...html.matchAll(/explorer\.testnet\.chain\.robinhood\.com\/tx\/(0x[0-9a-f]{64})/g)].map((m) => m[1])).size, NTX);
});

test('/app/agent shows the complete log with the proof summary; /app/radar hydrates the sweep when idle', () => {
  const agent = page('app/agent/index.html');
  assert.ok(agent.includes(`Event ${RUN.events.length} of ${RUN.events.length}`));
  assert.match(agent, /data-testid="proof-summary"/);
  assert.doesNotMatch(agent, /dk-row future/);
  assert.match(agent, /href="\/show\/">Walk through the run</);
  const radar = page('app/radar/index.html');
  assert.match(radar, /<astro-island[^>]*component-url="\/_astro\/RadarSweep\.[^"]+"[^>]*client="idle"/);
  assert.match(radar, /All 10 verdicts shown/);
});

test('static copy states the chain check as an attempt, never as a fact (overview doc, landing, deck)', () => {
  const readme = readFileSync(new URL('../../../../docs/overview.md', import.meta.url), 'utf8');
  assert.match(readme, new RegExp(`/show\\s+walks through the on-chain agent run \\(run\\.json\\) and tries to check its ${NTX} transactions against the public RPC when you open it; the explorer links work without that`));
  assert.doesNotMatch(readme, /\/show\s+.*and checks its \d+ transactions/);
  const deck = page('deck/index.html');
  assert.match(deck, /\(walks through the agent run and tries to check it against the public RPC; not live\)/);
  assert.doesNotMatch(deck, /checks it on chain/);
  const app = page('app/index.html');
  // /app leads to /show through the 'Start here' steps; no link text there states a chain check as done
  assert.match(app, /data-testid="hub-start"/);
  assert.doesNotMatch(app, /transactions checked on chain|replayed with every/);
});

test('/show names itself like the journey step (Agent trade) and keeps its headline', () => {
  const show = page('show/index.html');
  assert.match(show, /<title>Agent trade \| SKUdesk<\/title>/);
  assert.doesNotMatch(show, /<title>Agent run/);
  assert.match(show, /Watch an AI agent trade inside limits the contract enforces\./);
});
