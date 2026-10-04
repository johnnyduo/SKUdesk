// Facts under the 3D product: SKU id, category, condition and where the reference price comes from. Everything comes from catalog.json
// (via the market store); there is no condition field and no landed-cost calculation on this page, so neither is claimed.
import { useSelectedMarket, useSelectionSettled } from '../../lib/market-app';
import Sk from './Sk';
import { refSourceKind } from '../../lib/market-view';
import Provenance from '../ui/Provenance';
import { usd } from './mk-fmt';

export default function ProductFacts() {
  const m = useSelectedMarket().info; const settled = useSelectionSettled();
  if (!settled) return (   // same boxes, no SKU, category or reference of a guessed market
    <section className="mk-panel mk-facts-p o1" data-panel="assets" data-testid="product-facts" aria-label="Product facts" aria-busy="true">
      <dl className="mk-pf">
        <div><dt>SKU</dt><dd className="mono"><Sk n={16} /></dd></div>
        <div><dt>Category</dt><dd><Sk n={8} /></dd></div>
        <div><dt>Condition</dt><dd>not tracked</dd></div>
        <div><dt>Reference price</dt><dd><b className="n"><Sk n={8} /></b></dd></div>
      </dl>
      <p className="mk-pf-n"><Sk n={120} /></p>
    </section>
  );
  return (
    <section className="mk-panel mk-facts-p o1" data-panel="assets" data-testid="product-facts" aria-label={`${m.symbol} product facts`}>
      <dl className="mk-pf">
        <div><dt>SKU</dt><dd className="mono" data-testid="pf-sku">{m.id}</dd></div>
        <div><dt>Category</dt><dd data-testid="pf-category">{m.category}</dd></div>
        <div><dt>Condition</dt><dd data-testid="pf-condition">not tracked</dd></div>
        <div><dt>Reference price</dt><dd><b className="n" data-testid="pf-ref">{usd(m.referenceCents)}</b> <Provenance kind={refSourceKind(m.source)} /></dd></div>
      </dl>
      <p className="mk-pf-n" data-testid="pf-basis">Reference price: {m.priceBasis}, before shipping, tax and fees. A fixed value, not an observed retail price and not a BlindBook price.</p>
    </section>
  );
}
