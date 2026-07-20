
import { APP_CONFIG, STORAGE_KEYS } from './config.js';
import { request } from './api.js';
import { getStored, setStored, removeStored } from './cache.js';
import { isPrivateOrReserved } from './parser.js';
import { lookupTierOne } from './intelligence.js';
import { readJson, writeJson, saveListItem } from './workflow.js';

/* =========================================================================
   1. STATE
   ========================================================================= */
const state = {
  ipList: [],              // unique parsed list queued for processing
  results: new Map(),      // ip -> result object
  order: [],                // display order of ips
  processing: false,
  paused: false,
  stopped: false,
  processedCount: 0,
  startTime: null,
  vtRequestTimestamps: [],  // for token-bucket rate limiting
  vtUsageToday: 0,
  vtDailyLimit: 500,
  vtApiConnected: null,    // null=unknown, true/false
  abApiConnected: null,
  currentFilter: 'all',
  searchTerm: '',
  sortKey: null,
  sortDir: 1,
  secondarySort: '',
  customFilter: 'all',
  hiddenColumns: new Set(),

  renderQueued: false,
  chartsQueued: false,
  vtCooldownUntil: 0,
  abortController: null,
  vizVersion: 0,
};

const LS_KEYS = STORAGE_KEYS;

function removeLegacyPersistentApiKeys(){
  // Previous releases used localStorage. Do not migrate those credentials:
  // deleting them prevents a persistent API-key copy from remaining behind.
  try{
    localStorage.removeItem(LS_KEYS.vtKey);
    localStorage.removeItem(LS_KEYS.abKey);
  }catch(e){ /* storage may be disabled */ }
}

/* =========================================================================
   2. UTILITIES
   ========================================================================= */
