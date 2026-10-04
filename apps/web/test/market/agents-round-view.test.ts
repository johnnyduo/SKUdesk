// node --test test/market/agents-round-view.test.ts   (from apps/web)
// "Agents in this round" rendered on the server with the REAL keeper-bot registry: registry bots read "Bot N" with their role,
// other wallets keep their letter, and the card still says it is not proof of a bot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadNodeModule } from '../site/helpers/bundle.ts';

const { render } = await loadNodeModule<{ render(p: unknown): string }>(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import AgentsRound from './src/components/market/AgentsRound.tsx';
  export const render = (p) => renderToStaticMarkup(createElement(AgentsRound, p));
`);
const REG = JSON.parse(readFileSync(new URL('../../src/data/keeper-bots.json', import.meta.url), 'utf8'));
const BOT1 = REG.bots[0].address, OTHER = '0x' + '7'.repeat(40);
const props = (over: Record<string, unknown> = {}) => ({
  chips: [{ index: 0, trader: OTHER, state: 'sealed' }, { index: 1, trader: BOT1.toUpperCase().replace('0X', '0x'), state: 'filled', side: 0, price: 1100, units: 8, filled: 8 }],
  epoch: 812, held: false, traders: [BOT1, OTHER], bots: REG, bond: 2_000_000, clearPrice: 1099, source: null, ...over,
});

test('registry bots read "Bot N" with their scripted role; another wallet is lettered among the non-bot wallets only (first one is Agent A, not Agent B)', () => {
  const html = render(props());
  assert.match(html, /data-testid="agent-card" data-label="Bot 1" data-bot="true"/);
  assert.match(html, /<span class="ag-role">buys, limit 0\.2-0\.6% under the reference<\/span>/);
  assert.match(html, /data-testid="agent-card" data-label="Agent A" data-bot="false"/);
  assert.match(html, /title="Scripted keeper bot: address matched from public on-chain behaviour">Bot 1</);
  assert.match(html, /a card is not proof of a bot/);
  assert.doesNotMatch(html, /maker|taker|recorded|demo|simulated/i);
});

test('without the registry every wallet keeps main\'s letter label and no role is shown', () => {
  const html = render(props({ bots: undefined }));
  assert.match(html, /data-label="Agent A"/); assert.match(html, /data-label="Agent B"/);
  assert.doesNotMatch(html, /ag-role/);
});
