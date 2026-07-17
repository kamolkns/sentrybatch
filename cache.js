import { SESSION_ONLY_KEYS } from './config.js';

export function getStored(key, fallback = ''){
  const store = SESSION_ONLY_KEYS.has(key) ? sessionStorage : localStorage;
  try { const value = store.getItem(key); return value === null ? fallback : value; } catch { return fallback; }
}

export function setStored(key, value){
  const store = SESSION_ONLY_KEYS.has(key) ? sessionStorage : localStorage;
  try { store.setItem(key, value); return true; } catch { return false; }
}

export function removeStored(key){
  try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch { /* storage unavailable */ }
}
