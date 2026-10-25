const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

// Récupération d'URL externes (flux, pages soumises) protégée contre le SSRF :
// l'adresse IP est contrôlée au moment de la connexion (pas seulement avant), à chaque redirection.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) {
    const rest = v.slice(7);
    if (rest.includes('.')) return isPrivateIp(rest);
    const [h1, h2] = rest.split(':').map((x) => parseInt(x, 16));
    return isPrivateIp(`${h1 >> 8}.${h1 & 255}.${h2 >> 8}.${h2 & 255}`);
  }
  return /^(f[cd]|fe[89ab])/.test(v) || v.startsWith('ff');
}

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (addrs.some((a) => isPrivateIp(a.address))) return cb(new Error('Adresse non autorisée'));
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function request(url, { timeout, maxBytes, accept }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('URL invalide')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Protocole non autorisé'));
    if (u.username || u.password) return reject(new Error('URL invalide'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return reject(new Error('Adresse non autorisée'));

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: guardedLookup,
      timeout,
      headers: { 'User-Agent': 'BlogFeedBot/1.0', Accept: accept, 'Accept-Encoding': 'identity' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).toString() });
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('Réponse trop volumineuse')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), type: String(res.headers['content-type'] || '') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Délai dépassé')));
    req.on('error', reject);
  });
}

async function safeFetch(url, { timeout = 10000, maxBytes = 2 * 1024 * 1024, maxRedirects = 3, accept = '*/*' } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const r = await request(current, { timeout, maxBytes, accept });
    if (r.redirect) { current = r.redirect; continue; }
    return { ...r, url: current };
  }
  throw new Error('Trop de redirections');
}

module.exports = { safeFetch, isPrivateIp };
