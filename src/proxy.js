#!/usr/bin/env node
/**
 * Petit proxy HTTP à lancer sur un PC de la maison : le navigateur de l'agent (sur Fly) sort
 * alors sur Internet par la connexion de ce PC (vue « Connexion », adresse http://<IP Tailscale>:8899).
 *
 * N'écoute que sur l'adresse Tailscale (100.x.x.x) : personne d'autre ne peut l'utiliser.
 * Variables (fichier .env) : PROXY_PORT (8899 par défaut), PROXY_USER et PROXY_PASSWORD (facultatif),
 * PROXY_HOST pour forcer l'adresse d'écoute.
 */
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

const PORT = Number(process.env.PROXY_PORT || 8899);
const USER = process.env.PROXY_USER || '';
const PASS = process.env.PROXY_PASSWORD || '';

// Adresse Tailscale de cette machine (plage 100.64.0.0/10).
function tailscaleIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4') {
        const [x, y] = a.address.split('.').map(Number);
        if (x === 100 && y >= 64 && y <= 127) return a.address;
      }
    }
  }
  return null;
}

const HOST = process.env.PROXY_HOST || tailscaleIp();
if (!HOST) {
  console.error('Adresse Tailscale introuvable : Tailscale est-il lancé et connecté sur ce PC ?');
  process.exit(1);
}

const allowed = (req) => {
  if (!USER) return true;
  const h = req.headers['proxy-authorization'] || '';
  return h === 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
};
const deny = (res) => { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="ai-browser"' }); res.end(); };

const server = http.createServer((req, res) => {
  // Requêtes http:// en clair.
  if (!allowed(req)) return deny(res);
  let url;
  try { url = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
  const headers = { ...req.headers };
  delete headers['proxy-authorization']; delete headers['proxy-connection'];
  const up = http.request({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});

// Sites en https:// : tunnel chiffré de bout en bout, le proxy ne voit pas le contenu.
server.on('connect', (req, sock, head) => {
  if (!allowed(req)) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="ai-browser"\r\n\r\n'); return; }
  const [host, port] = req.url.split(':');
  const up = net.connect(Number(port) || 443, host, () => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  const close = () => { up.destroy(); sock.destroy(); };
  up.on('error', close); sock.on('error', close);
});

server.listen(PORT, HOST, () => {
  console.log(`Proxy prêt : http://${HOST}:${PORT}${USER ? ' (avec identifiant)' : ''}`);
  console.log('À ajouter dans AI Browser, vue Connexion, bouton « Ajouter un proxy ».');
});
