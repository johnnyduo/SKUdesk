// Merchant configuration from vars + secrets, and a ready-to-use client. USD / US / en only in v1.
import type { AppEnv, Deps } from '../env.ts';
import { getGoogleAccessToken } from './auth.ts';
import { createMerchantClient } from './merchantClient.ts';
import type { MerchantClient } from './merchantClient.ts';

export type MerchantConfig = {
  accountId: string;
  dataSourceId: string;
  language: string;
  feedLabel: string;
  country: string;
  currency: 'USD';
  siteOrigin: string;
  apiBase: string;
};

const DIGITS = /^\d{1,20}$/;

export function merchantConfig(env: AppEnv): MerchantConfig {
  return {
    accountId: (env.MERCHANT_ACCOUNT_ID ?? '').trim(),
    dataSourceId: (env.MERCHANT_DATA_SOURCE_ID ?? '').trim(),
    language: env.MERCHANT_LANGUAGE,
    feedLabel: env.MERCHANT_FEED_LABEL,
    country: env.MERCHANT_COUNTRY,
    currency: 'USD',
    siteOrigin: env.PUBLIC_SITE_ORIGIN.replace(/\/+$/, ''),
    apiBase: env.MERCHANT_API_BASE,
  };
}

// Names (never values) of the secrets that are missing or malformed. Account/data source ids must be numeric.
export function missingMerchantSecrets(env: AppEnv, needDataSource: boolean): string[] {
  const missing: string[] = [];
  if (!env.GOOGLE_SA_JSON) missing.push('GOOGLE_SA_JSON');
  if (!DIGITS.test((env.MERCHANT_ACCOUNT_ID ?? '').trim())) missing.push('MERCHANT_ACCOUNT_ID');
  if (needDataSource && !DIGITS.test((env.MERCHANT_DATA_SOURCE_ID ?? '').trim())) missing.push('MERCHANT_DATA_SOURCE_ID');
  return missing;
}

export function dataSourceName(cfg: MerchantConfig): string {
  return 'accounts/' + cfg.accountId + '/dataSources/' + cfg.dataSourceId;
}

export function merchantClientFor(env: AppEnv, deps: Deps): MerchantClient {
  return createMerchantClient({
    base: env.MERCHANT_API_BASE,
    getToken: (forceRefresh) => getGoogleAccessToken({ saJson: env.GOOGLE_SA_JSON, kv: env.CACHE, fetch: deps.fetch, nowMs: deps.nowMs(), forceRefresh }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    random: deps.random,
    nowMs: deps.nowMs,
  });
}
