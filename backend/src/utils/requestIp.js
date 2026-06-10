const net = require('net');

const CLOUDFLARE_IPV4_CIDRS = [
  ['173.245.48.0', 20],
  ['103.21.244.0', 22],
  ['103.22.200.0', 22],
  ['103.31.4.0', 22],
  ['141.101.64.0', 18],
  ['108.162.192.0', 18],
  ['190.93.240.0', 20],
  ['188.114.96.0', 20],
  ['197.234.240.0', 22],
  ['198.41.128.0', 17],
  ['162.158.0.0', 15],
  ['104.16.0.0', 13],
  ['104.24.0.0', 14],
  ['172.64.0.0', 13],
  ['131.0.72.0', 22],
];

function normalizeIp(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('::ffff:')) return text.slice('::ffff:'.length);
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(text)) return text.replace(/:\d+$/, '');
  return text;
}

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((acc, part) => ((acc << 8) + part) >>> 0, 0);
}

function ipv4InCidr(ip, baseIp, prefix) {
  const ipLong = ipv4ToLong(ip);
  const baseLong = ipv4ToLong(baseIp);
  if (ipLong === null || baseLong === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipLong & mask) === (baseLong & mask);
}

function isCloudflareIp(ip) {
  const normalized = normalizeIp(ip);
  if (net.isIP(normalized) !== 4) return false;
  return CLOUDFLARE_IPV4_CIDRS.some(([baseIp, prefix]) => ipv4InCidr(normalized, baseIp, prefix));
}

function forwardedIps(req) {
  return String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);
}

function getClientIp(req) {
  const forwarded = forwardedIps(req);
  const xRealIp = normalizeIp(req?.headers?.['x-real-ip']);
  const forwardedIp = forwarded[0] || '';
  const cfIp = normalizeIp(req?.headers?.['cf-connecting-ip']);
  const proxyIp = xRealIp || forwardedIp;

  if (cfIp && (!proxyIp || isCloudflareIp(proxyIp))) return cfIp;

  return xRealIp
    || forwardedIp
    || cfIp
    || normalizeIp(req?.ip)
    || normalizeIp(req?.socket?.remoteAddress)
    || '';
}

module.exports = {
  getClientIp,
  isCloudflareIp,
};
