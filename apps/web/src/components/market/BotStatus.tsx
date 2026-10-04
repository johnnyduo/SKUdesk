// One status line under the chart controls. Always occupies the same space, so nothing moves when the data arrives.
// "Paused" is shown only when no market has cleared an epoch for a while (the newest EpochCleared event is far behind the live epoch).
import { useMarket, useClock } from '../../lib/market-app';
import { botStatus, agoText } from '../../lib/market-chart';

export default function BotStatus() {
  const s = useMarket(); const clock = useClock();
  const st = s.ready && clock ? botStatus(s.clears, clock.schedule, clock.epoch, clock.schedule.t0 + clock.epoch * clock.schedule.epochLen + clock.offset) : undefined;
  const halted = !!s.error || (s.lastBlockTime > 0 && Date.now() / 1000 - s.lastBlockTime > 75);   // chain/RPC trouble has its own banner
  let text = ''; let cls = '';
  if (!s.ready) text = 'Reading the chain...';
  else if (st && st.paused && !halted) {
    cls = ' paused';
    text = st.lastTradeEpoch >= 0
      ? `Bots paused: last trade was ${agoText(st.tradeAgeSec)} ago (epoch ${st.lastTradeEpoch}). New orders start a moment after a visitor opens this page: the bots only trade while someone is watching.`
      : `Bots paused: the last epoch settled ${agoText(st.clearAgeSec)} ago (epoch ${st.lastClearEpoch}). The bots only trade while someone is watching, so new orders start a moment after you open this page.`;
  } else if (st && !halted) {
    cls = ' live';
    text = `Bots active: epoch ${st.lastClearEpoch} settled ${agoText(st.clearAgeSec)} ago.`;
  }
  return <p className={`mk-bots${cls}`} data-testid="bot-status" data-state={cls.trim() || 'idle'}>{cls && <i aria-hidden="true" />}<span>{text}</span></p>;
}
