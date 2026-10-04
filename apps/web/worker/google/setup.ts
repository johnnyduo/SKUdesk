// One-time Merchant setup requests (developer registration + primary API data source). Pure builders.
// registerGcp: https://developers.google.com/merchant/api/guides/quickstart/registration
// dataSources: https://developers.google.com/merchant/api/reference/rest/datasources_v1/accounts.dataSources
import type { MerchantRequest } from './merchantClient.ts';

export const DATA_SOURCE_DISPLAY_NAME = 'Robinize API';
export type DataSourceTarget = { language: string; feedLabel: string; countries: string[] };
export type FoundDataSource = { name: string; dataSourceId: string };

export function registerGcpRequest(accountId: string, developerEmail: string): MerchantRequest {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(developerEmail)) throw new Error('developerEmail must be an email address');
  if (/gserviceaccount\.com$/i.test(developerEmail)) throw new Error('developerEmail must be a human Google account, not a service account');
  return { method: 'POST', path: '/accounts/v1/accounts/' + accountId + '/developerRegistration:registerGcp', body: { developerEmail } };
}

export function getRegistrationRequest(accountId: string): MerchantRequest {
  return { method: 'GET', path: '/accounts/v1/accounts/' + accountId + '/developerRegistration' };
}

export function listDataSourcesRequest(accountId: string, pageToken?: string): MerchantRequest {
  const query: Record<string, string> = { pageSize: '1000' };
  if (pageToken) query.pageToken = pageToken;
  return { method: 'GET', path: '/datasources/v1/accounts/' + accountId + '/dataSources', query };
}

export function createDataSourceRequest(accountId: string, t: DataSourceTarget): MerchantRequest {
  return {
    method: 'POST',
    path: '/datasources/v1/accounts/' + accountId + '/dataSources',
    body: { displayName: DATA_SOURCE_DISPLAY_NAME, primaryProductDataSource: { contentLanguage: t.language, feedLabel: t.feedLabel, countries: t.countries } },
  };
}

export function dataSourceIdOf(ds: { name?: unknown; dataSourceId?: unknown }): string | null {
  if (typeof ds.dataSourceId === 'string' && /^\d+$/.test(ds.dataSourceId)) return ds.dataSourceId;
  const m = typeof ds.name === 'string' ? /\/dataSources\/(\d+)$/.exec(ds.name) : null;
  return m ? m[1] : null;
}

// An API-input primary product source for exactly this language + feed label.
export function findPrimaryApiDataSource(list: unknown, t: DataSourceTarget): FoundDataSource | null {
  const items = (list as { dataSources?: unknown } | null)?.dataSources;
  if (!Array.isArray(items)) return null;
  for (const raw of items as Record<string, unknown>[]) {
    const pp = raw.primaryProductDataSource as Record<string, unknown> | undefined;
    if (!pp || pp.contentLanguage !== t.language || pp.feedLabel !== t.feedLabel) continue;
    const isApi = raw.input === 'API' || (raw.input === undefined && raw.displayName === DATA_SOURCE_DISPLAY_NAME);
    const id = dataSourceIdOf(raw);
    if (isApi && id && typeof raw.name === 'string') return { name: raw.name, dataSourceId: id };
  }
  return null;
}
