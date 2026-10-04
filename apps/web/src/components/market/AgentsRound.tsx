// "Agents in this round": one card per wallet that committed an order in the epoch the sealed book is showing.
// The cards are built from the same chips as the book (so reveal pacing applies), and show price, side and size only once revealed.
// Names come from market-view's walletLabel: registry keeper bots are "Bot N" with their scripted role, every other wallet gets a letter, counted among the non-bot wallets.
import Provenance from '../ui/Provenance';
import { agentCards, dataSource, shortAddr, type CardChip, type DataSource } from '../../lib/market-view';
import type { AgentRegistry } from '../../lib/agents';
import { usd } from './mk-fmt';

type Props = { chips: CardChip[]; epoch: number; held: boolean; traders: string[]; bots?: AgentRegistry; bond: number; clearPrice?: number; source: DataSource | null };

export default function AgentsRound({ chips, epoch, held, traders, bots, bond, clearPrice, source }: Props) {
  const cards = agentCards(chips, traders, bond, bots);
  if (!cards.length) return null;
  return (
    <section className="ag" data-testid="agents-round" aria-label={`Agents in epoch ${epoch}`}>
      <div className="ag-h">
        <h4>Agents in this round</h4>
        <span className="ag-ep mono">epoch {epoch}{held ? ' (last with orders)' : ''}</span>
        {source ? <Provenance kind={source.kind} note={source.note} /> : null}
      </div>
      <ul className="ag-list">
        {cards.map((c) => (
          <li key={c.trader} className="ag-card" data-testid="agent-card" data-label={c.label} data-bot={c.bot ? 'true' : 'false'}>
            <div className="ag-id"><b title={c.bot ? 'Scripted keeper bot: address matched from public on-chain behaviour' : undefined}>{c.label}</b><span className="mono" title={c.trader}>{shortAddr(c.trader)}</span></div>
            {c.role && <span className="ag-role">{c.role}</span>}
            {c.orders.map((o) => (
              <div key={o.index} className="ag-o" data-word={o.word}>
                <span className="ag-w">{o.word}</span>
                {o.price !== undefined && o.side !== undefined
                  ? <span className="mono"><span className={o.side === 0 ? 'buy' : 'sell'}>{o.side === 0 ? 'BUY' : 'SELL'}</span> {o.units} @ {usd(o.price)} limit{o.word === 'matched' && clearPrice !== undefined ? `, filled ${o.filled}${o.filled !== o.units ? ` of ${o.units}` : ''} @ ${usd(clearPrice)}` : ''}</span>
                  : <span className="ag-hid">{o.state === 'forfeited' ? 'never revealed' : 'side, price, size hidden'}</span>}
                <small>{o.bond}</small>
              </div>
            ))}
          </li>
        ))}
      </ul>
      <p className="ag-n">Orders by wallet. Bot 1 to Bot 6 are the keeper script's six wallets (scripted, no language model), named by matching their public addresses and on-chain behaviour to that script. A role is the script's pricing rule against its own reference price; every fill trades at the one clearing price. Other wallets get a letter (A, B, ...). Any wallet with deposited mUSDG can also commit, so a card is not proof of a bot.</p>
    </section>
  );
}
