export function readJson(key, fallback){
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
}
export function writeJson(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function saveListItem(key, item, max = 50){
  const list = readJson(key, []);
  list.unshift(item);
  writeJson(key, list.slice(0, max));
  return list.slice(0, max);
}
