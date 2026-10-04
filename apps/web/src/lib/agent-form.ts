// Pure helpers for the "Deploy your agent" page: validate the form and build the ERC-8004 registration file.
// No React, no chain access, so they can be unit tested with node --test.
import { getAddress } from 'viem';
import { parseDollars, parseMarginPct, parseSeconds, parseAddress, type Parsed } from '../components/wallet/parse.ts';

export type AgentForm = { name: string; description: string; daily: string; perTrade: string; margin: string; ttl: string; agentAddress: string; allowSupplier: boolean; allowPayer: boolean };
export type Defaults = { supplier: string; payer: string; owner?: string };
export type CreateParams = { agentKey: `0x${string}`; dailyCap: bigint; maxPerTrade: bigint; minMarginBps: bigint; quoteTTL: bigint; agentURI: string; payees: `0x${string}`[]; payers: `0x${string}`[] };
export type FormErrors = Partial<Record<keyof AgentForm, string>>;

export const DEFAULT_FORM: AgentForm = { name: 'My SKUdesk agent', description: 'An AI agent that hunts price gaps and trades them inside an on-chain budget.', daily: '5000', perTrade: '2500', margin: '18', ttl: '180', agentAddress: '', allowSupplier: true, allowPayer: true };

/** The ERC-8004 (Draft) agent registration file. Kept small: only fields we can honestly fill. */
export function registrationFile(name: string, description: string) {
  return { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name, description, services: [] as unknown[], x402Support: false, active: true, registrations: [] as unknown[], supportedTrust: [] as string[] };
}
const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
const unb64 = (s: string) => { const bin = atob(s); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };
export const agentURI = (name: string, description: string) => 'data:application/json;base64,' + b64(JSON.stringify(registrationFile(name, description)));
export function readAgentURI(uri: string): { name?: string; description?: string; active?: boolean } | null {
  try {
    const m = /^data:application\/json;(base64|utf8),(.*)$/s.exec(uri); if (!m) return null;
    return JSON.parse(m[1] === 'base64' ? unb64(m[2]) : decodeURIComponent(m[2]));
  } catch { return null; }
}

export function validateForm(f: AgentForm, d: Defaults): { ok: true; params: CreateParams; summary: { dailyCents: number; perTradeCents: number; marginBps: number } } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const name = f.name.trim(); if (!name) errors.name = 'Give your agent a name.'; else if (name.length > 60) errors.name = 'At most 60 characters.';
  if (f.description.trim().length > 280) errors.description = 'At most 280 characters.';
  const daily = parseDollars(f.daily); if (!daily.ok) errors.daily = daily.error;
  const per = parseDollars(f.perTrade); if (!per.ok) errors.perTrade = per.error;
  if (daily.ok && per.ok && per.cents > daily.cents) errors.perTrade = 'One trade cannot be bigger than the daily budget.';
  const margin = parseMarginPct(f.margin); if (!margin.ok) errors.margin = margin.error;
  const ttl = parseSeconds(f.ttl); if (!ttl.ok) errors.ttl = ttl.error;
  const key: Parsed<{ address: `0x${string}` }> = parseAddress(f.agentAddress); if (!key.ok) errors.agentAddress = key.error;
  else if (d.owner && key.address.toLowerCase() === d.owner.toLowerCase()) errors.agentAddress = 'Use a different address for the agent. If it were your own wallet, the agent could do everything you can.';
  if (Object.keys(errors).length || !daily.ok || !per.ok || !margin.ok || !ttl.ok || !key.ok) return { ok: false, errors };
  return {
    ok: true,
    summary: { dailyCents: daily.cents, perTradeCents: per.cents, marginBps: margin.bps },
    params: { agentKey: key.address, dailyCap: BigInt(daily.cents), maxPerTrade: BigInt(per.cents), minMarginBps: BigInt(margin.bps), quoteTTL: BigInt(ttl.seconds), agentURI: agentURI(name, f.description.trim()),
      payees: f.allowSupplier ? [getAddress(d.supplier)] : [], payers: f.allowPayer ? [getAddress(d.payer)] : [] },
  };
}
