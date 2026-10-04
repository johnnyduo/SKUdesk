// Registered price sources, in display order. Phase-2 sources (Shopee/Lazada affiliate) add one line here.
import { bestbuyFeed } from './bestbuy.ts';
import { ebayFeed } from './ebay.ts';
import { searchapiFeed } from './searchapi.ts';
import { serpapiFeed } from './serpapi.ts';
import type { PriceFeed } from './types.ts';

// SearchApi.io is not a 4th source (same Google Shopping data, it would fake independence in the spread): it is SerpApi's backup.
const serpapiWithBackup: PriceFeed = { ...serpapiFeed, fallback: searchapiFeed };

export const FEEDS: PriceFeed[] = [ebayFeed, bestbuyFeed, serpapiWithBackup];
