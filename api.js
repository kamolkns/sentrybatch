import { APP_CONFIG } from './config.js';

function withProxy(url, prefix) {
  return prefix ? prefix + encodeURIComponent(url) : url;
}

function safeMessage(error){
  const message = String(error && error.message || 'Request failed');
  return message.replace(/(?:x-apikey|key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]');
}

export async function request(url, { headers = {}, method = 'GET', body, timeoutMs = APP_CONFIG.requestTimeoutMs, proxyPrefix = '', signal } = {}){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { success: false, data: null, error: 'Aborted', source: new URL(url).hostname, cached: false, isAbort: true };
    }
    signal.addEventListener('abort', onAbort);
  }

  try{
    const response = await fetch(withProxy(url, proxyPrefix), { method, headers, body, signal: controller.signal });
    return { success: response.ok, data: response, error: response.ok ? null : `HTTP ${response.status}`, source: new URL(url).hostname, cached: false };
  }catch(error){
    const isAbort = (error && error.name === 'AbortError') || (signal && signal.aborted);
    return { success: false, data: null, error: isAbort ? 'Aborted' : safeMessage(error), source: new URL(url).hostname, cached: false, isAbort };
  }finally{
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
