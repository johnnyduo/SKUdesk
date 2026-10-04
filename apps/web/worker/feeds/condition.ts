// Shared conservative title check for used / refurbished listings when the vendor has no condition field (or it is absent).
// Word-bounded, documented spellings only. A false positive only excludes an offer from the lock (the safe direction);
// a false negative would show a used price as NEW.
import type { FeedOffer } from './types.ts';

const TITLE_CONDITION = /\b(used|refurb(?:ished)?|pre-?owned|renewed|open[- ]box)\b/i;

export function titleCondition(title: string): Exclude<FeedOffer['condition'], 'UNKNOWN' | 'NEW'> | null {
  const word = TITLE_CONDITION.exec(title)?.[1]?.toLowerCase();
  if (!word) return null;
  return word.startsWith('refurb') || word === 'renewed' ? 'REFURB' : 'USED';
}
