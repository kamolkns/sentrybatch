const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export function isValidIPv4(ip){
  const match = String(ip).match(IPV4_RE);
  return !!match && match.slice(1).every(part => Number(part) >= 0 && Number(part) <= 255);
}
export function isPrivateOrReserved(ip){
  return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(String(ip));
}
