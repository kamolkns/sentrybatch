export const byId = id => document.getElementById(id);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const todayKey = () => new Date().toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString();

export function escapeHtml(value){
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[char]);
}

export function safeMessage(error){
  const message = String(error && error.message || 'Request failed');
  return message.replace(/(?:x-apikey|key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]');
}
