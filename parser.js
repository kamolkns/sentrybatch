const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export function isValidIPv4(ip){
  const match = String(ip).match(IPV4_RE);
  return !!match && match.slice(1).every(part => Number(part) >= 0 && Number(part) <= 255);
}
export function isPrivateOrReserved(ip){
  const s = String(ip);
  // RFC 1918 private ranges + other reserved/special-use ranges
  return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|100\.(6[4-9]|[7-9]\d|1[01]\d)\.|192\.0\.0\.|192\.0\.2\.|198\.(1[89])\.|198\.51\.100\.|203\.0\.113\.|2(2[4-9]|3\d)\.|24\d\.|25[0-5]\.)/.test(s);
}
export function extractHostname(input){
  let s = String(input).trim();
  if(s.startsWith('http://') || s.startsWith('https://')){
    try {
      s = new URL(s).hostname;
    } catch(e){}
  } else {
    s = s.replace(/:\d+$/, '');
  }
  return s.replace(/[\/\\]+$/, '');
}
