// ROADMAP SKETCH, NOT BUILT: scraper worker (cron) + commerce API service + policy signer.
// What exists today is the offline demo agent at apps/web/tools/run-agent.ts (Gemini + testnet transactions).
export const AGENT_DEPLOY = {
  runtime: 'cloudflare-worker + queues + D1 (or node --local)',
  schedule: '*/2 * * * * (scan) · quote refresh 30s · settle on fill',
  steps: [
    '1. worker/scraper: SerpApi/Shakee/Lazada/supplier -> normalize -> D1 market_offers',
    '2. queue matching: hard gates (GTIN/MPN/compat/pack) -> match_results',
    '3. quote: economics.landded + policy check -> opportunities (TTL 180s)',
    '4. execute: commitOpportunity -> mintLot -> fundLot -> escrow pays allowlisted payee -> settle on tokens received',
  ],
  bidAsk: 'Agent posts a bid at or below the break-even buy price ($8.51 for the hero quote: purchase plus net) to suppliers and ask ($10.99) to destinations; only IDENTITY LOCKED pairs cross the spread. The Ladder UI reads seeded fixtures; no /api/ladder exists.',
  secrets: ['SERPAPI_KEY', 'SHOPEE_*', 'LAZADA_*', 'AGENT_PRIVATE_KEY — Workers secrets / KMS only'],
};
