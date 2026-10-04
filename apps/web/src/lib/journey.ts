// The story of the product in six steps, in the order a visitor should see it. One list drives the sidebar, the top-bar "Next" button,
// the strip at the bottom of every page, and the links on /show and /market, so the order can never drift between pages.
export type JourneyStep = { n: number; href: string; label: string; blurb: string; tabs?: [href: string, label: string][]; matches: string[] };
export const JOURNEY: JourneyStep[] = [
  { n: 1, href: '/app/', label: 'Desk', blurb: 'Start here: the run, the market and your agents in one place.', matches: ['/app', '/app/opportunities', '/app/lots', '/app/transactions', '/app/radar', '/app/orders'],
    tabs: [['/app/', 'Overview'], ['/app/opportunities/', 'Opportunities'], ['/app/lots/', 'Lots'], ['/app/transactions/', 'Transactions'], ['/app/radar/', 'Radar'], ['/app/orders/', 'Orders']] },
  { n: 2, href: '/show/', label: 'Agent trade', blurb: 'An AI agent proposes a trade and the contract checks every number.', matches: ['/show'] },
  { n: 3, href: '/market/', label: 'Agent market', blurb: 'Watch bot agents bid in sealed rounds, one price per round.', matches: ['/market'] },
  { n: 4, href: '/app/create/', label: 'Deploy agent', blurb: 'Create an agent account with its own budget and identity.', matches: ['/app/create'] },
  { n: 5, href: '/app/agent/', label: 'Limits', blurb: 'What the agent may do, and the owner’s controls and kill switch.', matches: ['/app/agent', '/app/policies', '/app/owner'],
    tabs: [['/app/agent/', 'Agent'], ['/app/policies/', 'Mandate'], ['/app/owner/', 'Owner console']] },
  { n: 6, href: '/app/analytics/', label: 'Proof', blurb: 'Run metrics, the verified contracts and what we depend on.', matches: ['/app/analytics', '/app/deploy', '/app/integrations'],
    tabs: [['/app/analytics/', 'Run metrics'], ['/app/deploy/', 'Contracts'], ['/app/integrations/', 'Dependencies']] },
];
const norm = (p: string) => (p.replace(/\/$/, '') || '/');
const under = (p: string, h: string) => p === h || p.startsWith(h + '/');
/** The step a path belongs to. The longest matching prefix wins, so /app/create is step 2 and not part of the desk at /app. */
export function stepOf(path: string): JourneyStep | undefined {
  const p = norm(path); let best: JourneyStep | undefined; let len = -1;
  for (const s of JOURNEY) for (const m of s.matches) if ((m === '/app' ? p === '/app' : under(p, m)) && m.length > len) { best = s; len = m.length; }
  return best;
}
export const nextOf = (s: JourneyStep) => JOURNEY[s.n] as JourneyStep | undefined;
export const prevOf = (s: JourneyStep) => JOURNEY[s.n - 2] as JourneyStep | undefined;
