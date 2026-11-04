import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manager } from './manager.js';
import { CAPTURES } from './browser.js';
import { modelName, llmState, updateSettings, testChain, keyFor } from './llm.js';
import { provider, listModels } from './providers.js';
import { spec } from './openapi.js';

const PORT = Number(process.env.RAUVALIA_PORT || 7331);
// 0.0.0.0 pour exposer sur le réseau local / derrière un tunnel ; 127.0.0.1 par défaut.
const HOST = process.env.RAUVALIA_HOST || '127.0.0.1';
// Si défini, toutes les routes exigent ce jeton (obligatoire dès que le serveur sort de la machine).
const TOKEN = process.env.RAUVALIA_TOKEN || '';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SWAGGER = path.join(ROOT, 'node_modules', 'swagger-ui-dist');

const clients = new Set();
const broadcast = (event) => {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
};

const manager = new Manager({
  onEvent: (e) => {
    broadcast(e);
    // Tout changement d'état de session se répercute sur la liste des onglets.
    if (['done', 'state', 'system'].includes(e.type)) broadcast({ type: 'sessions', ...manager.state() });
  }
});

/** Message court et actionnable quand un moteur ne démarre pas. */
function launchHint(engine, err) {
  const raw = String(err.message);
  if (/Executable doesn't exist|playwright install/i.test(raw)) {
    return ['edge', 'chrome'].includes(engine)
      ? `${engine} n'est pas installé sur cette machine. Choisis un autre moteur.`
      : `Le navigateur « ${engine} » n'est pas téléchargé. Lance : npx playwright install ${engine}`;
  }
  return `Échec du démarrage de ${engine} : ${raw.split('\n')[0]}`;
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) { reject(new Error('trop volumineux')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.map': 'application/json', '.json': 'application/json'
};

/** Sert un fichier depuis un dossier, sans permettre d'en sortir. */
async function serveFrom(res, dir, rel) {
  const file = path.join(dir, rel);
  if (!file.startsWith(dir)) { json(res, 403, { error: 'interdit' }); return true; }
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
    return true;
  } catch { return false; }
}

