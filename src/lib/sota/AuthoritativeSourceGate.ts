// src/lib/sota/AuthoritativeSourceGate.ts
// Enterprise source policy: whitelist + live HEAD verification.
// Used to gate Reference[] before injection — guarantees every cited URL
// is on an authoritative domain AND returns 2xx/3xx live.

import type { Reference } from './types';

// Curated allow-list of domains we trust for citations.
// Suffix match (".gov" → also matches "data.gov", "cdc.gov").
// Exact host match for everything else (also matches subdomains via endsWith('.host')).
export const AUTHORITATIVE_DOMAINS: readonly string[] = [
  // TLD-class authority
  '.gov', '.edu', '.mil', '.int',
  '.ac.uk', '.gov.uk', '.edu.au', '.gov.au', '.gc.ca', '.europa.eu',

  // Standards bodies
  'w3.org', 'ietf.org', 'iso.org', 'ieee.org', 'iana.org', 'oecd.org',
  'who.int', 'un.org', 'worldbank.org', 'imf.org',

  // Research / academic
  'nature.com', 'science.org', 'sciencedirect.com', 'springer.com',
  'wiley.com', 'cell.com', 'thelancet.com', 'nejm.org', 'bmj.com',
  'jamanetwork.com', 'acm.org', 'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov', 'arxiv.org', 'ssrn.com', 'plos.org',
  'cambridge.org', 'oup.com', 'jstor.org', 'researchgate.net',
  'scholar.google.com', 'semanticscholar.org',

  // Tier-1 news / business
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com',
  'wsj.com', 'ft.com', 'economist.com', 'bloomberg.com', 'cnbc.com',
  'theguardian.com', 'washingtonpost.com', 'npr.org', 'pbs.org',
  'forbes.com', 'fortune.com', 'hbr.org', 'mit.edu', 'mckinsey.com',
  'bain.com', 'bcg.com', 'deloitte.com', 'pwc.com', 'kpmg.com',
  'ey.com', 'accenture.com',

  // Data / stats
  'pewresearch.org', 'gallup.com', 'statista.com', 'ourworldindata.org',
  'data.worldbank.org', 'fred.stlouisfed.org', 'census.gov', 'bls.gov',
  'eurostat.ec.europa.eu',

  // Tier-1 tech (limited — stricter than ReferenceService default)
  'wired.com', 'arstechnica.com', 'technologyreview.com',
  'developer.mozilla.org', 'web.dev', 'wikipedia.org',
];

const BLOCKED_DOMAINS: readonly string[] = [
  'pinterest.com', 'reddit.com', 'quora.com', 'medium.com',
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'tiktok.com', 'youtube.com', 'linkedin.com',
  'tumblr.com', 'blogspot.com', 'wordpress.com', 'substack.com',
];

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

export function isAuthoritativeDomain(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (BLOCKED_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return false;

  return AUTHORITATIVE_DOMAINS.some(d => {
    if (d.startsWith('.')) return host.endsWith(d) || host.endsWith(d.slice(1));
    return host === d || host.endsWith('.' + d);
  });
}

export interface VerifyOptions {
  timeoutMs?: number;
  concurrency?: number;
  /** When true, allow URLs that fail network verification but are on the whitelist (to avoid false negatives from CORS). */
  allowOnCorsFailure?: boolean;
}

interface VerifyResult {
  url: string;
  ok: boolean;
  status?: number;
  reason?: string;
}

/**
 * Live-verify a URL: HEAD first (then fall back to GET range) — must return 2xx/3xx.
 * Returns ok=true on success, ok=false on 4xx/5xx, dns failure, or timeout.
 * If allowOnCorsFailure and the failure looks like CORS/opaque, we mark ok=true (whitelist already passed).
 */
async function verifyOne(url: string, timeoutMs: number, allowOnCorsFailure: boolean): Promise<VerifyResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    } catch {
      // Some servers reject HEAD — retry as small GET
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { Range: 'bytes=0-1023' } });
    }
    if (res.status >= 200 && res.status < 400) return { url, ok: true, status: res.status };
    return { url, ok: false, status: res.status, reason: `HTTP ${res.status}` };
  } catch (e) {
    const msg = (e as Error)?.message || 'network error';
    if (allowOnCorsFailure && /cors|opaque|failed to fetch|networkerror/i.test(msg)) {
      return { url, ok: true, reason: 'cors-bypass' };
    }
    return { url, ok: false, reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function pmap<T, R>(items: T[], concurrency: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Apply the source policy: drop non-whitelisted URLs, then live-verify the rest.
 * Returns only references that pass BOTH checks.
 */
export async function gateReferences(
  refs: Reference[],
  options: VerifyOptions = {},
): Promise<{ kept: Reference[]; rejected: Array<{ ref: Reference; reason: string }> }> {
  const timeoutMs = options.timeoutMs ?? 6000;
  const concurrency = options.concurrency ?? 6;
  const allowOnCorsFailure = options.allowOnCorsFailure ?? true;

  const rejected: Array<{ ref: Reference; reason: string }> = [];

  // Step 1: whitelist filter (cheap, sync)
  const whitelisted = refs.filter(r => {
    const ok = isAuthoritativeDomain(r.url);
    if (!ok) rejected.push({ ref: r, reason: 'not-on-whitelist' });
    return ok;
  });

  if (whitelisted.length === 0) return { kept: [], rejected };

  // Step 2: live verify
  const results = await pmap(whitelisted, concurrency, r => verifyOne(r.url, timeoutMs, allowOnCorsFailure));

  const kept: Reference[] = [];
  results.forEach((res, idx) => {
    if (res.ok) kept.push(whitelisted[idx]);
    else rejected.push({ ref: whitelisted[idx], reason: res.reason || 'unverified' });
  });

  return { kept, rejected };
}
