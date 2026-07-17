import { APP_CONFIG } from './config.js';
import { request } from './api.js';

const timeoutMs = 8000;

function result(source, success, data = null, error = null){
  return { source, success, data, error, cached: false };
}

async function readJson(source, url, options = {}){
  const response = await request(url, { timeoutMs, ...options });
  if(!response.data) return result(source, false, null, response.error);
  if(!response.data.ok) return result(source, false, null, `HTTP ${response.data.status}`);
  try { return result(source, true, await response.data.json()); }
  catch { return result(source, false, null, 'Invalid JSON response'); }
}

async function lookupOtx(ip, key, proxyPrefix = '', signal){
  if(!key) return result('AlienVault OTX', false, null, 'Skipped: no API key');
  const raw = await readJson('AlienVault OTX', `https://otx.alienvault.com/api/v1/indicators/IPv4/${encodeURIComponent(ip)}/general`, { headers: { 'X-OTX-API-KEY': key }, proxyPrefix, signal });
  if(!raw.success) return raw;
  const pulses = (raw.data && raw.data.pulse_info && raw.data.pulse_info.pulses) || [];
  const count = (raw.data && raw.data.pulse_info && raw.data.pulse_info.count) || pulses.length;
  return result('AlienVault OTX', true, { pulseCount: count, pulses: pulses.slice(0, 5).map(p => p.name || p.id) });
}

async function lookupThreatFox(ip, key, proxyPrefix = '', signal){
  if(!key) return result('ThreatFox', false, null, 'Skipped: no API key');
  const raw = await readJson('ThreatFox', 'https://threatfox-api.abuse.ch/api/v1/', {
    method: 'POST', headers: { 'Auth-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'search_ioc', search_term: ip, exact_match: true }),
    proxyPrefix,
    signal
  });
  if(!raw.success) return raw;
  // Guard against null/non-array data payload
  const entries = (raw.data && Array.isArray(raw.data.data)) ? raw.data.data : [];
  return result('ThreatFox', true, { matchCount: entries.length, matches: entries.slice(0, 5).map(x => ({ malware: x.malware_printable || '', type: x.threat_type_desc || x.threat_type || '', firstSeen: x.first_seen_utc || '' })) });
}

async function lookupBgp(ip, proxyPrefix = '', signal){
  const raw = await readJson('BGPView', `https://api.bgpview.io/ip/${encodeURIComponent(ip)}`, { proxyPrefix, signal });
  if(!raw.success) return raw;
  // Guard against null data payload
  const data = (raw.data && raw.data.data) || {};
  const prefixes = data.prefixes || [];
  const prefix = prefixes[0] || {};
  return result('BGPView', true, { asn: data.asn || (prefix.asn && prefix.asn.asn) || '', name: data.name || (prefix.asn && prefix.asn.name) || '', prefix: prefix.prefix || '', rir: (prefix.rir_allocation && prefix.rir_allocation.rir) || '' });
}

async function lookupRdap(ip, proxyPrefix = '', signal){
  const raw = await readJson('RDAP', `https://rdap.org/ip/${encodeURIComponent(ip)}`, { headers: { Accept: 'application/rdap+json, application/json' }, proxyPrefix, signal });
  if(!raw.success) return raw;
  const data = raw.data || {};
  return result('RDAP', true, { handle: data.handle || '', name: data.name || '', type: data.type || '', startAddress: data.startAddress || '', endAddress: data.endAddress || '', country: data.country || '', parentHandle: data.parentHandle || '' });
}

export async function lookupTierOne(ip, { otxKey = '', threatFoxKey = '', proxyPrefix = '', signal } = {}){
  const providers = [
    lookupOtx(ip, otxKey, proxyPrefix, signal),
    lookupThreatFox(ip, threatFoxKey, proxyPrefix, signal),
    lookupBgp(ip, proxyPrefix, signal),
    lookupRdap(ip, proxyPrefix, signal)
  ];
  return Promise.all(providers);
}
