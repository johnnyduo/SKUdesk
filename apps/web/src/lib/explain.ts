// Plain-language sentences for every revert the Robinize contracts can produce. Pure: no imports, safe to unit test.
const usd = (c: any) => { const v = Number(c) / 100; return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2); };
const base = (b: any) => '$' + (Number(b) / 1e6).toFixed(2);
const label = (hex: any) => { const h = String(hex).replace(/^0x/, ''); const out = (h.match(/../g) ?? []).map((b) => parseInt(b, 16)).filter((c) => c > 31 && c < 127).map((c) => String.fromCharCode(c)).join(''); return out || String(hex); };

export function explain(name: string, a: any[] = []): string {
  switch (name) {
    case 'MathMismatch': return `The agent claimed a net of ${usd(a[0])} but the contract derived ${usd(a[1])} from the quote. Rejected.`;
    case 'SpendCap': return `Spend ${usd(a[0])} exceeds the per-trade cap of ${usd(a[1])}. Rejected.`;
    case 'DailyCap': return `Today’s commitments would reach ${usd(a[0])}, above the daily cap of ${usd(a[1])}. Rejected.`;
    case 'Stale': return `The quote is ${a[0]}s old; the policy allows ${a[1]}s. Rejected.`;
    case 'Replay': return 'This exact opportunity was already committed. Replay blocked.';
    case 'BadQuoteHash': return 'The quote hash does not match the quote that was submitted. Rejected.';
    case 'MarginTooLow': return `Margin ${(Number(a[0]) / 100).toFixed(2)}% is below the policy floor of ${(Number(a[1]) / 100).toFixed(2)}%. Rejected.`;
    case 'NonPositiveNet': return 'Net profit is not positive. Rejected.';
    case 'BadUnits': return `${a[0]} units is outside the allowed range. Rejected.`;
    case 'FutureObservation': return 'The observation timestamp is in the future. Rejected.';
    case 'OutOfBounds': return `${label(a[0])} = ${a[1]} is outside the allowed bounds. Rejected.`;
    case 'Paused': return 'The owner has paused the vault. Every agent action is refused until it is resumed.';
    case 'Unauthorized': return 'Only the owner wallet can do this (or only the agent wallet, for agent actions).';
    case 'InsufficientFree': return `Only ${base(a[0])} is free in the vault, but ${base(a[1])} is needed. Money locked in escrow cannot be moved.`;
    case 'PayeeNotAllowed': return `${a[0]} is not on the owner's payee allowlist, so escrow cannot be released there.`;
    case 'PayerNotAllowed': return `${a[0]} is not an approved payer.`;
    case 'ExceedsEscrow': return `Payout ${base(a[0])} is more than the ${base(a[1])} left in escrow.`;
    case 'UnknownOpportunity': return 'No committed opportunity has that id.';
    case 'OpportunityConsumed': return 'That opportunity has already been turned into a lot.';
    case 'BadTransition': return 'That step is not allowed from the lot’s current state.';
    case 'TransferFailed': return 'The token transfer failed (not enough balance or allowance).';
    case 'Reentrancy': return 'Blocked a re-entrant call.';
    case 'NotOwner': return 'Only the token owner can mint.';
    case 'Insufficient': return 'Not enough token balance.';
    case 'Allowance': return 'The vault is not approved to take that many tokens yet.';
    case 'BadAgentKey': return 'The agent key address is empty. Generate a key or paste an address.';
    case 'TooMany': return 'At most 8 suppliers and 8 payers can be allowed when the agent is created. Add more later in the owner console.';
    case 'BadMargin': return `A margin floor of ${(Number(a[0]) / 100).toFixed(2)}% is outside the allowed 1% to 90%.`;
    case 'BadOwner': return 'The owner address is empty.';
    case 'TooSoon': return `You already took test money. Come back after ${new Date(Number(a[0]) * 1000).toLocaleString()}.`;
    case 'Empty': return 'The test-money faucet is empty.';
    case 'TargetNotAllowed': return `The agent account may only call its own vault, not ${a[0]}.`;
    case 'ValueNotAllowed': return 'The agent account may not send ETH.';
    case 'SelectorNotAllowed': return `The agent account may not call ${a[0]}: that is an owner-only action.`;
    case 'GasTooHigh': return 'The agent account refuses operations that ask for more gas than its caps allow.';
    case 'TipNotAllowed': return 'The agent account refuses operations that pay the bundler a tip.';
    default: return `${name}(${a.map(String).join(', ')})`;
  }
}