/** Vérifie le jeton. Accepte l'en-tête Bearer, ?token= ou le cookie posé au premier passage. */
function authorized(req, url, res) {
  if (!TOKEN) return true;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const q = url.searchParams.get('token');
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)rauvalia_token=([^;]+)/)?.[1];
  if (bearer === TOKEN || q === TOKEN || decodeURIComponent(cookie ?? '') === TOKEN) {
    // Le navigateur garde le jeton : les appels suivants n'ont plus besoin de ?token=
    if (q === TOKEN && res) {
      res.setHeader('set-cookie', `rauvalia_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id');

  try {
    if (url.pathname !== '/api/health' && !authorized(req, url, res)) {
      return json(res, 401, { error: 'jeton requis (Authorization: Bearer … ou ?token=…)' });
    }
    // --- Documentation OpenAPI ---
    if (url.pathname === '/api/openapi.json') return json(res, 200, spec);

    if (url.pathname === '/docs' || url.pathname === '/docs/') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(DOCS_HTML);
    }
    if (url.pathname.startsWith('/docs/')) {
      if (await serveFrom(res, SWAGGER, url.pathname.slice('/docs/'.length))) return;
      return json(res, 404, { error: 'swagger-ui-dist introuvable — lance npm install' });
    }

    // --- Captures livrées par l'agent ---
    if (req.method === 'GET' && url.pathname.startsWith('/captures/')) {
      if (await serveFrom(res, CAPTURES, decodeURIComponent(url.pathname.slice('/captures/'.length)))) return;
      return json(res, 404, { error: 'capture introuvable' });
    }

    if (url.pathname === '/api/captures') {
      let files = [];
      try { files = await fs.readdir(CAPTURES); } catch { /* dossier pas encore créé */ }
      const captures = (await Promise.all(files.filter((f) => /\.(png|jpe?g)$/i.test(f)).map(async (name) => {
        const st = await fs.stat(path.join(CAPTURES, name));
        return { name, url: `/captures/${name}`, bytes: st.size, ts: st.mtimeMs };
      }))).sort((a, b) => b.ts - a.ts);
      return json(res, 200, { captures });
    }

    // --- Interface statique ---
    if (req.method === 'GET' && !url.pathname.startsWith('/api')) {
      if (await serveFrom(res, PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))) return;
      return json(res, 404, { error: 'not found' });
    }

    // --- Flux d'événements (SSE) ---
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connecté\n\n');
      res.write(`data: ${JSON.stringify({ type: 'sessions', ...manager.state() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/state') return json(res, 200, manager.state());

    // --- Vignettes de toutes les sessions (tableau de bord) ---
    if (url.pathname === '/api/thumbs') return json(res, 200, await manager.thumbs());

    // --- Renommer une session ---
    if (url.pathname === '/api/session/rename' && req.method === 'POST') {
      const body = await readBody(req);
      const rec = manager.get(id);
      rec.title = String(body.title ?? '').trim().slice(0, 60) || rec.title;
      broadcast({ type: 'sessions', ...manager.state() });
      return json(res, 200, { ok: true });
    }

    // --- Historique d'une session (au moment de basculer dessus) ---
    if (url.pathname === '/api/history') {
      const rec = manager.get(id);
      return json(res, 200, { id: rec.id, title: rec.title, events: rec.events });
    }

    // --- Nouvelle conversation : nouvel onglet ou nouveau navigateur ---
    if (url.pathname === '/api/session/new' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const rec = await manager.createSession(body);
        broadcast({ type: 'sessions', ...manager.state() });
        return json(res, 200, { id: rec.id, ...manager.state() });
      } catch (e) {
        const msg = launchHint(body.engine ?? 'chromium', e);
        broadcast({ type: 'system', text: msg });
        return json(res, 500, { error: msg });
      }
    }

    // --- Bascule d'onglet ---
    if (url.pathname === '/api/session/select' && req.method === 'POST') {
      manager.get(id);
      manager.activeId = id;
      broadcast({ type: 'sessions', ...manager.state() });
      return json(res, 200, manager.state());
    }

    if (url.pathname === '/api/session/close' && req.method === 'POST') {
      await manager.closeSession(id);
      broadcast({ type: 'sessions', ...manager.state() });
      return json(res, 200, manager.state());
    }

    // --- Couper la tâche en cours ---
    if (url.pathname === '/api/session/cancel' && req.method === 'POST') {
      return json(res, 200, { stopped: manager.cancel(id) });
    }

    // --- Nettoyer la conversation ---
    if (url.pathname === '/api/session/clear' && req.method === 'POST') {
      await manager.clear(id);
      broadcast({ type: 'sessions', ...manager.state() });
      return json(res, 200, { ok: true });
    }

    // --- Modèle choisi pour une session (null = chaîne par défaut) ---
    if (url.pathname === '/api/session/model' && req.method === 'POST') {
      const body = await readBody(req);
      const rec = manager.sessions.get(body.id ?? manager.activeId);
      if (!rec) return json(res, 404, { error: 'session inconnue' });
      if (body.provider && body.model) {
        if (!provider(body.provider)) return json(res, 400, { error: 'fournisseur inconnu' });
        rec.session.model = { provider: body.provider, model: String(body.model).trim() };
      } else rec.session.model = null;
      broadcast({ type: 'sessions', ...manager.state() });
      return json(res, 200, { ok: true, model: rec.session.model });
    }

    // --- Nouvel objectif ---
    if (url.pathname === '/api/message' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.objective?.trim()) return json(res, 400, { error: 'objectif vide' });
      let sid = body.id ?? manager.activeId;
      if (!sid || !manager.sessions.has(sid)) sid = (await manager.createSession({ mode: 'browser' })).id;
      try {
        manager.run(sid, body.objective);
      } catch (e) { return json(res, 409, { error: e.message }); }
      broadcast({ type: 'sessions', ...manager.state() });
      return json(res, 202, { id: sid });
    }

    // --- Vue live d'une session ---
    if (url.pathname === '/api/screenshot') {
      const rec = manager.sessions.get(id ?? manager.activeId);
      if (!rec) return json(res, 200, { image: null, url: null });
      try {
        return json(res, 200, {
          image: await rec.tab.screenshot(),
          url: rec.tab.page.url(),
          title: await rec.tab.page.title()
        });
      } catch { return json(res, 200, { image: null, url: null }); }
    }

    // --- Modèles IA ---
    if (url.pathname === '/api/llm' && req.method === 'GET') return json(res, 200, llmState());
    if (url.pathname === '/api/llm' && req.method === 'POST') {
      try { return json(res, 200, updateSettings(await readBody(req))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/llm/models') {
      const p = provider(url.searchParams.get('provider'));
      if (!p) return json(res, 404, { error: 'fournisseur inconnu' });
      try { return json(res, 200, await listModels(p, keyFor(p.id))); }
      catch (e) { return json(res, 502, { error: `Liste indisponible : ${e.message}` }); }
    }
    if (url.pathname === '/api/llm/test' && req.method === 'POST') return json(res, 200, await testChain());

    if (url.pathname === '/api/health') {
      const t = manager.state().totals;
      return json(res, 200, {
        ok: true, uptime: process.uptime(), model: modelName(),
        sessions: t.sessions, browsers: t.browsers, running: t.running, auth: !!TOKEN
      });
    }

    // --- Couper le serveur ---
    if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true });
      broadcast({ type: 'system', text: 'Serveur en cours d’arrêt…' });
      setTimeout(async () => { await manager.closeAll(); server.close(); process.exit(0); }, 200);
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.message === 'session inconnue' ? 404 : 500, { error: String(e.message) });
  }
});

/** Swagger UI servi depuis node_modules — aucune ressource externe. */
const DOCS_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Rauvalia — API</title><link rel="stylesheet" href="/docs/swagger-ui.css">
<style>body{margin:0;background:#0a0d13}.topbar{display:none}
.swagger-ui{filter:invert(.92) hue-rotate(180deg)}</style></head><body>
<div id="ui"></div><script src="/docs/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/api/openapi.json',dom_id:'#ui',docExpansion:'list',defaultModelsExpandDepth:1,tryItOutEnabled:true});</script>
</body></html>`;

server.listen(PORT, HOST, () => {
  const base = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  // Le jeton s'applique aussi en local : cloudflared se connecte via 127.0.0.1,
  // exempter la boucle locale reviendrait à ouvrir le tunnel à tout le monde.
  const q = TOKEN ? `/?token=${encodeURIComponent(TOKEN)}` : '';
  console.log(`\n  Rauvalia   → ${base}${q}`);
  console.log(`  API docs   → ${base}/docs${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`);
  console.log(`  Écoute sur ${HOST}:${PORT}${TOKEN ? '  · jeton requis' : '  · sans authentification'}`);
  if (HOST === '0.0.0.0' && !TOKEN) {
    console.log('  ATTENTION : Serveur exposé SANS jeton. Définis RAUVALIA_TOKEN avant de l’ouvrir vers l’extérieur.');
  }
  console.log('');
});

process.on('SIGINT', async () => { await manager.closeAll(); process.exit(0); });