function $(id){ return document.getElementById(id); }
function el(tag, cls, text){ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function todayKey(){ return new Date().toISOString().slice(0,10); }
function nowIso(){ return new Date().toISOString(); }

/* Wrap a target URL with the user's configured CORS proxy prefix, if any. */
function proxied(url){
  const prefix = ($('corsProxy') && $('corsProxy').value.trim()) || '';
  if(!prefix) return url;
  return prefix + encodeURIComponent(url);
}
/* Turn a raw fetch/network failure into a human-readable reason. */
function describeFetchError(e){
  if(e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(e.message||'')){
    return $('corsProxy').value.trim()
      ? 'Blocked — the configured CORS proxy rejected or could not reach the request.'
      : 'Blocked by browser (CORS) — this API does not allow direct browser requests. Set a CORS proxy in Settings.';
  }
  return e.message || 'Unknown error';
}

function log(msg, cls){
  const c = $('logConsole');
  const line = el('div', cls || '');
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  c.appendChild(line);
  c.scrollTop = c.scrollHeight;
  while(c.children.length > 300) c.removeChild(c.firstChild);
}

function setNetStatus(text, live){
  $('netStatusText').textContent = text;
  $('pulseDot').classList.toggle('live', !!live);
}

let countryDisplayNames = null;
function countryCodeToName(code){
  if(!code) return '';
  const c = String(code).trim().toUpperCase();
  if(c.length !== 2) return code;
  try{
    if(!countryDisplayNames) countryDisplayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return countryDisplayNames.of(c) || c;
  }catch(e){ return c; }
}

function parseCountryFromWhois(whois){
  if(!whois) return '';
  const patterns = [
    /(?:^|\n)\s*Country:\s*([A-Z]{2})\b/im,
    /(?:^|\n)\s*country:\s*([A-Z]{2})\b/im,
    /(?:^|\n)\s*CountryCode:\s*([A-Z]{2})\b/im,
  ];
  for(const re of patterns){
    const m = whois.match(re);
    if(m) return m[1].toUpperCase();
  }
  return '';
}

function asIsoCountryCode(value){
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function resolveCountryFields({ vt, ab, geo }){
  const vtCode = asIsoCountryCode(vt && !vt.error && vt.country);
  const abCode = asIsoCountryCode(ab && !ab.error && ab.countryCode);
  const geoCode = asIsoCountryCode(geo && geo.countryCode);
  const whoisCode = (vt && !vt.error && vt.whois) ? parseCountryFromWhois(vt.whois) : '';
  const countryCode = vtCode || abCode || geoCode || whoisCode || '';
  const countryName = countryCode
    ? countryCodeToName(countryCode)
    : ((geo && geo.country) || (vt && !vt.error && vt.country) || '');
  let countryDisplay = '';
  if(countryCode && countryName && countryName !== countryCode){
    countryDisplay = `${countryCode} — ${countryName}`;
  } else if(countryName){
    countryDisplay = countryName;
  } else if(countryCode){
    countryDisplay = countryCode;
  } else {
    countryDisplay = 'Unknown';
  }
  return { countryCode, countryName, countryDisplay };
}

function enrichCachedCountry(cached){
  if(!cached) return cached;
  const needsCountry = !cached.country || cached.country === '—' || cached.country === 'Unknown';
  if(needsCountry){
    const cf = resolveCountryFields({
      vt: cached.vtFull,
      ab: cached.abFull,
      geo: { country: cached.countryName || '', countryCode: cached.countryCode || '' }
    });
    if(cf.countryDisplay !== 'Unknown'){
      cached.country = cf.countryDisplay;
      cached.countryCode = cf.countryCode;
      cached.countryName = cf.countryName;
    }
  }

  // Migrate results saved by older versions, which called missing data
  // "Safe" and assigned it a score of zero.
  if(cached.riskLabel === 'Safe' || cached.riskLabel === 'Clean' || cached.vtVerdict === 'Clean'){
    const hasVT = cached.vtFull && !cached.vtFull.error;
    const hasAB = cached.abFull && !cached.abFull.error;
    const scoring = computeScore({ vt: hasVT ? cached.vtFull : null, ab: hasAB ? cached.abFull : null });
    const risk = riskLevel(scoring.score, hasVT ? cached.vtFull : null);
    cached.score = scoring.score;
    cached.riskLabel = risk.label;
    cached.riskCls = risk.cls;
    if(cached.vtVerdict === 'Clean') cached.vtVerdict = formatVTVerdict(cached.vtFull);
    if(!hasVT && !hasAB) cached.sources = 'None';
  }
  return cached;
}

function countryIsMissing(result){
  return !result || !result.country || result.country === '—' || result.country === 'Unknown';
}

function vtDailyLimit(){
  return state.vtDailyLimit;
}
function vtQuotaRemaining(){
  return Math.max(0, vtDailyLimit() - state.vtUsageToday);
}
function vtRateRemainingThisMin(){
  const limit = vtRateLimitPerMin();
  const now = Date.now();
  const recent = state.vtRequestTimestamps.filter(t => now - t < 60000);
  return Math.max(0, limit - recent.length);
}

function updateApiStatusBar(){
  const useVT = $('useVTSwitch').classList.contains('on');
  const useAB = $('useABSwitch').classList.contains('on');
  const vtKey = $('vtKey').value.trim();
  const abKey = $('abKey').value.trim();
  const otxKey = $('otxKey').value.trim();
  const threatFoxKey = $('threatFoxKey').value.trim();

  const vtPill = $('vtApiPill');
  if(!useVT){
    vtPill.textContent = 'VT: disabled';
    vtPill.className = 'api-pill';
  } else if(!vtKey){
    vtPill.textContent = 'VT: no key';
    vtPill.className = 'api-pill disconnected';
  } else if(state.vtApiConnected === true){
    vtPill.textContent = 'VT: connected';
    vtPill.className = 'api-pill connected';
  } else if(state.vtApiConnected === false){
    vtPill.textContent = 'VT: disconnected';
    vtPill.className = 'api-pill disconnected';
  } else {
    vtPill.textContent = 'VT: checking…';
    vtPill.className = 'api-pill';
  }

  const remaining = vtQuotaRemaining();
  const limit = vtDailyLimit();
  $('vtQuotaPill').textContent = useVT && vtKey
    ? `VT quota: ${remaining}/${limit} left today · ${vtRateRemainingThisMin()}/${vtRateLimitPerMin()}/min`
    : 'VT quota: —';

  const abPill = $('abApiPill');
  if(!useAB){
    abPill.textContent = 'AbuseIPDB: disabled';
    abPill.className = 'api-pill';
  } else if(!abKey){
    abPill.textContent = 'AbuseIPDB: no key';
    abPill.className = 'api-pill disconnected';
  } else if(state.abApiConnected === true){
    abPill.textContent = 'AbuseIPDB: connected';
    abPill.className = 'api-pill connected';
  } else if(state.abApiConnected === false){
    abPill.textContent = 'AbuseIPDB: disconnected';
    abPill.className = 'api-pill disconnected';
  } else {
    abPill.textContent = 'AbuseIPDB: checking…';
    abPill.className = 'api-pill';
  }
}

async function testApiConnections(){
  const vtKey = $('vtKey').value.trim();
  const abKey = $('abKey').value.trim();
  const useVT = $('useVTSwitch').classList.contains('on');
  const useAB = $('useABSwitch').classList.contains('on');

  if(useVT && vtKey){
    try{
      const res = await apiFetch(proxied('https://www.virustotal.com/api/v3/ip_addresses/8.8.8.8'), { headers:{'x-apikey':vtKey} });
      state.vtApiConnected = res.ok || res.status === 404;
      if(res.status === 401 || res.status === 403) state.vtApiConnected = false;
    }catch(e){ state.vtApiConnected = false; }
  } else { state.vtApiConnected = null; }

  if(useAB && abKey){
    try{
      const res = await apiFetch(proxied('https://api.abuseipdb.com/api/v2/check?ipAddress=8.8.8.8'), { headers:{'Key':abKey,'Accept':'application/json'} });
      state.abApiConnected = res.ok;
      if(res.status === 401 || res.status === 403) state.abApiConnected = false;
    }catch(e){ state.abApiConnected = false; }
  } else { state.abApiConnected = null; }

  updateApiStatusBar();
}

function setRowStatus(ip, status, statusDetail){
  const existing = state.results.get(ip) || { ip };
  existing.status = status;
  if(statusDetail != null) existing.statusDetail = statusDetail;
  state.results.set(ip, existing);
  scheduleTableRender();
}

function scheduleTableRender(){
  if(state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(()=>{
    state.renderQueued = false;
    renderTable();
  });
}

/* localStorage helpers with quota safety */
function lsGet(key, fallback){ return getStored(key, fallback); }
function lsSet(key, val){
  if(setStored(key, val)) return true;
  log('Local storage is full. Evicting oldest cached results to free space.', 'l-warn');
  evictOldCache();
  return setStored(key, val);
}

// The only network entry point used by this application. The API module
// provides timeout handling and a uniform response shape for every provider.
async function apiFetch(url, options = {}){
  const result = await request(url, {
    headers: options.headers || {},
    timeoutMs: APP_CONFIG.requestTimeoutMs,
  });
  if(!result.data) throw new Error(result.error);
  return result.data;
}
function evictOldCache(){
  const entries = [];
  for(let i=0;i<localStorage.length;i++){
    const k = localStorage.key(i);
    if(k && k.startsWith(LS_KEYS.cachePrefix)){
      try{ const o = JSON.parse(localStorage.getItem(k)); entries.push([k, o.ts||0]); }catch(e){ entries.push([k,0]); }
    }
  }
  entries.sort((a,b)=>a[1]-b[1]);
  const toRemove = entries.slice(0, Math.ceil(entries.length*0.3));
  toRemove.forEach(([k])=>localStorage.removeItem(k));
}

/* =========================================================================
   3. IP / DOMAIN PARSING, CIDR & RANGE EXPANSION
   ========================================================================= */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIPv4(ip){
  const m = ip.match(IPV4_RE);
  if(!m) return false;
  return m.slice(1).every(o => Number(o) >= 0 && Number(o) <= 255);
}
function isValidIPv6(ip){
  const s = String(ip).trim();
  if(!s) return false;
  if(s === '::') return true;
  if(s.indexOf('::') !== s.lastIndexOf('::')) return false;
  if(s.startsWith(':') && !s.startsWith('::')) return false;
  if(s.endsWith(':') && !s.endsWith('::')) return false;
  const parts = s.split(':');
  const lastPart = parts[parts.length - 1];
  let hexParts = parts;
  let maxHexGroups = 8;
  if(lastPart.includes('.')){
    if(!isValidIPv4(lastPart)) return false;
    hexParts = parts.slice(0, -1);
    maxHexGroups = 6;
  }
  const hasDouble = s.includes('::');
  const filtered = hexParts.filter(p => p !== '');
  const emptyCount = hexParts.filter(p => p === '').length;
  if(hasDouble){
    if(emptyCount > 2) return false;
    if(filtered.length > maxHexGroups) return false;
  } else {
    if(hexParts.length !== maxHexGroups) return false;
  }
  return filtered.every(p => /^[0-9a-fA-F]{1,4}$/.test(p));
}
function isDomain(s){
  return /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})+$/.test(s) && !isValidIPv4(s);
}
function ipToLong(ip){
  const p = ip.split('.').map(Number);
  return ((p[0]<<24) | (p[1]<<16) | (p[2]<<8) | p[3]) >>> 0;
}
function longToIp(l){
  return [(l>>>24)&255, (l>>>16)&255, (l>>>8)&255, l&255].join('.');
}
function expandCidr(cidr){
  const [base, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if(!isValidIPv4(base) || isNaN(bits) || bits < 0 || bits > 32) return null;
  const hostBits = 32 - bits;
  const count = Math.pow(2, hostBits);
  if(count > 1000) return { tooLarge: true, count };
  const baseLong = ipToLong(base) & (count===Math.pow(2,32) ? 0 : (~(count-1) >>> 0));
  const out = [];
  for(let i=0;i<count;i++) out.push(longToIp((baseLong + i) >>> 0));
  return { ips: out };
}
function expandHyphenRange(range){
  const [a,b] = range.split('-').map(s=>s.trim());
  if(!isValidIPv4(a) || !isValidIPv4(b)) return null;
  const la = ipToLong(a), lb = ipToLong(b);
  if(lb < la) return null;
  const count = lb - la + 1;
  if(count > 1000) return { tooLarge: true, count };
  const out = [];
  for(let i=la;i<=lb;i++) out.push(longToIp(i));
  return { ips: out };
}

async function resolveDomain(domain){
  try{
    const res = await apiFetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`);
    if(!res.ok) throw new Error('DNS lookup failed');
    const data = await res.json();
    const answer = (data.Answer || []).find(a => a.type === 1);
    return answer ? answer.data : null;
  }catch(e){
    return null;
  }
}

// Parses raw textarea/file content into a token list (does NOT resolve domains or expand yet)
function tokenize(raw){
  return raw.split(/[\n,\s]+/).map(s=>s.trim()).filter(Boolean);
}

// Full parse pipeline: tokenize -> expand CIDR/ranges -> flag domains for async resolution -> dedupe
async function parseIPList(raw, onProgress){
  const tokens = [...new Set(tokenize(raw))];
  const finalSet = new Set();
  const domainMap = new Map(); // resolvedIp -> domain, for display
  let warnings = [];

  for(const tok of tokens){
    if(finalSet.size > 1000) break;
    if(tok.includes('/') && isValidIPv4(tok.split('/')[0])){
      const r = expandCidr(tok);
      if(!r) { warnings.push(`Invalid CIDR skipped: ${tok}`); continue; }
      if(r.tooLarge){ warnings.push(`CIDR ${tok} expands to ${r.count} IPs — too large, skipped`); continue; }
      r.ips.forEach(ip=>finalSet.add(ip));
    } else if(tok.includes('-') && isValidIPv4(tok.split('-')[0])){
      const r = expandHyphenRange(tok);
      if(!r) { warnings.push(`Invalid range skipped: ${tok}`); continue; }
      if(r.tooLarge){ warnings.push(`Range ${tok} expands to ${r.count} IPs — too large, skipped`); continue; }
      r.ips.forEach(ip=>finalSet.add(ip));
    } else if(isValidIPv4(tok)){
      finalSet.add(tok);
    } else if(isValidIPv6(tok)){
      finalSet.add(tok);
    } else if(isDomain(tok)){
      const ip = await resolveDomain(tok);
      if(ip){ finalSet.add(ip); domainMap.set(ip, tok); }
      else warnings.push(`Could not resolve domain: ${tok}`);
      if(onProgress) onProgress(tok);
    } else {
      warnings.push(`Unrecognized entry skipped: ${tok}`);
    }
  }
  const capped = [...finalSet].slice(0, 1000);
  return { ips: capped, domainMap, warnings, exceeded: finalSet.size > 1000 };
}

/* =========================================================================
   4. GEOLOCATION
   ========================================================================= */
async function fetchWithTimeout(url, ms, signal){
  const result = await request(url, { timeoutMs: ms, signal });
  if(!result.success) throw new Error(result.error);
  return result.data;
}

async function fetchGeolocation(ip, signal){
  const empty = { country:'', countryCode:'', region:'', city:'', isp:'', lat:null, lon:null };
  // Private/reserved addresses do not have a real geographic country.
  if(isPrivateOrReserved(ip)){
    return Object.assign({}, empty, { country:'Private / reserved', countryCode:'', source:'local' });
  }
  const providers = [
    async () => {
      const res = await fetchWithTimeout(`https://ipapi.co/${ip}/json/`, 8000, signal);
      if(!res.ok) throw new Error('ipapi fail');
      const d = await res.json();
      if(d.error) throw new Error(d.reason || 'ipapi error');
      return {
        country: d.country_name || '', countryCode: d.country_code || '',
        region: d.region || '', city: d.city || '',
        isp: d.org || d.asn || '', lat: d.latitude, lon: d.longitude
      };
    },
    async () => {
      const res = await fetchWithTimeout(`https://ipwho.is/${ip}`, 8000, signal);
      if(!res.ok) throw new Error('ipwho fail');
      const d = await res.json();
      if(!d.success) throw new Error('ipwho error');
      return {
        country: d.country || '', countryCode: d.country_code || '',
        region: d.region || '', city: d.city || '',
        isp: (d.connection && (d.connection.isp || d.connection.org)) || '',
        lat: d.latitude, lon: d.longitude
      };
    },
    async () => {
      const res = await fetchWithTimeout(`https://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,isp,lat,lon`, 8000, signal);
      if(!res.ok) throw new Error('ip-api fail');
      const d = await res.json();
      if(d.status !== 'success') throw new Error('ip-api error');
      return {
        country: d.country || '', countryCode: d.countryCode || '',
        region: d.regionName || '', city: d.city || '',
        isp: d.isp || '', lat: d.lat, lon: d.lon
      };
    },
    async () => {
      const res = await fetchWithTimeout(`https://ipinfo.io/${ip}/json`, 8000, signal);
      if(!res.ok) throw new Error('ipinfo fail');
      const d = await res.json();
      const [lat, lon] = String(d.loc || '').split(',').map(Number);
      return {
        country: countryCodeToName(d.country || ''), countryCode: d.country || '',
        region: d.region || '', city: d.city || '', isp: d.org || '',
        lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null
      };
    },
    async () => {
      const res = await fetchWithTimeout(`https://freeipapi.com/api/json/${ip}`, 8000, signal);
      if(!res.ok) throw new Error('freeipapi fail');
      const d = await res.json();
      return {
        country: d.countryName || '', countryCode: d.countryCode || '',
        region: d.regionName || '', city: d.cityName || '', isp: d.isp || '',
        lat: d.latitude, lon: d.longitude
      };
    },
  ];
  for(const provider of providers){
    try{
      const geo = await provider();
      // Some services return HTTP 200 with an empty result when rate limited.
      if(geo.country || geo.countryCode) return geo;
    }catch(e){ /* try next */ }
  }
  return Object.assign({}, empty, { error: 'geo lookup failed' });
}

/* =========================================================================
   5. VIRUSTOTAL
   ========================================================================= */
function vtRateLimitPerMin(){
  const tier = $('vtTier').value;
  if(tier === '60') return Math.max(1, parseInt($('vtCustomRate').value,10) || 60);
  return 4;
}

async function waitForVtSlot(signal){
  const limit = vtRateLimitPerMin();
  while(true){
    const now = Date.now();
    if(state.vtCooldownUntil > now){
      await sleep(Math.min(state.vtCooldownUntil - now, 2000));
      if(state.stopped || (signal && signal.aborted)) return;
      continue;
    }
    state.vtRequestTimestamps = state.vtRequestTimestamps.filter(t => now - t < 60000);
    if(state.vtRequestTimestamps.length < limit){
      state.vtRequestTimestamps.push(now);
      return;
    }
    const waitMs = 60000 - (now - state.vtRequestTimestamps[0]) + 50;
    setNetStatus(`Rate limit — waiting ${Math.ceil(waitMs/1000)}s (${vtRateRemainingThisMin()}/${vtRateLimitPerMin()} VT/min left)`, true);
    updateApiStatusBar();
    await sleep(Math.min(waitMs, 2000));
    if(state.stopped || (signal && signal.aborted)) return;
  }
}

async function checkVirusTotalIP(ip, apiKey, attempt, signal){
  attempt = attempt || 0;
  await waitForVtSlot(signal);
  if(signal && signal.aborted) throw new Error('Aborted');
  try{
    const target = `${APP_CONFIG.api.virusTotal}/ip_addresses/${ip}`;
    const apiResult = await request(target, {
      headers: { 'x-apikey': apiKey },
      proxyPrefix: $('corsProxy').value.trim(),
      timeoutMs: APP_CONFIG.requestTimeoutMs,
      signal
    });
    if(!apiResult.data) throw new Error(apiResult.error);
    const res = apiResult.data;
    if(res.status === 429){
      if(attempt < 3){
        const backoff = 15000 * Math.pow(2, attempt);
        state.vtCooldownUntil = Date.now() + backoff;
        log(`VT rate limited (429) on ${ip} — pausing ${backoff/1000}s before retry`, 'l-warn');
        await sleep(backoff);
        return checkVirusTotalIP(ip, apiKey, attempt+1, signal);
      }
      throw new Error('VT rate limited (429) after retries');
    }
    incrementVtUsage();
    if(res.status === 401 || res.status === 403) throw new Error(`VT HTTP ${res.status} — check your API key`);
    if(!res.ok) throw new Error(`VT HTTP ${res.status}`);
    const data = await res.json();
    return extractVTData(data);
  }catch(e){
    throw new Error(describeFetchError(e));
  }
}

function adaptiveWorkerCount(requested){
  const vtEnabled = $('useVTSwitch').classList.contains('on') && $('vtKey').value.trim();
  if(!vtEnabled) return Math.max(1, Math.min(requested, 12));
  // Public VT keys need one in-flight request; higher tiers scale gradually.
  return Math.max(1, Math.min(requested, Math.floor(vtRateLimitPerMin() / 4)));
}

function extractVTData(data){
  const attrs = (data && data.data && data.data.attributes) || {};
  const stats = Object.assign({malicious:0,suspicious:0,harmless:0,undetected:0,timeout:0}, attrs.last_analysis_stats || {});
  const total = Object.values(stats).reduce((a,b)=>a+b,0) || 1;
  const detectionRatio = (stats.malicious / total) * 100;
  const reputation = attrs.reputation || 0;
  const normalizedRep = ((reputation + 100) / 200) * 100;

  // Every engine result, not just the malicious ones — used for the full detail table.
  const allEngines = [];
  const flaggedEngines = [];
  if(attrs.last_analysis_results){
    for(const [engine, r] of Object.entries(attrs.last_analysis_results)){
      const row = { engine, category: r.category || '', result: r.result || '', method: r.method || '' };
      allEngines.push(row);
      if(r.category === 'malicious' || r.category === 'suspicious') flaggedEngines.push(row);
    }
  }
  flaggedEngines.sort((a,b)=> (a.category==='malicious'?0:1) - (b.category==='malicious'?0:1));

  const votes = attrs.total_votes || { harmless:0, malicious:0 };
  const cert = attrs.last_https_certificate;
  const certIssuer = cert && cert.issuer ? (cert.issuer.O || cert.issuer.CN || '') : '';
  const whois = attrs.whois || '';
  let country = (attrs.country || '').trim();
  if(!country && whois) country = parseCountryFromWhois(whois);

  return {
    detectionRatio, normalizedRep, stats, reputation,
    country, continent: attrs.continent || '',
    asOwner: attrs.as_owner || '', asn: attrs.asn || '',
    network: attrs.network || '', whois,
    whoisDate: attrs.whois_date ? new Date(attrs.whois_date*1000).toISOString() : '',
    regionalInternetRegistry: attrs.regional_internet_registry || '',
    lastAnalysisDate: attrs.last_analysis_date ? new Date(attrs.last_analysis_date*1000).toISOString() : '',
    lastModificationDate: attrs.last_modification_date ? new Date(attrs.last_modification_date*1000).toISOString() : '',
    tags: attrs.tags || [],
    votes: { harmless: votes.harmless||0, malicious: votes.malicious||0 },
    certIssuer,
    jarm: attrs.jarm || '',
    tld: attrs.tld || '',
    topEngines: flaggedEngines.slice(0,5).map(e=>e.engine),
    flaggedEngines, allEngines,
    engineCount: allEngines.length,
    raw: data
  };
}

function incrementVtUsage(){
  const key = LS_KEYS.vtUsage + todayKey();
  state.vtUsageToday = (parseInt(lsGet(key,'0'),10) || 0) + 1;
  lsSet(key, String(state.vtUsageToday));
  $('sVtUsage').textContent = state.vtUsageToday;
  $('usageCounter').textContent = `VT requests today: ${state.vtUsageToday} (${vtQuotaRemaining()} left of ${vtDailyLimit()})`;
  if($('sVtRemaining')) $('sVtRemaining').textContent = `${vtQuotaRemaining()} of ${vtDailyLimit()} left`;
  updateApiStatusBar();
}
function loadVtUsage(){
  state.vtUsageToday = parseInt(lsGet(LS_KEYS.vtUsage + todayKey(), '0'),10) || 0;
  $('sVtUsage').textContent = state.vtUsageToday;
  $('usageCounter').textContent = `VT requests today: ${state.vtUsageToday} (${vtQuotaRemaining()} left of ${vtDailyLimit()})`;
  if($('sVtRemaining')) $('sVtRemaining').textContent = `${vtQuotaRemaining()} of ${vtDailyLimit()} left`;
  updateApiStatusBar();
}

/* =========================================================================
   6. ABUSEIPDB
   ========================================================================= */
async function checkAbuseIPDB(ip, apiKey, signal){
  try{
    const target = `${APP_CONFIG.api.abuseIpDb}/check?ipAddress=${ip}&maxAgeInDays=90`;
    const apiResult = await request(target, {
      headers: { 'Key': apiKey, 'Accept': 'application/json' },
      proxyPrefix: $('corsProxy').value.trim(),
      timeoutMs: APP_CONFIG.requestTimeoutMs,
      signal
    });
    if(!apiResult.data) throw new Error(apiResult.error);
    const res = apiResult.data;
    if(res.status === 401 || res.status === 403) throw new Error(`AbuseIPDB HTTP ${res.status} — check your API key`);
    if(!res.ok) throw new Error(`AbuseIPDB HTTP ${res.status}`);
    const data = await res.json();
    const d = data.data || {};
    return {
      confidenceScore: d.abuseConfidenceScore || 0,
      totalReports: d.totalReports || 0,
      lastReportedAt: d.lastReportedAt || '',
      isp: d.isp || '', countryCode: d.countryCode || '',
      usageType: d.usageType || '', domain: d.domain || '', isTor: !!d.isTor,
      isWhitelisted: !!d.isWhitelisted, isPublic: d.isPublic
    };
  }catch(e){
    throw new Error(describeFetchError(e));
  }
}

/* =========================================================================
   7. SCORING
   ========================================================================= */
function formatVTVerdict(vt){
  if(!vt || vt.error) return '—';
  const s = vt.stats || {};
  const mal = s.malicious || 0, sus = s.suspicious || 0;
  const total = (s.malicious||0)+(s.suspicious||0)+(s.harmless||0)+(s.undetected||0)+(s.timeout||0);
  if(mal === 0 && sus === 0) return `No detections (0/${total})`;
  const parts = [];
  if(mal) parts.push(`${mal} malicious`);
  if(sus) parts.push(`${sus} suspicious`);
  return `${parts.join(' · ')} (${mal+sus}/${total})`;
}

function isVTFlagged(vt){
  if(!vt || vt.error) return false;
  const s = vt.stats || {};
  return (s.malicious||0) > 0 || (s.suspicious||0) > 0;
}

function computeScore({ vt, ab }){
  let score = null, sources = [];
  if(vt && !vt.error){
    const s = vt.stats;
    const total = (s.malicious||0)+(s.suspicious||0)+(s.harmless||0)+(s.undetected||0)+(s.timeout||0) || 1;
    const malPct = ((s.malicious||0) / total) * 100;
    const susPct = ((s.suspicious||0) / total) * 100;
    score = malPct * 2 + susPct;
    if(s.malicious >= 1) score = Math.max(score, 35);
    if(s.malicious >= 3) score = Math.max(score, 55);
    if(s.malicious >= 5) score = Math.max(score, 75);
    if(s.malicious >= 10) score = Math.max(score, 90);
    if(s.suspicious >= 2 && !s.malicious) score = Math.max(score, 25);
    if(vt.reputation < -10) score = Math.max(score, 40);
    sources.push('VirusTotal');
  }
  if(ab && !ab.error){
    score = (score == null ? 0 : score) + ab.confidenceScore * 0.2;
    sources.push('AbuseIPDB');
  }
  if((!vt || vt.error) && ab && !ab.error){
    score = ab.confidenceScore;
  }
  if(score != null) score = Math.max(0, Math.min(100, Math.round(score*10)/10));
  return { score, sources };
}

function riskLevelFromVT(vt, score){
  if(vt && !vt.error){
    const mal = vt.stats.malicious || 0, sus = vt.stats.suspicious || 0;
    if(mal >= 3) return { label:'Malicious', cls:'malicious' };
    if(mal >= 1 || sus >= 2) return { label:'Suspicious', cls:'suspicious' };
    if(sus >= 1) return { label:'Low concern', cls:'suspicious' };
    return { label:'No detections reported', cls:'pending' };
  }
  if(score == null) return { label:'Not available', cls:'pending' };
  if(score >= 60) return { label:'Malicious', cls:'malicious' };
  if(score >= 35) return { label:'Suspicious', cls:'suspicious' };
  if(score >= 15) return { label:'Low concern', cls:'suspicious' };
  return { label:'No detections reported', cls:'pending' };
}

function riskLevel(score, vt){
  if(vt !== undefined) return riskLevelFromVT(vt, score);
  if(score == null) return { label:'Not available', cls:'pending' };
  if(score >= 60) return { label:'Malicious', cls:'malicious' };
  if(score >= 35) return { label:'Suspicious', cls:'suspicious' };
  if(score >= 15) return { label:'Low concern', cls:'suspicious' };
  return { label:'No detections reported', cls:'pending' };
}

/* =========================================================================
   8. CACHE
   ========================================================================= */
const CACHE_TTL_MS = APP_CONFIG.cacheTtlMs;
const CACHE_VERSION = 2;
function getCache(ip){
  try{
    const raw = localStorage.getItem(LS_KEYS.cachePrefix + ip);
    if(!raw) return null;
    const obj = JSON.parse(raw);
    if(!obj || !obj.data || Date.now() - obj.ts > (obj.ttl || CACHE_TTL_MS)) return null;
    obj.lastAccessed = Date.now();
    lsSet(LS_KEYS.cachePrefix + ip, JSON.stringify(obj));
    return obj.data;
  }catch(e){ return null; }
}
function setCache(ip, data){
  const now = Date.now();
  lsSet(LS_KEYS.cachePrefix + ip, JSON.stringify({
    version: CACHE_VERSION, ts: now, lastAccessed: now, ttl: CACHE_TTL_MS,
    provider: data.sources || 'geolocation', source: data.fromCache ? 'cache-refresh' : 'live', data
  }));
}
function clearAllCache(){
  const toRemove = [];
  for(let i=0;i<localStorage.length;i++){
    const k = localStorage.key(i);
    if(k && k.startsWith(LS_KEYS.cachePrefix)) toRemove.push(k);
  }
  toRemove.forEach(k=>localStorage.removeItem(k));
}

/* =========================================================================
   9. PROCESS SINGLE IP
   ========================================================================= */
async function processSingleIP(ip, domainLabel, onStatus, signal){
  const setStatus = (status, detail) => {
    if(onStatus) onStatus(status, detail);
  };

  const cached = getCache(ip);
  if(cached){
    enrichCachedCountry(cached);
    // Old cached rows may predate the country fallbacks. Refresh only the
    // missing location without repeating the paid/restricted reputation calls.
    if(countryIsMissing(cached)){
      const geo = await fetchGeolocation(ip, signal);
      const countryFields = resolveCountryFields({ vt: cached.vtFull, ab: cached.abFull, geo });
      if(countryFields.countryDisplay !== 'Unknown'){
        cached.country = countryFields.countryDisplay;
        cached.countryCode = countryFields.countryCode;
        cached.countryName = countryFields.countryName;
        cached.region = cached.region || geo.region || '';
        cached.city = cached.city || geo.city || '';
        cached.isp = cached.isp || geo.isp || '';
        setCache(ip, cached);
      }
    }
    log(`${ip} — cache hit — Score ${cached.score} (${cached.riskLabel})`, 'l-dim');
    return Object.assign({}, cached, { domain: domainLabel || cached.domain || '', status:'Done', statusDetail:'From cache', fromCache:true });
  }

  const useVT = $('useVTSwitch').classList.contains('on');
  const useAB = $('useABSwitch').classList.contains('on');
  const vtKey = $('vtKey').value.trim();
  const abKey = $('abKey').value.trim();
  const otxKey = $('otxKey').value.trim();
  const threatFoxKey = $('threatFoxKey').value.trim();

  setStatus('Processing', 'Fetching geolocation…');
  const geoPromise = fetchGeolocation(ip, signal);

  let vt = null, ab = null, errors = [];

  async function runVT(){
    if(!useVT || !vtKey) return null;
    if(vtQuotaRemaining() <= 0){
      errors.push('VT: daily quota exhausted');
      state.vtApiConnected = false;
      updateApiStatusBar();
      return { error: 'VT daily quota exhausted (500/day on public tier)' };
    }
    setStatus('Processing', 'Querying VirusTotal…');
    try{
      const data = await checkVirusTotalIP(ip, vtKey, 0, signal);
      state.vtApiConnected = true;
      updateApiStatusBar();
      return data;
    }catch(e){
      if(signal && signal.aborted) return { error: 'Aborted', aborted: true };
      if(/401|403|CORS|Blocked|fetch/i.test(e.message)) state.vtApiConnected = false;
      updateApiStatusBar();
      errors.push('VT: ' + e.message);
      return { error: e.message };
    }
  }

  async function runAB(){
    if(!useAB || !abKey) return null;
    setStatus('Processing', 'Querying AbuseIPDB…');
    try{
      const data = await checkAbuseIPDB(ip, abKey, signal);
      state.abApiConnected = true;
      updateApiStatusBar();
      return data;
    }catch(e){
      if(signal && signal.aborted) return { error: 'Aborted', aborted: true };
      if(/401|403|CORS|Blocked|fetch/i.test(e.message)) state.abApiConnected = false;
      updateApiStatusBar();
      errors.push('AbuseIPDB: ' + e.message);
      return { error: e.message };
    }
  }

  const [geo, vtResult, abResult, intelligence] = await Promise.all([
    geoPromise, runVT(), runAB(), lookupTierOne(ip, { otxKey, threatFoxKey, proxyPrefix: $('corsProxy').value.trim(), signal })
  ]);
  vt = vtResult;
  ab = abResult;
  if(useVT && !vtKey) errors.push('VT skipped — no API key set');
  if(useAB && !abKey) errors.push('AbuseIPDB skipped — no API key set');

  setStatus('Processing', 'Computing score…');
  const { score, sources } = computeScore({ vt, ab });
  const vtData = (vt && !vt.error) ? vt : null;
  const risk = riskLevel(score, vtData);
  const countryFields = resolveCountryFields({ vt, ab, geo });
  const isp = (vtData && vtData.asOwner) ? vtData.asOwner : (geo.isp || (ab && !ab.error ? ab.isp : ''));
  const vtVerdict = formatVTVerdict(vtData);
  const vtFlagged = isVTFlagged(vtData);

  const result = {
    ip,
    domain: domainLabel || '',
    country: countryFields.countryDisplay,
    countryCode: countryFields.countryCode,
    countryName: countryFields.countryName,
    region: geo.region, city: geo.city, isp,
    coords: (geo.lat!=null && geo.lon!=null) ? `${geo.lat.toFixed(3)}, ${geo.lon.toFixed(3)}` : '',
    vtDetections: vtData ? `${vtData.stats.malicious}/${vtData.stats.suspicious}/${vtData.stats.harmless}/${vtData.stats.undetected}` : (vt && vt.error ? 'n/a' : '—'),
    vtRep: vtData ? vtData.reputation : '—',
    vtVerdict,
    vtFlagged,
    topEngines: (vtData && vtData.topEngines) || [],
    score, riskLabel: risk.label, riskCls: risk.cls,
    sources: sources.concat(intelligence.filter(x=>x.success).map(x=>x.source)).join(', ') || 'None',
    lastReported: (ab && ab.lastReportedAt) || (vtData && vtData.lastAnalysisDate) || '',
    status: errors.length && !sources.length ? 'Failed' : (errors.length ? 'Partial' : 'Done'),
    statusDetail: errors.length ? errors.join('; ') : 'Complete',
    errors,
    whois: (vtData && vtData.whois) || '',
    asOwner: (vtData && vtData.asOwner) || '',
    vtFull: vtData,
    abFull: (ab && !ab.error) ? ab : null,
    vtError: (vt && vt.error) ? vt.error : null,
    abError: (ab && ab.error) ? ab.error : null,
    intelligence,
  };

  if(result.status !== 'Failed' && result.status !== 'Error'){
    // Cache a lighter copy — the full raw VT payload and per-engine list are dropped
    // to keep localStorage usage reasonable across hundreds/thousands of IPs.
    const cacheable = Object.assign({}, result);
    if(cacheable.vtFull){
      cacheable.vtFull = Object.assign({}, result.vtFull, { raw: undefined, allEngines: undefined });
    }
    setCache(ip, cacheable);
  }
  return result;
}

/* =========================================================================
   10. QUEUE / BATCH PROCESSING
   ========================================================================= */
async function processQueue(ips, domainMap, batchSize){
  const queue = [...ips];
  const total = queue.length;
  state.processedCount = 0;
  state.startTime = Date.now();
  updateProgress(0, total);

  state.abortController = new AbortController();
  const signal = state.abortController.signal;

  while(queue.length && !state.stopped && !signal.aborted){
    while(state.paused && !state.stopped){ await sleep(300); }
    if(state.stopped || signal.aborted) break;

    const batch = queue.splice(0, adaptiveWorkerCount(batchSize));
    updateRowsStatus(batch, 'Processing', 'Starting batch…');

    const batchResults = await Promise.all(batch.map(async ip => {
      try{
        const r = await processSingleIP(ip, domainMap.get(ip), (status, detail) => {
          setRowStatus(ip, status, detail);
        }, signal);
        return r;
      }catch(e){
        return { ip, domain: domainMap.get(ip)||'', status:'Failed', statusDetail: e.message, errors:[e.message], score:null, riskLabel:'Not available', riskCls:'error', vtFlagged:false, vtVerdict:'—', sources:'', country:'Unknown',region:'',city:'',isp:'',coords:'',vtDetections:'—',vtRep:'—',lastReported:'' };
      }
    }));

    batchResults.forEach(r => {
      state.results.set(r.ip, r);
      state.processedCount++;
    });

    renderTable();
    updateSummary();
    updateProgress(state.processedCount, total);
    batchResults.forEach(r=>{
      const cls = (r.status==='Failed' || r.status==='Error') ? 'l-err' : (r.errors && r.errors.length ? 'l-warn':'');
      log(`${r.ip}${r.domain?(' ('+r.domain+')'):''} — ${r.status}${r.statusDetail ? ' — '+r.statusDetail : ''} — Score ${r.score} (${r.riskLabel})`, cls);
    });

    if(queue.length){
      await sleep(1500);
    }
  }

  state.abortController = null;
  state.processing = false;
  $('startBtn').disabled = false;
  $('pauseBtn').disabled = true;
  $('stopBtn').disabled = true;
  setNetStatus(state.stopped ? 'Stopped' : 'Idle', false);
  if(!state.stopped){
    log(`Batch completed successfully — ${state.processedCount}/${total} IPs processed.`, '');
    saveSessionToHistory(total);
  } else {
    log('All pending requests terminated — batch cancelled.', 'l-warn');
  }
}

function updateRowsStatus(ips, status, statusDetail){
  ips.forEach(ip=>{
    const existing = state.results.get(ip) || { ip };
    existing.status = status;
    if(statusDetail != null) existing.statusDetail = statusDetail;
    state.results.set(ip, existing);
  });
  renderTable();
}

function updateProgress(done, total){
  const pct = total ? Math.round((done/total)*100) : 0;
  $('progressFill').style.width = pct + '%';
  $('progressText').textContent = `${done} / ${total} processed`;
  const elapsed = (Date.now() - (state.startTime||Date.now())) / 1000;
  const speed = elapsed > 0 ? (done/elapsed) : 0;
  $('sSpeed').textContent = speed.toFixed(2) + '/s';
  if(speed > 0 && done < total){
    const remaining = (total-done)/speed;
    $('progressEta').textContent = `Est. ${formatDuration(remaining)} remaining`;
  } else if(done >= total && total>0){
    $('progressEta').textContent = 'Complete';
  } else {
    $('progressEta').textContent = '—';
  }
}
function formatDuration(sec){
  sec = Math.round(sec);
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  if(h) return `${h}h ${m}m`;
  if(m) return `${m}m ${s}s`;
  return `${s}s`;
}

/* =========================================================================
   11. SUMMARY + CHARTS
   ========================================================================= */
let pieChart, barChart, asnChart, timelineChart, trendChart, countryChart, providerChart;
let vizLibsPromise = null;

function destroyChart(chart){
  if(chart) chart.destroy();
  return null;
}

function hexToRgba(hex, alpha){
  const h = String(hex || '').trim().replace('#', '');
  if(!/^[0-9a-f]{6}$/i.test(h)) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function getVizTheme(){
  const cs = getComputedStyle(document.documentElement);
  return {
    grid: cs.getPropertyValue('--border-soft').trim() || '#243041',
    text: cs.getPropertyValue('--text-dim').trim() || '#94a3b8',
    textMain: cs.getPropertyValue('--text').trim() || '#e7ecf2',
    accent: cs.getPropertyValue('--accent').trim() || '#45d9c9',
    safe: cs.getPropertyValue('--safe').trim() || '#3dd68c',
    suspicious: cs.getPropertyValue('--suspicious').trim() || '#e8c339',
    risky: cs.getPropertyValue('--risky').trim() || '#f0913e',
    malicious: cs.getPropertyValue('--malicious').trim() || '#f0576b',
    panel: cs.getPropertyValue('--panel-2').trim() || '#141d28',
  };
}

function clearVizFeedback(){
  const worldHint = $('worldMapHint');
  const heatHint = $('riskHeatmapHint');
  if(worldHint) worldHint.textContent = 'Points reflect available geolocation coordinates.';
  if(heatHint) heatHint.textContent = 'Hover a cell for counts.';
}

function clearVisualizations(){
  pieChart = destroyChart(pieChart);
  barChart = destroyChart(barChart);
  asnChart = destroyChart(asnChart);
  timelineChart = destroyChart(timelineChart);
  trendChart = destroyChart(trendChart);
  countryChart = destroyChart(countryChart);
  providerChart = destroyChart(providerChart);
  const world = $('worldMap');
  const heat = $('riskHeatmap');
  if(world) world.innerHTML = '';
  if(heat) heat.innerHTML = '';
  clearVizFeedback();
}

function countBy(rows, keyFn, limit = 10){
  const counts = new Map();
  for(const row of rows){
    const key = String(keyFn(row) || 'Unknown').trim() || 'Unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function getRiskLabel(row){
  if(!row) return 'Unknown';
  if(row.riskLabel) return row.riskLabel;
  if(row.vtFlagged && row.vtFull && row.vtFull.stats && row.vtFull.stats.malicious) return 'Malicious';
  return 'No detections reported';
}

function getSourceBuckets(rows){
  const counts = new Map();
  for(const row of rows){
    String(row.sources || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(src => counts.set(src, (counts.get(src) || 0) + 1));
  }
  return [...counts.entries()]
    .filter(([name]) => name && name !== 'None')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function parseCoords(value){
  const parts = String(value || '').split(',').map(s => s.trim());
  if(parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if(!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function rollingAverage(values, size){
  const out = [];
  let sum = 0;
  for(let i = 0; i < values.length; i++){
    sum += values[i];
    if(i >= size) sum -= values[i - size];
    out.push(sum / Math.min(i + 1, size));
  }
  return out;
}

async function loadVizLibs(){
  if(!vizLibsPromise){
    vizLibsPromise = Promise.all([
      import('https://esm.sh/d3-geo@3'),
      import('https://esm.sh/topojson-client@3.1.0'),
      import('https://esm.sh/@d3-maps/atlas@1.0.0/world/countries/countries-110m'),
    ]).then(([d3Geo, topojsonClient, worldModule]) => ({
      d3Geo,
      topojsonClient,
      worldTopo: worldModule.default || worldModule,
    }));
  }
  return vizLibsPromise;
}

function updateSummary(){
  const all = [...state.results.values()].filter(r=>r.status==='Done' || r.status==='Partial');
  const total = all.length;
  const clean = all.filter(r=>r.vtFull && !r.vtFlagged).length;
  const flagged = all.filter(r=>r.vtFlagged).length;
  const scored = all.filter(r=>r.score != null);
  const avg = scored.length ? (scored.reduce((a,r)=>a+r.score,0)/scored.length) : null;
  const sorted = [...scored].sort((a,b)=>b.score-a.score);
  const highest = sorted[0];
  const lowest = sorted[sorted.length-1];

  $('sTotal').textContent = total;
  $('sClean').textContent = clean;
  $('sFlagged').textContent = flagged;
  $('sAvg').textContent = avg == null ? '—' : avg.toFixed(1);
  $('sHigh').textContent = highest ? highest.score : '—';
  $('sHighIp').textContent = highest ? highest.ip : '';
  $('sLow').textContent = lowest ? lowest.score : '—';
  $('sLowIp').textContent = lowest ? lowest.ip : '';

  if(!all.length){
    clearVisualizations();
    return;
  }
  if(state.chartsQueued) return;
  state.chartsQueued = true;
  requestAnimationFrame(()=>{
    state.chartsQueued = false;
    updateCharts(clean, flagged, all);
    updateVisualizations(all);
  });
}

function updateCharts(noDetections, flagged, all){
  if(typeof Chart === 'undefined') return;
  const buckets = [0,0,0,0]; // no detections, low concern, suspicious, malicious
  all.forEach(r=>{
    if(r.riskLabel==='No detections reported') buckets[0]++;
    else if(r.riskLabel==='Low concern') buckets[1]++;
    else if(r.riskLabel==='Suspicious') buckets[2]++;
    else buckets[3]++;
  });
  const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--border-soft').trim();
  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim();

  if(pieChart) pieChart.destroy();
  pieChart = new Chart($('pieChart'), {
    type:'doughnut',
    data:{ labels:['No detections (VT)','Flagged (VT)'], datasets:[{ data:[noDetections, flagged], backgroundColor:['#4ec9b0','#f14c4c'], borderWidth:0 }] },
    options:{ plugins:{ legend:{ labels:{ color:textColor } }, title:{ display:true, text:'VirusTotal detection status', color:textColor } }, maintainAspectRatio:false }
  });
  if(barChart) barChart.destroy();
  barChart = new Chart($('barChart'), {
    type:'bar',
    data:{ labels:['No detections','Low concern','Suspicious','Malicious'], datasets:[{ data:buckets, backgroundColor:['#4ec9b0','#dcdcaa','#cca700','#f14c4c'] }] },
    options:{
      plugins:{ legend:{display:false}, title:{ display:true, text:'Risk Distribution', color:textColor } },
      scales:{ x:{ ticks:{color:textColor}, grid:{color:gridColor} }, y:{ ticks:{color:textColor}, grid:{color:gridColor}, beginAtZero:true } },
      maintainAspectRatio:false
    }
  });
}

async function updateVisualizations(all){
  const theme = getVizTheme();
  const orderRows = state.order.map(ip => state.results.get(ip)).filter(r => r && (r.status === 'Done' || r.status === 'Partial'));
  const seqRows = orderRows.length ? orderRows : all;
  const scoreSeries = seqRows.map(r => Number(r.score)).map(n => Number.isFinite(n) ? n : null);
  const cumulativeFlagged = [];
  let flaggedCount = 0;
  for(const row of seqRows){
    if(row.vtFlagged) flaggedCount++;
    cumulativeFlagged.push(flaggedCount);
  }
  const rollingScore = rollingAverage(scoreSeries.map(n => Number.isFinite(n) ? n : 0), 8).map(n => Math.round(n * 10) / 10);
  const flaggedRate = seqRows.map((row, idx) => Math.round(((cumulativeFlagged[idx] / (idx + 1)) * 100) * 10) / 10);

  asnChart = destroyChart(asnChart);
  timelineChart = destroyChart(timelineChart);
  trendChart = destroyChart(trendChart);
  countryChart = destroyChart(countryChart);
  providerChart = destroyChart(providerChart);

  const asnCounts = countBy(all, r => r.asOwner || r.isp || 'Unknown', 10);
  const countryCounts = countBy(all, r => r.country || 'Unknown', 10);
  const providerCounts = getSourceBuckets(all).slice(0, 8);

  const timelineLabels = seqRows.map((_, idx) => String(idx + 1));
  const trendLabels = seqRows.map((_, idx) => String(idx + 1));

  if(typeof Chart !== 'undefined'){
    if(asnCounts.length){
      asnChart = new Chart($('asnChart'), {
        type:'bar',
        data:{
          labels: asnCounts.map(([name]) => name.length > 32 ? `${name.slice(0, 29)}…` : name),
          datasets:[{
            label:'Checked IPs',
            data: asnCounts.map(([, value]) => value),
            backgroundColor: hexToRgba(theme.accent, 0.75),
            borderColor: theme.accent,
            borderWidth: 0,
          }],
        },
        options:{
          indexAxis:'y',
          maintainAspectRatio:false,
          plugins:{
            legend:{ display:false },
            title:{ display:false },
          },
          scales:{
            x:{ beginAtZero:true, ticks:{ color:theme.text }, grid:{ color:theme.grid } },
            y:{ ticks:{ color:theme.text }, grid:{ display:false } },
          },
          interaction:{ mode:'nearest', intersect:false },
        },
      });
    }

    if(seqRows.length){
      timelineChart = new Chart($('timelineChart'), {
        type:'line',
        data:{
          labels: timelineLabels,
          datasets:[
            {
              label:'Threat score',
              data: scoreSeries,
              borderColor: theme.accent,
              backgroundColor: hexToRgba(theme.accent, 0.15),
              pointRadius: 2,
              tension: 0.28,
              spanGaps: true,
            },
            {
              label:'Cumulative flagged',
              data: cumulativeFlagged,
              borderColor: theme.malicious,
              backgroundColor: hexToRgba(theme.malicious, 0.10),
              pointRadius: 0,
              borderDash: [6, 4],
              tension: 0.18,
            },
          ],
        },
        options:{
          maintainAspectRatio:false,
          plugins:{
            legend:{ labels:{ color:theme.text } },
            title:{ display:false },
          },
          scales:{
            x:{ ticks:{ color:theme.text }, grid:{ color:theme.grid } },
            y:{ beginAtZero:true, ticks:{ color:theme.text }, grid:{ color:theme.grid } },
          },
          interaction:{ mode:'index', intersect:false },
        },
      });

      trendChart = new Chart($('trendChart'), {
        type:'line',
        data:{
          labels: trendLabels,
          datasets:[
            {
              label:'Rolling average score',
              data: rollingScore,
              borderColor: theme.safe,
              backgroundColor: hexToRgba(theme.safe, 0.12),
              pointRadius: 0,
              tension: 0.28,
            },
            {
              label:'Flagged rate %',
              data: flaggedRate,
              borderColor: theme.risky,
              backgroundColor: hexToRgba(theme.risky, 0.12),
              pointRadius: 0,
              tension: 0.2,
              yAxisID: 'y1',
            },
          ],
        },
        options:{
          maintainAspectRatio:false,
          plugins:{
            legend:{ labels:{ color:theme.text } },
          },
          scales:{
            x:{ ticks:{ color:theme.text }, grid:{ color:theme.grid } },
            y:{ beginAtZero:true, ticks:{ color:theme.text }, grid:{ color:theme.grid }, suggestedMax: 100 },
            y1:{
              beginAtZero:true,
              position:'right',
              ticks:{ color:theme.text, callback:v => `${v}%` },
              grid:{ drawOnChartArea:false },
              suggestedMax: 100,
            },
          },
          interaction:{ mode:'index', intersect:false },
        },
      });
    }

    if(countryCounts.length){
      countryChart = new Chart($('countryChart'), {
        type:'bar',
        data:{
          labels: countryCounts.map(([name]) => name.length > 24 ? `${name.slice(0, 21)}…` : name),
          datasets:[{
            label:'Results',
            data: countryCounts.map(([, value]) => value),
            backgroundColor: hexToRgba(theme.malicious, 0.72),
          }],
        },
        options:{
          indexAxis:'y',
          maintainAspectRatio:false,
          plugins:{ legend:{ display:false } },
          scales:{
            x:{ beginAtZero:true, ticks:{ color:theme.text }, grid:{ color:theme.grid } },
            y:{ ticks:{ color:theme.text }, grid:{ display:false } },
          },
        },
      });
    }

    if(providerCounts.length){
      providerChart = new Chart($('providerChart'), {
        type:'bar',
        data:{
          labels: providerCounts.map(([name]) => name),
          datasets:[{
            label:'Mentions',
            data: providerCounts.map(([, value]) => value),
            backgroundColor: hexToRgba(theme.suspicious, 0.75),
          }],
        },
        options:{
          maintainAspectRatio:false,
          plugins:{ legend:{ display:false } },
          scales:{
            x:{ ticks:{ color:theme.text }, grid:{ color:theme.grid } },
            y:{ beginAtZero:true, ticks:{ color:theme.text }, grid:{ color:theme.grid } },
          },
        },
      });
    }
  }

  const worldSvg = $('worldMap');
  const heatSvg = $('riskHeatmap');
  if(worldSvg) worldSvg.innerHTML = '';
  if(heatSvg) heatSvg.innerHTML = '';
  if(!seqRows.length){
    clearVizFeedback();
    return;
  }

  try{
    const libs = await loadVizLibs();
    const token = ++state.vizVersion;
    if(!worldSvg || !heatSvg) return;
    const topo = libs.worldTopo.default || libs.worldTopo;
    const countries = libs.topojsonClient.feature(topo, topo.objects.features).features;
    const width = Math.max(worldSvg.clientWidth || 0, 320);
    const height = Math.max(worldSvg.clientHeight || 0, 240);
    const projection = libs.d3Geo.geoNaturalEarth1().fitSize([width, height], { type:'FeatureCollection', features: countries });
    const path = libs.d3Geo.geoPath(projection);
    const graticule = libs.d3Geo.geoGraticule10();

    if(token !== state.vizVersion) return;

    const svgNS = 'http://www.w3.org/2000/svg';
    const mk = (name) => document.createElementNS(svgNS, name);
    const worldHint = $('worldMapHint');
    const riskHint = $('riskHeatmapHint');

    worldSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const bg = mk('rect');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(width));
    bg.setAttribute('height', String(height));
    bg.setAttribute('fill', 'transparent');
    worldSvg.appendChild(bg);

    const landLayer = mk('g');
    worldSvg.appendChild(landLayer);
    const sphere = mk('path');
    sphere.setAttribute('d', path({ type:'Sphere' }));
    sphere.setAttribute('fill', theme.panel);
    sphere.setAttribute('stroke', theme.grid);
    sphere.setAttribute('stroke-width', '1');
    landLayer.appendChild(sphere);

    const graticulePath = mk('path');
    graticulePath.setAttribute('d', path(graticule));
    graticulePath.setAttribute('fill', 'none');
    graticulePath.setAttribute('stroke', theme.grid);
    graticulePath.setAttribute('stroke-width', '0.6');
    graticulePath.setAttribute('opacity', '0.6');
    landLayer.appendChild(graticulePath);

    for(const country of countries){
      const p = mk('path');
      p.setAttribute('d', path(country));
      p.setAttribute('fill', hexToRgba(theme.accent, 0.08));
      p.setAttribute('stroke', hexToRgba(theme.text, 0.25));
      p.setAttribute('stroke-width', '0.4');
      landLayer.appendChild(p);
    }

    const pointLayer = mk('g');
    worldSvg.appendChild(pointLayer);
    const worldPoints = seqRows
      .map(r => ({ row: r, pos: parseCoords(r.coords) }))
      .filter(item => item.pos);
    worldPoints.forEach((item, idx) => {
      const projected = projection([item.pos.lon, item.pos.lat]);
      if(!projected) return;
      const c = mk('circle');
      c.setAttribute('cx', String(projected[0]));
      c.setAttribute('cy', String(projected[1]));
      c.setAttribute('r', String(item.row.vtFlagged ? 4.6 : 3.4));
      c.setAttribute('fill', item.row.vtFlagged ? theme.malicious : (item.row.riskLabel === 'Suspicious' ? theme.risky : theme.safe));
      c.setAttribute('fill-opacity', '0.85');
      c.setAttribute('stroke', theme.panel);
      c.setAttribute('stroke-width', '1.2');
      c.addEventListener('mouseenter', ()=>{ if(worldHint) worldHint.textContent = `${item.row.ip} | ${item.row.country || 'Unknown'} | ${item.pos.lat.toFixed(2)}, ${item.pos.lon.toFixed(2)}`; });
      c.addEventListener('mouseleave', ()=>{ if(worldHint) worldHint.textContent = 'Points reflect available geolocation coordinates.'; });
      const title = mk('title');
      title.textContent = `${item.row.ip} • ${item.row.country || 'Unknown'} • ${item.row.score != null ? item.row.score : 'n/a'}`;
      c.appendChild(title);
      pointLayer.appendChild(c);
      if(idx < 4){
        const label = mk('text');
        label.setAttribute('x', String(projected[0] + 6));
        label.setAttribute('y', String(projected[1] - 6));
        label.setAttribute('fill', theme.textMain);
        label.setAttribute('font-size', '10');
        label.textContent = item.row.ip;
        pointLayer.appendChild(label);
      }
    });
    if(worldHint) worldHint.textContent = `${worldPoints.length} points plotted from ${seqRows.length} results.`;

    const riskLabels = ['No detections reported', 'Low concern', 'Suspicious', 'Malicious'];
    const topCountries = countBy(all, r => r.country || 'Unknown', 6);
    const matrix = topCountries.map(([country]) => riskLabels.map(label => all.filter(r => (r.country || 'Unknown') === country && getRiskLabel(r) === label).length));
    const maxCell = Math.max(1, ...matrix.flat());
    const heatWidth = Math.max(heatSvg.clientWidth || 0, 320);
    const heatHeight = Math.max(heatSvg.clientHeight || 0, 240);
    const margin = { top: 30, right: 12, bottom: 18, left: 120 };
    const cw = (heatWidth - margin.left - margin.right) / riskLabels.length;
    const ch = (heatHeight - margin.top - margin.bottom) / Math.max(1, topCountries.length);
    heatSvg.setAttribute('viewBox', `0 0 ${heatWidth} ${heatHeight}`);
    const hmBg = mk('rect');
    hmBg.setAttribute('width', String(heatWidth));
    hmBg.setAttribute('height', String(heatHeight));
    hmBg.setAttribute('fill', 'transparent');
    heatSvg.appendChild(hmBg);

    const header = mk('g');
    heatSvg.appendChild(header);
    riskLabels.forEach((label, idx) => {
      const t = mk('text');
      t.setAttribute('x', String(margin.left + idx * cw + cw / 2));
      t.setAttribute('y', String(18));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('fill', theme.text);
      t.setAttribute('font-size', '11');
      t.textContent = label;
      header.appendChild(t);
    });
    topCountries.forEach(([country], rowIdx) => {
      const t = mk('text');
      t.setAttribute('x', String(6));
      t.setAttribute('y', String(margin.top + rowIdx * ch + ch / 2 + 4));
      t.setAttribute('fill', theme.text);
      t.setAttribute('font-size', '11');
      t.textContent = country.length > 18 ? `${country.slice(0, 15)}…` : country;
      heatSvg.appendChild(t);
    });

    topCountries.forEach(([country], rowIdx) => {
      riskLabels.forEach((label, colIdx) => {
        const value = matrix[rowIdx][colIdx];
        const alpha = value ? 0.12 + (value / maxCell) * 0.72 : 0.04;
        const fillBase = label === 'No detections reported' ? theme.safe : label === 'Low concern' ? theme.suspicious : label === 'Suspicious' ? theme.risky : theme.malicious;
        const rect = mk('rect');
        rect.setAttribute('x', String(margin.left + colIdx * cw + 2));
        rect.setAttribute('y', String(margin.top + rowIdx * ch + 2));
        rect.setAttribute('width', String(Math.max(0, cw - 4)));
        rect.setAttribute('height', String(Math.max(0, ch - 4)));
        rect.setAttribute('rx', '4');
        rect.setAttribute('fill', hexToRgba(fillBase, alpha));
        rect.setAttribute('stroke', theme.grid);
        rect.setAttribute('stroke-width', '0.8');
        rect.addEventListener('mouseenter', ()=>{ if(riskHint) riskHint.textContent = `${country} | ${label} | ${value}`; });
        rect.addEventListener('mouseleave', ()=>{ if(riskHint) riskHint.textContent = 'Hover a cell for counts.'; });
        const title = mk('title');
        title.textContent = `${country} • ${label} • ${value}`;
        rect.appendChild(title);
        heatSvg.appendChild(rect);

        const text = mk('text');
        text.setAttribute('x', String(margin.left + colIdx * cw + cw / 2));
        text.setAttribute('y', String(margin.top + rowIdx * ch + ch / 2 + 4));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', theme.textMain);
        text.setAttribute('font-size', '11');
        text.setAttribute('font-weight', '500');
        text.textContent = value ? String(value) : '';
        heatSvg.appendChild(text);
      });
    });
  }catch(e){
    const worldHint = $('worldMapHint');
    const riskHint = $('riskHeatmapHint');
    if(worldHint) worldHint.textContent = 'Map unavailable in this browser session.';
    if(riskHint) riskHint.textContent = 'Heatmap unavailable in this browser session.';
  }
}

/* =========================================================================
   12. TABLE RENDER / SORT / FILTER / PAGINATION
   ========================================================================= */
function getFilteredSorted(){
  let rows = state.order.map(ip=>state.results.get(ip)).filter(Boolean);
  const term = state.searchTerm.toLowerCase();
  if(term){
    rows = rows.filter(r => [r.ip,r.domain,r.isp,r.country,r.city].some(v => (v||'').toLowerCase().includes(term)));
  }
  if(state.currentFilter === 'clean') rows = rows.filter(r=>r.vtFull && !r.vtFlagged && (r.status==='Done'||r.status==='Partial'));
  if(state.currentFilter === 'flagged') rows = rows.filter(r=>r.vtFlagged && (r.status==='Done'||r.status==='Partial'));
  if(state.currentFilter === 'error') rows = rows.filter(r=>r.status==='Failed' || r.status==='Error');
  const notes = readJson(LS_KEYS.notes, {});
  const tags = readJson(LS_KEYS.tags, {});
  if(state.customFilter === 'tagged') rows = rows.filter(r=>(tags[r.ip] || []).length);
  if(state.customFilter === 'noted') rows = rows.filter(r=>notes[r.ip]);
  if(state.customFilter === 'intel') rows = rows.filter(r=>(r.intelligence || []).some(item=>item.success));
  if(state.sortKey){
    rows.sort((a,b)=>{
      let av=a[state.sortKey], bv=b[state.sortKey];
      // For numeric keys (score), keep null distinct from 0:
      // null sorts below any real number so "no data" rows sink to the bottom.
      if(state.sortKey === 'score' || state.sortKey === 'vtRep'){
        const aBad = av == null || av === '' || isNaN(av);
        const bBad = bv == null || bv === '' || isNaN(bv);
        if(aBad !== bBad) return aBad ? 1 : -1;
        if(aBad && bBad) return 0;
        const an = Number(av), bn = Number(bv);
        if(an !== bn) return (an < bn ? -1 : 1) * state.sortDir;
      } else {
        if(typeof av === 'string') av = av.toLowerCase();
        if(typeof bv === 'string') bv = bv.toLowerCase();
        if(av == null) av = ''; if(bv == null) bv = '';
        if(av < bv) return -1 * state.sortDir;
        if(av > bv) return 1 * state.sortDir;
      }
      if(state.secondarySort){
        const as = a[state.secondarySort] ?? '';
        const bs = b[state.secondarySort] ?? '';
        return String(as).localeCompare(String(bs));
      }
      return 0;
    });
  }
  return rows;
}

function scoreColor(score){
  if(score == null) return getComputedStyle(document.documentElement).getPropertyValue('--text-faint');
  if(score<=15) return getComputedStyle(document.documentElement).getPropertyValue('--safe');
  if(score<=35) return getComputedStyle(document.documentElement).getPropertyValue('--suspicious');
  if(score<=60) return getComputedStyle(document.documentElement).getPropertyValue('--risky');
  return getComputedStyle(document.documentElement).getPropertyValue('--malicious');
}

function statusBadgeCls(r){
  if(r.status === 'Failed' || r.status === 'Error') return 'error';
  if(r.status === 'Processing') return 'suspicious';
  if(r.status === 'Queued') return 'pending';
  if(r.status === 'Partial') return 'suspicious';
  if(r.status === 'Done') return r.vtFlagged ? 'malicious' : 'pending';
  return 'pending';
}

function renderStatusCell(r){
  const cls = statusBadgeCls(r);
  const label = r.status || 'Pending';
  const detail = r.statusDetail ? `<span class="status-detail">${escapeHtml(r.statusDetail)}</span>` : '';
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>${detail}`;
}

let expandedIp = null;
function renderTable(){
  const rows = getFilteredSorted();
  const tbody = $('resultsBody');
  const frag = document.createDocumentFragment();

  rows.forEach(r=>{
    const tr = el('tr', 'row-expand');
    tr.dataset.ip = r.ip;

    tr.innerHTML = `
      <td>${escapeHtml(r.ip)}</td>
      <td>${escapeHtml(r.domain||'—')}</td>
      <td title="${escapeHtml(r.countryCode ? 'ISO: '+r.countryCode : 'Geolocation')}">${escapeHtml(r.country||'Unknown')}</td>
      <td>${escapeHtml(r.region||'—')}</td>
      <td>${escapeHtml(r.city||'—')}</td>
      <td>${escapeHtml(r.isp||'—')}</td>
      <td>${escapeHtml(r.coords||'—')}</td>
      <td>${escapeHtml(r.vtDetections||'—')}</td>
      <td>${escapeHtml(r.vtRep!=null?r.vtRep:'—')}</td>
      <td><span class="badge ${r.vtFlagged ? (r.vtFull && r.vtFull.stats && r.vtFull.stats.malicious ? 'malicious' : 'suspicious') : 'pending'}">${escapeHtml(r.vtVerdict||'—')}</span></td>
      <td><div class="score-cell"><span class="score-num" style="color:${scoreColor(r.score)}">${r.score!=null?r.score:'—'}</span><div class="score-bar-track"><div class="score-bar-fill" style="width:${r.score||0}%;background:${scoreColor(r.score)}"></div></div></div></td>
      <td><span class="badge ${r.riskCls||'pending'}">${escapeHtml(r.riskLabel||'—')}</span></td>
      <td>${escapeHtml(r.sources||'—')}</td>
      <td>${escapeHtml(r.lastReported ? new Date(r.lastReported).toLocaleString() : '—')}</td>
      <td>${renderStatusCell(r)}</td>
      <td><div class="row-actions">
        <button type="button" data-copy-row="${escapeHtml(r.ip)}" title="Copy row for Excel">Copy</button>
        <button type="button" class="danger" data-clear-row="${escapeHtml(r.ip)}" title="Remove this result">Clear</button>
      </div></td>
    `;
    frag.appendChild(tr);

    if(expandedIp === r.ip){
      const dr = el('tr','detail-row');
      const td = el('td'); td.colSpan = 16;
      td.innerHTML = buildDetailHtml(r);
      dr.appendChild(td);
      frag.appendChild(dr);
    }
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);
  applyColumnVisibility();
  renderPagination(rows.length);
}

function applyColumnVisibility(){
  const hidden = state.hiddenColumns;
  document.querySelectorAll('#resultsTable tr').forEach(row=>{
    [...row.children].forEach((cell, index)=>{
      if(cell.colSpan > 1) return;
      cell.hidden = hidden.has(index);
    });
  });
}

function buildDetailHtml(r){
  let retry = '';
  if(r.status === 'Failed' || r.status === 'Error' || r.status === 'Partial'){
    retry = `<button class="retry-link" data-retry="${escapeHtml(r.ip)}">Retry this IP (bypass cache)</button>`;
  }
  const errs = (r.errors && r.errors.length) ? r.errors.map(escapeHtml).join('<br>') : 'None';

  let vtBlock = '<div class="hint">No VirusTotal data.</div>';
  if(r.vtFull){
    const vt = r.vtFull;
    const s = vt.stats;
    const tagsHtml = vt.tags && vt.tags.length ? vt.tags.map(t=>`<span class="pill" style="cursor:default;">${escapeHtml(t)}</span>`).join(' ') : '—';
    const engineRows = (vt.flaggedEngines && vt.flaggedEngines.length)
      ? vt.flaggedEngines.map(e=>`<tr><td>${escapeHtml(e.engine)}</td><td><span class="badge ${e.category==='malicious'?'malicious':'suspicious'}">${escapeHtml(e.category)}</span></td><td>${escapeHtml(e.result||'—')}</td></tr>`).join('')
      : '<tr><td colspan="3">No engines flagged this IP.</td></tr>';

    vtBlock = `
      <h4 style="color:var(--text);margin:0 0 8px;font-size:12px;">VirusTotal — full breakdown</h4>
      <div class="detail-grid" style="margin-bottom:12px;">
        <div><b>Detection stats:</b> ${s.malicious} malicious · ${s.suspicious} suspicious · ${s.harmless} harmless · ${s.undetected} undetected${s.timeout?` · ${s.timeout} timeout`:''} (${vt.engineCount||s.malicious+s.suspicious+s.harmless+s.undetected} engines)</div>
        <div><b>Community reputation:</b> ${vt.reputation} <span style="color:var(--text-faint);">(harmless votes: ${vt.votes.harmless}, malicious votes: ${vt.votes.malicious})</span></div>
        <div><b>Country (VT):</b> ${escapeHtml(vt.country ? (vt.country + ' — ' + countryCodeToName(vt.country)) : '—')} / <b>Continent:</b> ${escapeHtml(vt.continent||'—')}</div>
        <div><b>ASN / Owner:</b> AS${escapeHtml(vt.asn||'—')} — ${escapeHtml(vt.asOwner||'—')}</div>
        <div><b>Network (CIDR):</b> ${escapeHtml(vt.network||'—')}</div>
        <div><b>Regional registry:</b> ${escapeHtml(vt.regionalInternetRegistry||'—')}</div>
        <div><b>Last analysis:</b> ${vt.lastAnalysisDate ? new Date(vt.lastAnalysisDate).toLocaleString() : '—'}</div>
        <div><b>Last modified:</b> ${vt.lastModificationDate ? new Date(vt.lastModificationDate).toLocaleString() : '—'}</div>
        <div><b>TLS cert issuer:</b> ${escapeHtml(vt.certIssuer||'—')}</div>
        <div><b>JARM fingerprint:</b> ${escapeHtml(vt.jarm||'—')}</div>
      </div>
      <div style="margin-bottom:10px;"><b>Tags:</b> ${tagsHtml}</div>
      <div style="margin-bottom:6px;"><b>Flagging engines (${vt.flaggedEngines ? vt.flaggedEngines.length : 0}):</b></div>
      <div style="max-height:180px;overflow:auto;border:1px solid var(--border-soft);border-radius:5px;margin-bottom:12px;">
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead><tr style="background:var(--panel);"><th style="text-align:left;padding:6px 8px;">Engine</th><th style="text-align:left;padding:6px 8px;">Category</th><th style="text-align:left;padding:6px 8px;">Result</th></tr></thead>
          <tbody>${engineRows}</tbody>
        </table>
      </div>
      <div><b>WHOIS:</b><br><div style="max-height:120px;overflow:auto;white-space:pre-wrap;background:var(--panel);padding:8px;border-radius:5px;border:1px solid var(--border-soft);">${escapeHtml(vt.whois||'—')}</div></div>
    `;
  } else if(r.vtError){
    vtBlock = `<div class="hint" style="color:var(--malicious);">VirusTotal error: ${escapeHtml(r.vtError)}</div>`;
  }

  let abBlock = '<div class="hint">No AbuseIPDB data.</div>';
  if(r.abFull){
    const ab = r.abFull;
    abBlock = `
      <h4 style="color:var(--text);margin:14px 0 8px;font-size:12px;">AbuseIPDB</h4>
      <div class="detail-grid">
        <div><b>Confidence score:</b> ${ab.confidenceScore}%</div>
        <div><b>Total reports:</b> ${ab.totalReports}</div>
        <div><b>Last reported:</b> ${ab.lastReportedAt ? new Date(ab.lastReportedAt).toLocaleString() : '—'}</div>
        <div><b>Usage type:</b> ${escapeHtml(ab.usageType||'—')}</div>
        <div><b>Domain:</b> ${escapeHtml(ab.domain||'—')}</div>
        <div><b>Tor exit node:</b> ${ab.isTor ? 'Yes' : 'No'}</div>
        <div><b>Whitelisted:</b> ${ab.isWhitelisted ? 'Yes' : 'No'}</div>
      </div>`;
  } else if(r.abError){
    abBlock = `<div class="hint" style="color:var(--malicious);">AbuseIPDB error: ${escapeHtml(r.abError)}</div>`;
  }

  const intelligenceRows = (r.intelligence || []).map(item=>{
    if(!item.success) return `<div><b>${escapeHtml(item.source)}:</b> <span style="color:var(--text-faint);">${escapeHtml(item.error || 'Unavailable')}</span></div>`;
    return `<div><b>${escapeHtml(item.source)}:</b> ${escapeHtml(JSON.stringify(item.data))}</div>`;
  }).join('');
  const intelligenceBlock = intelligenceRows
    ? `<h4 style="color:var(--text);margin:14px 0 8px;font-size:12px;">Tier 1 intelligence</h4><div class="detail-grid">${intelligenceRows}</div>`
    : '';

  return `
    <div class="detail-grid" style="margin-bottom:12px;">
      <div><b>Country:</b> ${escapeHtml(r.country||'—')}${r.countryCode ? ` <span style="color:var(--text-faint);">(${escapeHtml(r.countryCode)})</span>` : ''}</div>
      <div><b>Region / City:</b> ${escapeHtml(r.region||'—')} / ${escapeHtml(r.city||'—')}</div>
      <div><b>ISP / AS owner:</b> ${escapeHtml(r.isp||'—')}</div>
    </div>
    ${vtBlock}
    ${abBlock}
    ${intelligenceBlock}
    <div style="margin-top:14px;"><b>Errors / warnings:</b><br>${errs}</div>
    <div style="margin-top:10px;">${retry}</div>
  `;
}

function renderPagination(totalRows){
  const p = $('pagination');
  p.innerHTML = '';
  if(totalRows === 0){
    const msg = state.order.length ? 'No IPs match the current filters.' : 'No results yet. Paste IPs above to begin.';
    p.innerHTML = `<span>${msg}</span>`;
    return;
  }
  p.innerHTML = `<span>${totalRows} result${totalRows === 1 ? '' : 's'}</span>`;
}

document.addEventListener('click', (e)=>{
  const copyBtn = e.target.closest('[data-copy-row]');
  if(copyBtn){
    e.stopPropagation();
    const ip = copyBtn.dataset.copyRow;
    const r = state.results.get(ip);
    if(r) copyRowsToClipboard([r], copyBtn, false);
    return;
  }
  const clearBtn = e.target.closest('[data-clear-row]');
  if(clearBtn){
    e.stopPropagation();
    clearSingleResult(clearBtn.dataset.clearRow);
    return;
  }
  const retryBtn = e.target.closest('[data-retry]');
  if(retryBtn){
    const ip = retryBtn.dataset.retry;
    retrySingle(ip);
    return;
  }
  const row = e.target.closest('tr.row-expand');
  if(row && !e.target.closest('.row-actions')){
    const ip = row.dataset.ip;
    $('noteIp').value = ip;
    $('noteText').value = readJson(LS_KEYS.notes, {})[ip] || '';
    $('noteTags').value = (readJson(LS_KEYS.tags, {})[ip] || []).join(', ');
    expandedIp = (expandedIp === ip) ? null : ip;
    renderTable();
  }
});

async function retrySingle(ip){
  log(`Retrying ${ip} (bypassing cache)...`, '');
  const r = state.results.get(ip);
  const domainLabel = r ? r.domain : '';
  setRowStatus(ip, 'Processing', 'Retrying (bypass cache)…');
  try{
    localStorage.removeItem(LS_KEYS.cachePrefix + ip); // force fresh
    const result = await processSingleIP(ip, domainLabel, (status, detail) => setRowStatus(ip, status, detail));
    state.results.set(ip, result);
    renderTable(); updateSummary();
    log(`${ip} retry completed — ${result.status}${result.statusDetail ? ' — '+result.statusDetail : ''} — Score ${result.score}`, (result.status==='Failed'||result.status==='Error')?'l-err':'');
  }catch(e){
    log(`${ip} retry failed: ${e.message}`, 'l-err');
  }
}

/* sorting */
document.querySelectorAll('table.results thead th[data-key]').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.key;
  if(state.sortKey === key) state.sortDir *= -1; else { state.sortKey = key; state.sortDir = 1; }
    writeJson(LS_KEYS.sortStack, { primary: state.sortKey, secondary: state.secondarySort });
    document.querySelectorAll('table.results thead th .arrow').forEach(a=>a.remove());
    const arrow = el('span','arrow', state.sortDir===1?'▲':'▼');
    th.appendChild(arrow);
    renderTable();
  });
});



/* filters */
document.querySelectorAll('.pill').forEach(p=>{
  p.addEventListener('click', ()=>{
    document.querySelectorAll('.pill').forEach(x=>x.classList.remove('active'));
    p.classList.add('active');
    state.currentFilter = p.dataset.filter;
    renderTable();
  });
});
let searchTimer = null;
$('searchBox').addEventListener('input', (e)=>{
  clearTimeout(searchTimer);
  searchTimer = setTimeout(()=>{
    state.searchTerm = e.target.value;
    renderTable();
  }, 180);
});

function workflowMessage(message){
  $('workflowMsg').textContent = message;
  setTimeout(()=>{ if($('workflowMsg').textContent === message) $('workflowMsg').textContent = ''; }, 2500);
}

function renderColumnChooser(){
  const chooser = $('columnChooser');
  chooser.replaceChildren();
  [...document.querySelectorAll('#resultsTable thead th')].forEach((header, index)=>{
    const label = document.createElement('label');
    label.style.marginRight = '9px';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = !state.hiddenColumns.has(index);
    checkbox.addEventListener('change', ()=>{
      checkbox.checked ? state.hiddenColumns.delete(index) : state.hiddenColumns.add(index);
      writeJson(LS_KEYS.tableColumns, [...state.hiddenColumns]);
      renderTable();
    });
    label.append(checkbox, ` ${header.textContent.trim()}`);
    chooser.appendChild(label);
  });
}

$('saveNoteBtn').addEventListener('click', ()=>{
  const ip = $('noteIp').value.trim();
  if(!isValidIPv4(ip)){ workflowMessage('Enter a valid IP address first.'); return; }
  const notes = readJson(LS_KEYS.notes, {}), tags = readJson(LS_KEYS.tags, {});
  if($('noteText').value.trim()) notes[ip] = $('noteText').value.trim();
  tags[ip] = [...new Set($('noteTags').value.split(',').map(x=>x.trim()).filter(Boolean))];
  writeJson(LS_KEYS.notes, notes); writeJson(LS_KEYS.tags, tags);
  workflowMessage(`Saved analyst context for ${ip}.`);
  renderTable();
});

$('saveSearchBtn').addEventListener('click', ()=>{
  saveListItem(LS_KEYS.savedSearches, { ts: Date.now(), term: $('searchBox').value, filter: state.currentFilter, custom: state.customFilter, secondary: state.secondarySort });
  workflowMessage('Saved current search.');
});
$('loadSearchBtn').addEventListener('click', ()=>{
  const saved = readJson(LS_KEYS.savedSearches, [])[0];
  if(!saved){ workflowMessage('No saved search yet.'); return; }
  $('searchBox').value = saved.term || ''; state.searchTerm = saved.term || ''; state.currentFilter = saved.filter || 'all'; const pill = document.querySelector(`.pill[data-filter="${state.currentFilter}"]`); if(pill) pill.click(); state.customFilter = saved.custom || 'all'; $('customFilter').value = state.customFilter; state.secondarySort = saved.secondary || ''; $('secondarySort').value = state.secondarySort;
  workflowMessage('Loaded latest saved search.');
});
$('saveSessionBtn').addEventListener('click', ()=>{
  const rows = state.order.map(ip=>state.results.get(ip)).filter(Boolean).map(({ ip, domain, country, countryCode, region, city, isp, score, riskLabel, riskCls, status, statusDetail, sources, vtFlagged, vtVerdict, vtDetections })=>({ ip, domain, country, countryCode, region, city, isp, score, riskLabel, riskCls, status, statusDetail, sources, vtFlagged, vtVerdict, vtDetections }));
  saveListItem(LS_KEYS.sessions, { ts: Date.now(), rows }, 10); workflowMessage(`Saved session with ${rows.length} results.`);
});
$('loadSessionBtn').addEventListener('click', ()=>{
  const session = readJson(LS_KEYS.sessions, [])[0];
  if(!session){ workflowMessage('No saved session yet.'); return; }
  state.results.clear(); state.order = [];
  session.rows.forEach(row=>{ state.results.set(row.ip, row); state.order.push(row.ip); });
  renderTable(); updateSummary(); workflowMessage(`Loaded session with ${session.rows.length} results.`);
});
$('customFilter').addEventListener('change', e=>{ state.customFilter = e.target.value; renderTable(); });
$('secondarySort').addEventListener('change', e=>{ state.secondarySort = e.target.value; writeJson(LS_KEYS.sortStack, { primary: state.sortKey, secondary: state.secondarySort }); renderTable(); });

/* =========================================================================
   13. EXPORT
   ========================================================================= */
const EXPORT_HEADERS = ['IP Address','Domain','Country','Country Code','Region','City','ISP','Coordinates','VT Detections (mal/sus/harmless/undetected)','VT Reputation','VT Verdict','Threat Score','Risk Level','Threat Sources','Last Reported','Status','Status Detail'];
const REPORT_HEADERS = ['IP Address','Domain','Country','Country Code','Region','City','ISP','Coordinates','VT Malware','VT Suspicious','VT Harmless','VT Undetected','VT Detections','VT Reputation','VT Verdict','Threat Score','Risk Level','Threat Sources','Notes','Tags','Last Reported','Status','Status Detail'];

function getAnalystMaps(){
  return {
    notes: readJson(LS_KEYS.notes, {}),
    tags: readJson(LS_KEYS.tags, {}),
  };
}

function countryDisplayForReport(r){
  const code = asIsoCountryCode(r.countryCode);
  const name = r.countryName || (code ? countryCodeToName(code) : '');
  const country = String(r.country || '').trim();
  if(country && country !== 'Unknown' && country !== '...' && country !== 'â€¦' && country !== 'â€”'){
    return country;
  }
  if(code && name && name !== code) return `${code} - ${name}`;
  return name || code || 'Unknown';
}

function rowToArray(r){
  return [r.ip, r.domain||'', r.countryName||r.country||'', r.countryCode||'', r.region||'', r.city||'', r.isp||'', r.coords||'',
    r.vtDetections||'', r.vtRep!=null?r.vtRep:'', r.vtVerdict||'', r.score!=null?r.score:'', r.riskLabel||'',
    r.sources||'',
    r.lastReported ? new Date(r.lastReported).toLocaleString() : '', r.status||'', r.statusDetail||''];
}

function rowsToTsv(rows){
  return [EXPORT_HEADERS.join('\t')].concat(rows.map(r=>rowToArray(r).map(v=>String(v).replace(/\t|\n/g,' ')).join('\t'))).join('\n');
}

function normalizeReportRow(r, notesMap, tagsMap){
  const vtStats = (r.vtFull && r.vtFull.stats) || {};
  const tags = Array.isArray(tagsMap[r.ip]) ? tagsMap[r.ip] : [];
  return {
    ip: r.ip,
    domain: r.domain || '',
    country: countryDisplayForReport(r),
    countryCode: r.countryCode || '',
    region: r.region || '',
    city: r.city || '',
    isp: r.isp || '',
    coords: r.coords || '',
    vtMalicious: vtStats.malicious != null ? vtStats.malicious : '',
    vtSuspicious: vtStats.suspicious != null ? vtStats.suspicious : '',
    vtHarmless: vtStats.harmless != null ? vtStats.harmless : '',
    vtUndetected: vtStats.undetected != null ? vtStats.undetected : '',
    vtDetections: r.vtDetections || '',
    vtRep: r.vtRep != null ? r.vtRep : '',
    vtVerdict: r.vtVerdict || '',
    score: r.score != null ? r.score : '',
    riskLabel: r.riskLabel || '',
    sources: r.sources || '',
    notes: notesMap[r.ip] || '',
    tags: tags.join(', '),
    lastReported: r.lastReported ? new Date(r.lastReported).toLocaleString() : '',
    status: r.status || '',
    statusDetail: r.statusDetail || '',
    vtFlagged: !!r.vtFlagged,
    vtFull: r.vtFull || null,
  };
}

function getReportRows(){
  const rows = getFilteredSorted();
  const maps = getAnalystMaps();
  return {
    rows,
    notes: maps.notes,
    tags: maps.tags,
    records: rows.map(r => normalizeReportRow(r, maps.notes, maps.tags)),
  };
}

function buildExecutiveSummary(records){
  const total = records.length;
  const completed = records.filter(r => r.status === 'Done' || r.status === 'Partial').length;
  const pending = records.filter(r => r.status === 'Queued' || r.status === 'Processing').length;
  const failed = records.filter(r => r.status === 'Failed' || r.status === 'Error').length;
  const flagged = records.filter(r => r.vtFlagged).length;
  const suspicious = records.filter(r => r.riskLabel === 'Suspicious').length;
  const lowConcern = records.filter(r => r.riskLabel === 'Low concern').length;
  const clean = records.filter(r => r.riskLabel === 'No detections reported').length;
  const noted = records.filter(r => String(r.notes || '').trim()).length;
  const tagged = records.filter(r => String(r.tags || '').trim()).length;
  const countries = new Set(records.map(r => r.country).filter(c => c && c !== 'Unknown'));
  const scoreValues = records.map(r => Number(r.score)).filter(n => Number.isFinite(n));
  const avgScore = scoreValues.length
    ? scoreValues.reduce((sum, n) => sum + n, 0) / scoreValues.length
    : null;
  const sources = new Map();
  for(const row of records){
    String(row.sources || '')
      .split(',')
      .map(s => s.trim())
      // Exclude the sentinel value stored when no provider was reached.
      .filter(s => s && s !== 'None')
      .forEach(src => sources.set(src, (sources.get(src) || 0) + 1));
  }
  const topSources = [...sources.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
  const minScore = scoreValues.length ? Math.min(...scoreValues) : null;
  const maxScore = scoreValues.length ? Math.max(...scoreValues) : null;
  return {
    generatedAt: nowIso(),
    total,
    completed,
    pending,
    failed,
    flagged,
    suspicious,
    lowConcern,
    clean,
    noted,
    tagged,
    countries: countries.size,
    averageScore: avgScore != null ? Math.round(avgScore * 10) / 10 : null,
    minScore,
    maxScore,
    topSources,
    riskBreakdown: {
      clean,
      lowConcern,
      suspicious,
      flagged,
    },
  };
}

function reportScopeSummary(){
  const bits = [];
  if(state.currentFilter && state.currentFilter !== 'all') bits.push(`Table filter: ${state.currentFilter}`);
  if(state.searchTerm && state.searchTerm.trim()) bits.push(`Search: ${state.searchTerm.trim()}`);
  if(state.customFilter && state.customFilter !== 'all') bits.push(`Analyst filter: ${state.customFilter}`);
  if(state.secondarySort) bits.push(`Secondary sort: ${state.secondarySort}`);
  return bits.length ? bits.join(' | ') : 'All currently visible results';
}

function escapeXml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[c]));
}

function escapeMarkdown(s){
  return String(s == null ? '' : s)
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>');
}

function escapeCsvCell(s){
  const text = String(s == null ? '' : s);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8', addBom = true){
  const blob = new Blob([addBom ? '\uFEFF' + content : content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function openReportWindow(title, html){
  const win = window.open('', '_blank', 'width=1280,height=900');
  if(!win) return null;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.document.title = title;
  return win;
}

function buildHtmlReport(records, summary, autoPrint = false){
  const scope = reportScopeSummary();
  const card = (label, value) => `
    <div class="card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
    </div>`;
  const sourceHtml = summary.topSources.length
    ? summary.topSources.map(s => `<li><span>${escapeHtml(s.name)}</span><strong>${s.count}</strong></li>`).join('')
    : '<li><span>No intelligence sources recorded</span><strong>0</strong></li>';
  const rowsHtml = records.map(r => `
    <tr>
      <td>${escapeHtml(r.ip)}</td>
      <td>${escapeHtml(r.country)}</td>
      <td>${escapeHtml(r.score !== '' ? r.score : 'n/a')}</td>
      <td><span class="badge ${r.vtFlagged ? 'flagged' : 'clean'}">${escapeHtml(r.riskLabel || 'n/a')}</span></td>
      <td>${escapeHtml(r.vtVerdict || 'n/a')}</td>
      <td>${escapeHtml(r.sources || 'n/a')}</td>
      <td>${escapeHtml(r.status || 'n/a')}</td>
      <td>${escapeHtml(r.notes || '')}</td>
      <td>${escapeHtml(r.tags || '')}</td>
      <td>${escapeHtml(r.lastReported || '')}</td>
    </tr>
  `).join('');
  const html = `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Sentry Batch Report</title>
    <style>
      :root{
        color-scheme: light;
        --bg:#eef3f8;
        --panel:#ffffff;
        --text:#142033;
        --muted:#5f6d84;
        --line:#d8e2ef;
        --accent:#1b8ca7;
        --accent-2:#0f6f86;
        --clean:#2f855a;
        --flagged:#c05621;
        --shadow:0 10px 30px rgba(19,31,50,.08);
      }
      *{box-sizing:border-box}
      body{
        margin:0;
        background:linear-gradient(180deg,#f7fafe 0%,var(--bg) 100%);
        color:var(--text);
        font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      }
      .page{max-width:1220px;margin:0 auto;padding:28px 24px 40px}
      .hero{
        display:flex;justify-content:space-between;gap:18px;align-items:flex-start;
        background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:22px 24px;box-shadow:var(--shadow);
      }
      .hero h1{margin:0 0 6px;font-size:28px;line-height:1.15}
      .hero p{margin:0;color:var(--muted);max-width:78ch}
      .meta{color:var(--muted);text-align:right;white-space:nowrap}
      .scope{margin-top:8px;font-size:12px;color:var(--muted)}
      .grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-top:18px}
      .card{
        background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:14px 16px;box-shadow:var(--shadow);
      }
      .card .label{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
      .card .value{margin-top:6px;font-size:24px;font-weight:700}
      .section{margin-top:22px;background:var(--panel);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}
      .section h2{margin:0;padding:18px 22px;border-bottom:1px solid var(--line);font-size:18px}
      .section-body{padding:18px 22px}
      .summary-text{margin:0 0 16px;color:var(--muted)}
      .twocol{display:grid;grid-template-columns:1.15fr .85fr;gap:18px}
      .source-list{list-style:none;margin:0;padding:0}
      .source-list li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}
      .source-list li:last-child{border-bottom:none}
      table{width:100%;border-collapse:collapse}
      th,td{padding:10px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
      th{position:sticky;top:0;background:#f6f9fc;z-index:1;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
      tbody tr:hover{background:#f9fbfd}
      .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700}
      .badge.clean{background:#dff4e8;color:var(--clean)}
      .badge.flagged{background:#fde6d7;color:var(--flagged)}
      .footer{margin-top:14px;color:var(--muted);font-size:12px;text-align:center}
      @media print{
        body{background:#fff}
        .page{max-width:none;padding:0}
        .hero,.card,.section{box-shadow:none;border-radius:0}
        .section{break-inside:avoid}
      }
    </style>
    ${autoPrint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),250));</script>' : ''}
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <div>
          <h1>Sentry Batch Investigation Report</h1>
          <p>Professional export for the current result set. This report captures the visible table, the analyst context, and a concise executive summary.</p>
          <div class="scope">${escapeHtml(scope)}</div>
        </div>
        <div class="meta">
          <div><strong>Generated</strong></div>
          <div>${escapeHtml(new Date(summary.generatedAt).toLocaleString())}</div>
          <div>${escapeHtml(summary.total)} results</div>
        </div>
      </section>
      <section class="grid">
        ${card('Total', summary.total)}
        ${card('Completed', summary.completed)}
        ${card('Flagged', summary.flagged)}
        ${card('Errors', summary.failed)}
        ${card('Notes', summary.noted)}
        ${card('Countries', summary.countries)}
      </section>
      <section class="section">
        <h2>Executive Summary</h2>
        <div class="section-body">
          <p class="summary-text">${escapeHtml(buildExecutiveSummaryText(summary))}</p>
          <div class="twocol">
            <div>
              <h3 style="margin:0 0 10px;font-size:15px;">Risk Breakdown</h3>
              <table>
                <tbody>
                  <tr><th style="position:static;background:transparent;padding-left:0;">No detections</th><td>${escapeHtml(summary.clean)}</td></tr>
                  <tr><th style="position:static;background:transparent;padding-left:0;">Low concern</th><td>${escapeHtml(summary.lowConcern)}</td></tr>
                  <tr><th style="position:static;background:transparent;padding-left:0;">Suspicious</th><td>${escapeHtml(summary.suspicious)}</td></tr>
                  <tr><th style="position:static;background:transparent;padding-left:0;">Flagged</th><td>${escapeHtml(summary.flagged)}</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h3 style="margin:0 0 10px;font-size:15px;">Top Sources</h3>
              <ul class="source-list">${sourceHtml}</ul>
            </div>
          </div>
        </div>
      </section>
      <section class="section">
        <h2>Results</h2>
        <div class="section-body" style="padding:0;">
          <div style="overflow:auto;max-height:60vh;">
            <table>
              <thead>
                <tr>
                  <th>IP</th>
                  <th>Country</th>
                  <th>Score</th>
                  <th>Risk</th>
                  <th>Verdict</th>
                  <th>Sources</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th>Tags</th>
                  <th>Last Reported</th>
                </tr>
              </thead>
              <tbody>${rowsHtml || '<tr><td colspan="10">No results to report yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </section>
      <div class="footer">Generated by Sentry Batch</div>
    </main>
  </body>
  </html>`;
  return html;
}

function buildExecutiveSummaryText(summary){
  if(!summary.total) return 'No results to report yet.';
  const parts = [
    `${summary.total} results`,
    `${summary.completed} completed`,
    `${summary.flagged} flagged`,
    `${summary.failed} errors`,
  ];
  if(summary.noted) parts.push(`${summary.noted} with notes`);
  if(summary.tagged) parts.push(`${summary.tagged} tagged`);
  if(summary.countries) parts.push(`${summary.countries} countries represented`);
  if(summary.averageScore != null) parts.push(`average score ${summary.averageScore}`);
  return `This report summarizes ${parts.join(', ')}. The highest priority rows are the flagged and suspicious items, while the table and exports preserve the full analyst context for follow-up.`;
}

function buildStandaloneSummary(summary){
  const lines = [];
  lines.push('Sentry Batch Executive Summary');
  lines.push(`Generated: ${new Date(summary.generatedAt).toLocaleString()}`);
  lines.push(`Scope: ${reportScopeSummary()}`);
  lines.push('');
  lines.push(buildExecutiveSummaryText(summary));
  lines.push('');
  lines.push(`Total results: ${summary.total}`);
  lines.push(`Completed: ${summary.completed}`);
  lines.push(`Pending: ${summary.pending}`);
  lines.push(`Flagged: ${summary.flagged}`);
  lines.push(`Errors: ${summary.failed}`);
  lines.push(`Notes: ${summary.noted}`);
  lines.push(`Tags: ${summary.tagged}`);
  lines.push(`Countries: ${summary.countries}`);
  if(summary.averageScore != null) lines.push(`Average score: ${summary.averageScore}`);
  if(summary.minScore != null && summary.maxScore != null) lines.push(`Score range: ${summary.minScore} to ${summary.maxScore}`);
  if(summary.topSources.length){
    lines.push('');
    lines.push('Top sources:');
    summary.topSources.forEach(s => lines.push(`- ${s.name}: ${s.count}`));
  }
  return lines.join('\n');
}

function buildJsonReport(records, summary){
  return JSON.stringify({
    reportType: 'sentry-batch-report',
    version: '1.0',
    generatedAt: summary.generatedAt,
    scope: reportScopeSummary(),
    summary,
    results: records,
  }, null, 2);
}

function buildMarkdownReport(records, summary){
  const lines = [];
  lines.push('# Sentry Batch Investigation Report');
  lines.push('');
  lines.push(`Generated: ${new Date(summary.generatedAt).toLocaleString()}`);
  lines.push(`Scope: ${reportScopeSummary()}`);
  lines.push('');
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(buildExecutiveSummaryText(summary));
  lines.push('');
  lines.push('| IP | Country | Score | Risk | Verdict | Sources | Status | Notes | Tags |');
  lines.push('| --- | --- | ---: | --- | --- | --- | --- | --- | --- |');
  for(const r of records){
    lines.push(`| ${escapeMarkdown(r.ip)} | ${escapeMarkdown(r.country)} | ${escapeMarkdown(r.score !== '' ? r.score : 'n/a')} | ${escapeMarkdown(r.riskLabel || 'n/a')} | ${escapeMarkdown(r.vtVerdict || 'n/a')} | ${escapeMarkdown(r.sources || 'n/a')} | ${escapeMarkdown(r.status || 'n/a')} | ${escapeMarkdown(r.notes || '')} | ${escapeMarkdown(r.tags || '')} |`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total: ${summary.total}`);
  lines.push(`- Completed: ${summary.completed}`);
  lines.push(`- Flagged: ${summary.flagged}`);
  lines.push(`- Errors: ${summary.failed}`);
  lines.push(`- Notes: ${summary.noted}`);
  lines.push(`- Tags: ${summary.tagged}`);
  lines.push(`- Countries: ${summary.countries}`);
  return lines.join('\n');
}

function buildCsvReport(records){
  const header = REPORT_HEADERS.map(escapeCsvCell).join(',');
  const rows = records.map(r => [
    r.ip,
    r.domain,
    r.country,
    r.countryCode,
    r.region,
    r.city,
    r.isp,
    r.coords,
    r.vtMalicious,
    r.vtSuspicious,
    r.vtHarmless,
    r.vtUndetected,
    r.vtDetections,
    r.vtRep,
    r.vtVerdict,
    r.score,
    r.riskLabel,
    r.sources,
    r.notes,
    r.tags,
    r.lastReported,
    r.status,
    r.statusDetail,
  ].map(escapeCsvCell).join(','));
  return [header].concat(rows).join('\r\n');
}

function reportUuid(prefix){
  if(window.crypto && typeof window.crypto.randomUUID === 'function'){
    return `${prefix}--${window.crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  if(window.crypto && typeof window.crypto.getRandomValues === 'function'){
    window.crypto.getRandomValues(bytes);
  }else{
    for(let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}--${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildStixBundle(records, summary){
  const now = summary.generatedAt;
  const objects = [{
    type: 'identity',
    spec_version: '2.1',
    id: reportUuid('identity'),
    created: now,
    modified: now,
    name: 'Sentry Batch',
    identity_class: 'organization',
  }];
  for(const r of records){
    if(!r.ip) continue;
    const notes = String(r.notes || '').trim();
    const tags = String(r.tags || '').trim();
    const sourceText = String(r.sources || '').trim();
    objects.push({
      type: 'indicator',
      spec_version: '2.1',
      id: reportUuid('indicator'),
      created: now,
      modified: now,
      valid_from: now,
      confidence: Number.isFinite(Number(r.score)) ? Math.max(0, Math.min(100, Math.round(Number(r.score)))) : 50,
      pattern_type: 'stix',
      pattern: `[ipv4-addr:value = '${String(r.ip).replace(/'/g, "\\'")}']`,
      labels: [
        'ip-reputation',
        r.riskLabel || 'unknown',
        r.vtFlagged ? 'flagged' : 'clean',
      ],
      name: `${r.ip} reputation indicator`,
      description: [
        `Country: ${r.country || 'Unknown'}`,
        `Score: ${r.score !== '' ? r.score : 'n/a'}`,
        `Verdict: ${r.vtVerdict || 'n/a'}`,
        `Sources: ${sourceText || 'n/a'}`,
      ].join(' | '),
      external_references: sourceText ? sourceText.split(',').map(s => ({ source_name: s.trim() })).filter(ref => ref.source_name) : undefined,
      x_sentry_batch: {
        status: r.status || '',
        status_detail: r.statusDetail || '',
        region: r.region || '',
        city: r.city || '',
        isp: r.isp || '',
        notes,
        tags: tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : [],
      },
    });
  }
  return JSON.stringify({
    type: 'bundle',
    spec_version: '2.1',
    id: reportUuid('bundle'),
    objects,
  }, null, 2);
}

function buildOpenIocReport(records, summary){
  const iocs = records.filter(r => r.ip).map(r => {
    const notes = String(r.notes || '').trim();
    const tags = String(r.tags || '').trim();
    return `    <Indicator id="${escapeXml(reportUuid('indicator'))}" operator="OR">
      <IndicatorItem id="${escapeXml(reportUuid('item'))}" condition="is">
        <Context document="Network" search="IPv4Address" type="mir"/>
        <Content type="string">${escapeXml(r.ip)}</Content>
      </IndicatorItem>
      ${notes ? `<IndicatorItem id="${escapeXml(reportUuid('item'))}" condition="contains"><Context document="FileItem" search="FileItem/Description" type="mir"/><Content type="string">${escapeXml(notes)}</Content></IndicatorItem>` : ''}
      ${tags ? `<IndicatorItem id="${escapeXml(reportUuid('item'))}" condition="contains"><Context document="FileItem" search="FileItem/Description" type="mir"/><Content type="string">${escapeXml(tags)}</Content></IndicatorItem>` : ''}
    </Indicator>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ioc xmlns="http://schemas.mandiant.com/2010/ioc" id="${escapeXml(reportUuid('ioc'))}" last-modified="${escapeXml(summary.generatedAt)}">
  <short_description>Sentry Batch Investigation Report</short_description>
  <description>Generated from the visible result set and analyst context.</description>
  <authored_by>Sentry Batch</authored_by>
  <authored_date>${escapeXml(summary.generatedAt)}</authored_date>
  <definition>
${iocs || '    <Indicator operator="OR"/>'}
  </definition>
</ioc>`;
}

function exportCurrentReport(kind){
  const { records, rows } = getReportRows();
  if(!rows.length){
    workflowMessage('No results to export yet.');
    return;
  }
  const summary = buildExecutiveSummary(records);
  log(`Generating ${kind.toUpperCase()} report...`, '');
  if(kind === 'json'){
    downloadTextFile(`sentry-batch-report-${todayKey()}.json`, buildJsonReport(records, summary), 'application/json;charset=utf-8', false);
  }else if(kind === 'summary'){
    downloadTextFile(`sentry-batch-summary-${todayKey()}.txt`, buildStandaloneSummary(summary));
  }else if(kind === 'markdown'){
    downloadTextFile(`sentry-batch-report-${todayKey()}.md`, buildMarkdownReport(records, summary), 'text/markdown;charset=utf-8');
  }else if(kind === 'html'){
    const win = openReportWindow('Sentry Batch HTML Report', buildHtmlReport(records, summary, false));
    if(!win) workflowMessage('Popup blocked. Allow popups to open the report.');
  }else if(kind === 'pdf'){
    const win = openReportWindow('Sentry Batch PDF Report', buildHtmlReport(records, summary, true));
    if(!win) workflowMessage('Popup blocked. Allow popups to open the report.');
  }else if(kind === 'stix'){
    downloadTextFile(`sentry-batch-report-${todayKey()}.stix.json`, buildStixBundle(records, summary), 'application/json;charset=utf-8', false);
  }else if(kind === 'openioc'){
    downloadTextFile(`sentry-batch-report-${todayKey()}.ioc.xml`, buildOpenIocReport(records, summary), 'application/xml;charset=utf-8', false);
  }else if(kind === 'csv'){
    downloadTextFile(`sentry-batch-report-${todayKey()}.csv`, buildCsvReport(records), 'text/csv;charset=utf-8');
  }
  log(`${kind.toUpperCase()} report generated.`, '');
}

async function copyTextToClipboard(text, btn){
  try{
    await navigator.clipboard.writeText(text);
    if(btn) flashMsgElement(btn, 'Copied!');
  }catch(e){
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if(btn) flashMsgElement(btn, 'Copied!');
  }
}

function flashMsgElement(btn, msg){
  const original = btn.textContent;
  btn.textContent = msg;
  setTimeout(()=>{ btn.textContent = original; }, 1400);
}

async function copyRowsToClipboard(rows, btn, includeHeaders = true){
  const text = includeHeaders
    ? rowsToTsv(rows)
    : rows.map(r=>rowToArray(r).map(v=>String(v).replace(/\t|\n/g,' ')).join('\t')).join('\n');
  await copyTextToClipboard(text, btn);
}

function clearSingleResult(ip){
  if(!ip || !state.results.has(ip)) return;
  state.results.delete(ip);
  state.order = state.order.filter(x => x !== ip);
  if(expandedIp === ip) expandedIp = null;
  renderTable();
  updateSummary();
  log(`Cleared result for ${ip}.`, 'l-dim');
}

function clearAllResults(){
  if(state.processing) return;
  if(!state.results.size) return;
  if(!confirm('Clear all results from the table?')) return;
  state.results.clear();
  state.order = [];
  expandedIp = null;
  renderTable();
  updateSummary();
  updateProgress(0, 0);
  log('All results cleared.', 'l-dim');
}

$('copyTableBtn').addEventListener('click', async ()=>{
  const rows = getFilteredSorted();
  if(!rows.length){ flashMsg('copyTableBtn','No results to copy'); return; }
  log('Copying table to clipboard...', '');
  await copyRowsToClipboard(rows, $('copyTableBtn'));
  log('Table copied to clipboard.', '');
});

$('clearResultsBtn').addEventListener('click', clearAllResults);

$('exportCsvBtn').addEventListener('click', ()=> exportCurrentReport('csv'));
$('exportSummaryBtn').addEventListener('click', ()=> exportCurrentReport('summary'));
$('exportJsonBtn').addEventListener('click', ()=> exportCurrentReport('json'));
$('exportMarkdownBtn').addEventListener('click', ()=> exportCurrentReport('markdown'));
$('exportHtmlBtn').addEventListener('click', ()=> exportCurrentReport('html'));
$('exportPdfBtn').addEventListener('click', ()=> exportCurrentReport('pdf'));
$('exportStixBtn').addEventListener('click', ()=> exportCurrentReport('stix'));
$('exportOpenIocBtn').addEventListener('click', ()=> exportCurrentReport('openioc'));

function flashMsg(btnId, msg){
  const btn = $(btnId);
  const original = btn.textContent;
  btn.textContent = msg;
  setTimeout(()=>{ btn.textContent = original; }, 1400);
}

/* =========================================================================
   14. SESSION HISTORY
   ========================================================================= */
function saveSessionToHistory(total){
  try{
    const hist = JSON.parse(lsGet(LS_KEYS.history, '[]'));
    hist.unshift({ ts: nowIso(), total, flagged: [...state.results.values()].filter(r=>r.vtFlagged).length });
    lsSet(LS_KEYS.history, JSON.stringify(hist.slice(0,10)));
  }catch(e){}
}

/* =========================================================================
   15. INPUT HANDLING (paste, upload, CIDR expansion, auto-check)
   ========================================================================= */
let debounceTimer = null;
let autoCheckTimer = null;
function scheduleAutoCheck(delay){
  if(!$('autoCheckSwitch').classList.contains('on')) return;
  clearTimeout(autoCheckTimer);
  autoCheckTimer = setTimeout(()=>{
    if(!state.processing) startProcessing();
  }, delay);
}

async function refreshUniqueCount(){
  const raw = $('ipInput').value;
  if(!raw.trim()){ $('uniqueCount').textContent = '0'; $('limitWarning').hidden = true; return; }
  const { ips, warnings, exceeded } = await parseIPList(raw);
  $('uniqueCount').textContent = ips.length;
  $('limitWarning').hidden = !exceeded;
  if(warnings.length) log(warnings.slice(0,5).join(' | '), 'l-warn');
}

$('ipInput').addEventListener('input', ()=>{
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async ()=>{
    await refreshUniqueCount();
  }, 400);
});
$('ipInput').addEventListener('paste', ()=>{
  scheduleAutoCheck(2000);
});

/* file upload */
const dz = $('dropzone');
dz.addEventListener('click', ()=> $('fileInput').click());
dz.addEventListener('dragover', e=>{ e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', ()=> dz.classList.remove('drag'));
dz.addEventListener('drop', e=>{
  e.preventDefault(); dz.classList.remove('drag');
  if(e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
$('fileInput').addEventListener('change', e=>{
  if(e.target.files.length) handleFile(e.target.files[0]);
});
function handleFile(file){
  const reader = new FileReader();
  reader.onload = async () => {
    $('ipInput').value = reader.result;
    await refreshUniqueCount();
    log(`Loaded ${file.name} (${(file.size/1024).toFixed(1)} KB)`, '');
    scheduleAutoCheck(0);
  };
  reader.readAsText(file);
}

$('clearAllBtn').addEventListener('click', ()=>{
  if(state.processing) return;
  $('ipInput').value = '';
  state.results.clear(); state.order = [];
  renderTable(); updateSummary();
  $('uniqueCount').textContent = '0';
  $('logConsole').innerHTML = '';
  updateProgress(0,0);
});

/* =========================================================================
   16. START / PAUSE / STOP
   ========================================================================= */
async function startProcessing(){
  if(state.processing) return;
  const raw = $('ipInput').value;
  if(!raw.trim()){ log('Enter or paste IP addresses above, then start a check.', 'l-warn'); return; }

  setNetStatus('Parsing input…', true);
  const { ips, domainMap, warnings, exceeded } = await parseIPList(raw);
  warnings.forEach(w=>log(w,'l-warn'));
  if(exceeded){ log('Input exceeds 1000 IP limit; only the first 1000 will be processed.', 'l-warn'); }
  if(!ips.length){ log('Could not find any valid IP addresses or domains in the input.', 'l-err'); setNetStatus('Idle', false); return; }

  const maxToProcess = Math.min(parseInt($('numToProcess').value,10) || ips.length, ips.length, 1000);
  const finalIps = ips.slice(0, maxToProcess);
  const batchSize = parseInt($('batchSize').value,10) || 10;

  state.order = finalIps.slice();
  finalIps.forEach(ip=>{
    if(!state.results.has(ip)) state.results.set(ip, { ip, domain: domainMap.get(ip)||'', status:'Queued', statusDetail:'Waiting…', score:null, riskLabel:'', riskCls:'pending', vtFlagged:false, vtVerdict:'—', sources:'', country:'…',region:'',city:'',isp:'',coords:'',vtDetections:'—',vtRep:'—',lastReported:'' });
  });
  renderTable();

  state.processing = true; state.paused = false; state.stopped = false;
  $('startBtn').disabled = true; $('pauseBtn').disabled = false; $('stopBtn').disabled = false;
  setNetStatus(`Processing… (VT ${vtQuotaRemaining()}/${vtDailyLimit()} left today)`, true);
  log(`Batch started — ${finalIps.length} IPs queued, processing ${batchSize} at a time.`, '');

  await processQueue(finalIps, domainMap, batchSize);
}

$('startBtn').addEventListener('click', startProcessing);
$('pauseBtn').addEventListener('click', ()=>{
  state.paused = !state.paused;
  $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
  setNetStatus(state.paused ? 'Paused' : `Processing… (VT ${vtQuotaRemaining()}/${vtDailyLimit()} left today)`, !state.paused);
  log(state.paused ? 'Batch paused by user.' : 'Batch resumed.', '');
});
$('stopBtn').addEventListener('click', ()=>{
  state.stopped = true; state.paused = false;
  $('pauseBtn').textContent = 'Pause';
  if(state.abortController){
    state.abortController.abort();
    state.abortController = null;
  }
  log('Cancelling batch — terminating active requests...', 'l-warn');
});

/* =========================================================================
   17. SINGLE LOOKUP + AUTO IP DETECTION
   ========================================================================= */
async function detectMyIp(){
  try{
    const res = await apiFetch('https://api.ipify.org?format=json');
    const d = await res.json();
    $('myIpDisplay').value = d.ip;
  }catch(e){
    try{
      const res2 = await apiFetch('https://icanhazip.com');
      const t = (await res2.text()).trim();
      $('myIpDisplay').value = t;
    }catch(e2){
      $('myIpDisplay').value = 'Unavailable';
    }
  }
}

$('singleCheckBtn').addEventListener('click', async ()=>{
  const val = $('singleInput').value.trim();
  if(!val) return;
  $('singleCheckBtn').disabled = true;
  setNetStatus('Checking…', true);
  let ip = val, domainLabel = '';
  if(isDomain(val)){
    domainLabel = val;
    const resolved = await resolveDomain(val);
    if(!resolved){ log(`Could not resolve ${val}`, 'l-err'); $('singleCheckBtn').disabled=false; setNetStatus('Idle',false); return; }
    ip = resolved;
  } else if(!isValidIPv4(val) && !isValidIPv6(val)){
    log(`Invalid IP or domain: ${val}`, 'l-err');
    $('singleCheckBtn').disabled = false; setNetStatus('Idle', false);
    return;
  }
  if(!state.order.includes(ip)) state.order.unshift(ip);
  state.results.set(ip, { ip, domain: domainLabel, status:'Processing', statusDetail:'Starting…', score:null, riskLabel:'', riskCls:'pending', vtFlagged:false, vtVerdict:'—', sources:'', country:'…',region:'',city:'',isp:'',coords:'',vtDetections:'—',vtRep:'—',lastReported:'' });
  renderTable();
  const result = await processSingleIP(ip, domainLabel, (status, detail) => setRowStatus(ip, status, detail));
  state.results.set(ip, result);
  renderTable(); updateSummary();
  log(`Quick lookup ${ip} — ${result.status}${result.statusDetail ? ' — '+result.statusDetail : ''} — Score ${result.score} (${result.riskLabel})`, (result.status==='Failed'||result.status==='Error')?'l-err':'');
  $('singleCheckBtn').disabled = false;
  setNetStatus('Idle', false);
});

// Quick lookup works without reaching for the mouse. Shift+Enter keeps the
// normal browser behavior available if the field is ever moved into a form.
$('singleInput').addEventListener('keydown', e=>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    if(!$('singleCheckBtn').disabled) $('singleCheckBtn').click();
  }
});

/* =========================================================================
   18. SETTINGS PANEL LOGIC
   ========================================================================= */
function loadSettings(){
  $('vtKey').value = lsGet(LS_KEYS.vtKey, '');
  $('abKey').value = lsGet(LS_KEYS.abKey, '');
  $('otxKey').value = lsGet(LS_KEYS.otxKey, '');
  $('threatFoxKey').value = lsGet(LS_KEYS.threatFoxKey, '');
  $('vtTier').value = lsGet(LS_KEYS.vtTier, '4');
  $('vtCustomRate').value = lsGet(LS_KEYS.vtCustomRate, '60');
  $('vtCustomRateWrap').style.display = $('vtTier').value === '60' ? 'block' : 'none';
  setSwitch('useVTSwitch', lsGet(LS_KEYS.useVT, '1') === '1');
  setSwitch('useABSwitch', lsGet(LS_KEYS.useAB, '1') === '1');
  $('corsProxy').value = lsGet(LS_KEYS.corsProxy, '');
}

function collectSettingsExport(){
  return {
    version: 1,
    exportedAt: nowIso(),
    settings: {
      theme: lsGet(LS_KEYS.theme, document.documentElement.getAttribute('data-theme') || 'dark'),
      vtTier: lsGet(LS_KEYS.vtTier, '4'),
      vtCustomRate: lsGet(LS_KEYS.vtCustomRate, '60'),
      useVT: lsGet(LS_KEYS.useVT, '1'),
      useAB: lsGet(LS_KEYS.useAB, '1'),
      corsProxy: lsGet(LS_KEYS.corsProxy, ''),
      hiddenColumns: readJson(LS_KEYS.tableColumns, []),
      sortStack: readJson(LS_KEYS.sortStack, {}),
    }
  };
}

function applySettingsImport(payload){
  const settings = payload && payload.settings ? payload.settings : payload;
  if(!settings || typeof settings !== 'object') throw new Error('Invalid settings file.');
  if(settings.theme) lsSet(LS_KEYS.theme, String(settings.theme));
  if(settings.vtTier != null) lsSet(LS_KEYS.vtTier, String(settings.vtTier));
  if(settings.vtCustomRate != null) lsSet(LS_KEYS.vtCustomRate, String(settings.vtCustomRate));
  if(settings.useVT != null) lsSet(LS_KEYS.useVT, String(settings.useVT));
  if(settings.useAB != null) lsSet(LS_KEYS.useAB, String(settings.useAB));
  if(settings.corsProxy != null) lsSet(LS_KEYS.corsProxy, String(settings.corsProxy));
  if(Array.isArray(settings.hiddenColumns)){
    writeJson(LS_KEYS.tableColumns, settings.hiddenColumns);
    state.hiddenColumns = new Set(settings.hiddenColumns);
  }
  if(settings.sortStack && typeof settings.sortStack === 'object') writeJson(LS_KEYS.sortStack, settings.sortStack);
  loadSettings();
  initKeyVisibilityControls();
  applyTheme(lsGet(LS_KEYS.theme, 'dark'));
  renderColumnChooser();
  renderTable();
  updateApiStatusBar();
}

function setSwitch(id, on){
  const el = $(id);
  if(!el) return;
  el.classList.toggle('on', !!on);
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
  const state = el.querySelector('.toggle-state');
  if(state) state.textContent = on ? 'On' : 'Off';
}

function setKeyVisibility(button, show){
  if(!button) return;
  const targetId = button.getAttribute('data-target');
  const input = targetId ? $(targetId) : null;
  if(!input) return;
  input.type = show ? 'text' : 'password';
  button.setAttribute('aria-pressed', show ? 'true' : 'false');
  button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${input.labels && input.labels[0] ? input.labels[0].textContent.replace(/\s+/g, ' ').trim() : 'API key'}`);
  button.textContent = show ? '🙈' : '👁';
}

function initKeyVisibilityControls(){
  document.querySelectorAll('.key-visibility').forEach(button=>{
    setKeyVisibility(button, false);
    button.addEventListener('click', ()=>{
      const targetId = button.getAttribute('data-target');
      const input = targetId ? $(targetId) : null;
      if(!input) return;
      const nextShow = input.type === 'password';
      setKeyVisibility(button, nextShow);
      input.focus();
      const end = input.value.length;
      try{ input.setSelectionRange(end, end); }catch(e){}
    });
  });
}

$('vtTier').addEventListener('change', ()=>{
  $('vtCustomRateWrap').style.display = $('vtTier').value === '60' ? 'block' : 'none';
});

['useVTSwitch','useABSwitch','autoCheckSwitch'].forEach(id=>{
  $(id).addEventListener('click', ()=>{ $(id).classList.toggle('on'); updateApiStatusBar(); });
});

$('saveKeysBtn').addEventListener('click', ()=>{
  lsSet(LS_KEYS.vtKey, $('vtKey').value.trim());
  lsSet(LS_KEYS.abKey, $('abKey').value.trim());
  lsSet(LS_KEYS.otxKey, $('otxKey').value.trim());
  lsSet(LS_KEYS.threatFoxKey, $('threatFoxKey').value.trim());
  lsSet(LS_KEYS.vtTier, $('vtTier').value);
  lsSet(LS_KEYS.vtCustomRate, $('vtCustomRate').value);
  lsSet(LS_KEYS.useVT, $('useVTSwitch').classList.contains('on') ? '1' : '0');
  lsSet(LS_KEYS.useAB, $('useABSwitch').classList.contains('on') ? '1' : '0');
  lsSet(LS_KEYS.corsProxy, $('corsProxy').value.trim());
  $('settingsMsg').textContent = 'Saved for this browser session.';
  updateApiStatusBar();
  testApiConnections();
  setTimeout(()=> $('settingsMsg').textContent = '', 2500);
});

$('exportSettingsBtn').addEventListener('click', ()=>{
  const data = collectSettingsExport();
  downloadTextFile(`sentry-batch-settings-${todayKey()}.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8', false);
  $('settingsMsg').textContent = 'Settings exported.';
  log('Settings exported to file.', 'l-dim');
  setTimeout(()=> $('settingsMsg').textContent = '', 2000);
});

$('importSettingsBtn').addEventListener('click', ()=> $('settingsFileInput').click());

$('settingsFileInput').addEventListener('change', async e=>{
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  try{
    const text = await file.text();
    const data = JSON.parse(text);
    applySettingsImport(data);
    $('settingsMsg').textContent = 'Settings imported.';
    log('Settings imported from file.', 'l-dim');
  }catch(err){
    $('settingsMsg').textContent = `Import failed: ${err.message || 'Invalid file'}`;
  }finally{
    e.target.value = '';
    setTimeout(()=> $('settingsMsg').textContent = '', 3000);
  }
});

$('testVTBtn').addEventListener('click', async ()=>{
  const key = $('vtKey').value.trim();
  if(!key){ $('settingsMsg').textContent = 'Enter a VirusTotal API key first.'; return; }
  $('settingsMsg').textContent = 'Testing VirusTotal…';
  try{
    const res = await apiFetch(proxied('https://www.virustotal.com/api/v3/ip_addresses/8.8.8.8'), { headers:{'x-apikey':key} });
    if(res.status === 401 || res.status === 403){ $('settingsMsg').textContent = `Key rejected (HTTP ${res.status}) — double-check the key.`; state.vtApiConnected = false; updateApiStatusBar(); return; }
    state.vtApiConnected = res.ok;
    updateApiStatusBar();
    $('settingsMsg').textContent = res.ok ? 'VirusTotal key works ✓' : `VirusTotal responded with HTTP ${res.status}.`;
  }catch(e){
    state.vtApiConnected = false;
    updateApiStatusBar();
    $('settingsMsg').textContent = describeFetchError(e) + ' (VirusTotal)';
  }
});
$('testABBtn').addEventListener('click', async ()=>{
  const key = $('abKey').value.trim();
  if(!key){ $('settingsMsg').textContent = 'Enter an AbuseIPDB API key first.'; return; }
  $('settingsMsg').textContent = 'Testing AbuseIPDB…';
  try{
    const res = await apiFetch(proxied('https://api.abuseipdb.com/api/v2/check?ipAddress=8.8.8.8'), { headers:{'Key':key,'Accept':'application/json'} });
    if(res.status === 401 || res.status === 403){ $('settingsMsg').textContent = `Key rejected (HTTP ${res.status}) — double-check the key.`; state.abApiConnected = false; updateApiStatusBar(); return; }
    state.abApiConnected = res.ok;
    updateApiStatusBar();
    $('settingsMsg').textContent = res.ok ? 'AbuseIPDB key works ✓' : `AbuseIPDB responded with HTTP ${res.status}.`;
  }catch(e){
    state.abApiConnected = false;
    updateApiStatusBar();
    $('settingsMsg').textContent = describeFetchError(e) + ' (AbuseIPDB)';
  }
});
$('clearCacheBtn').addEventListener('click', ()=>{
  clearAllCache();
  $('settingsMsg').textContent = 'Cache cleared.';
  log('Cache cleared — all cached API responses deleted.', 'l-dim');
  setTimeout(()=> $('settingsMsg').textContent = '', 2000);
});
$('resetSettingsBtn').addEventListener('click', ()=>{
  if(!confirm('Reset all settings and clear cache? This cannot be undone.')) return;
  Object.values(LS_KEYS).forEach(k=>{ if(typeof k === 'string' && !k.endsWith('_')) removeStored(k); });
  clearAllCache();
  loadSettings();
  initKeyVisibilityControls();
  $('settingsMsg').textContent = 'Settings reset.';
  log('Settings restored to defaults — cache cleared.', 'l-dim');
});

/* =========================================================================
   19. PANEL COLLAPSE / THEME
   ========================================================================= */
document.querySelectorAll('.panel-head').forEach(h=>{
  h.addEventListener('click', ()=>{
    document.getElementById(h.dataset.target).classList.toggle('collapsed');
  });
});

function applyTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  lsSet(LS_KEYS.theme, t);
  $('themeToggle').textContent = t === 'dark' ? '☾ Theme' : '☀ Theme';
  if(state.results.size) updateSummary();
}
$('themeToggle').setAttribute('aria-label', 'Toggle theme');
$('themeToggle').addEventListener('click', ()=>{
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

function updateOnlineState(){
  const online = navigator.onLine;
  $('netStatusText').textContent = online ? 'Idle' : 'Offline';
  $('pulseDot').classList.toggle('live', online);
  $('netStatus').setAttribute('aria-label', online ? 'Online status: idle' : 'Offline status');
}

async function registerServiceWorker(){
  if(!('serviceWorker' in navigator)) return;
  try{
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  }catch(e){
    log('Service worker registration failed — offline caching unavailable.', 'l-warn');
  }
}

document.addEventListener('keydown', e=>{
  if(e.ctrlKey && e.key === 'Enter'){ e.preventDefault(); startProcessing(); }
  if(e.ctrlKey && e.key.toLowerCase() === 's'){ e.preventDefault(); $('exportCsvBtn').click(); }
  if(e.ctrlKey && e.key.toLowerCase() === 'f'){ e.preventDefault(); $('searchBox').focus(); }
  if(e.key === 'Escape' && state.processing){ e.preventDefault(); $('stopBtn').click(); }
});

/* =========================================================================
   20. INIT
   ========================================================================= */
function init(){
  removeLegacyPersistentApiKeys();
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(lsGet(LS_KEYS.theme, prefersLight ? 'light' : 'dark'));
  loadSettings();
  initKeyVisibilityControls();
  state.hiddenColumns = new Set(readJson(LS_KEYS.tableColumns, []));
  const savedSort = readJson(LS_KEYS.sortStack, {});
  state.secondarySort = savedSort.secondary || '';
  $('secondarySort').value = state.secondarySort;
  renderColumnChooser();
  loadVtUsage();
  updateApiStatusBar();
  updateOnlineState();
  window.addEventListener('online', updateOnlineState);
  window.addEventListener('offline', updateOnlineState);
  registerServiceWorker();
  testApiConnections();
  detectMyIp();
  renderTable();
  updateSummary();
  log('Sentry Batch initialized. Configure API keys in Settings for threat scoring.', '');
}
init();




