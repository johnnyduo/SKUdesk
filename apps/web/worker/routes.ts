// Route table. Later tasks insert their import line directly above the ROUTE-IMPORTS marker
// and their route entry directly above the ROUTE-ENTRIES marker. Keep both marker lines.
import type { Route } from './router.ts';
import { health } from './routes/health.ts';
import { merchantStatus } from './google/status.ts';
import { deleteListing, getListingStatus, publishListing } from './google/listing.ts';
import { priceCompare, priceSources } from './routes/prices.ts';
import { v4Pool } from './routes/v4pool.ts';
import { marketActive, marketPing } from './routes/market.ts';
import { marketSnapshot } from './routes/market-snapshot.ts';
// ROUTE-IMPORTS

export const ROUTES: Route[] = [
  { method: 'GET', pattern: '/api/health', handler: health },
  { method: 'GET', pattern: '/api/merchant/status', handler: merchantStatus },
  { method: 'POST', pattern: '/api/merchant/listing', handler: publishListing },
  { method: 'GET', pattern: '/api/merchant/listing/:offerId', handler: getListingStatus },
  { method: 'DELETE', pattern: '/api/merchant/listing/:offerId', handler: deleteListing },
  { method: 'GET', pattern: '/api/prices/sources', handler: priceSources },
  { method: 'GET', pattern: '/api/prices/compare', handler: priceCompare },
  { method: 'GET', pattern: '/api/v4/pool', handler: v4Pool },
  { method: 'POST', pattern: '/api/market/ping', handler: marketPing },
  { method: 'GET', pattern: '/api/market/active', handler: marketActive },
  { method: 'GET', pattern: '/api/market/snapshot', handler: marketSnapshot },
  // ROUTE-ENTRIES
];
