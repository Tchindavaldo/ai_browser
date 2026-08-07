#!/usr/bin/env node
/**
 * Ouvre un tunnel Cloudflare vers le serveur local et affiche l'URL publique.
 *
 * Refuse de démarrer si le serveur n'est pas protégé par un jeton : exposer un
 * navigateur pilotable sur Internet sans authentification revient à donner à
 * n'importe qui un navigateur sur cette machine.
 */
import { spawn } from 'node:child_process';

const PORT = Number(process.env.RAUVALIA_PORT || 7331);
const TOKEN = process.env.RAUVALIA_TOKEN || '';
const force = process.argv.includes('--sans-jeton');

if (!TOKEN && !force) {
  console.error(`
  Refus d'ouvrir le tunnel : RAUVALIA_TOKEN n'est pas défini.

  Le tunnel rend ce serveur accessible depuis Internet. Sans jeton, toute
  personne connaissant l'URL peut piloter un navigateur sur cette machine.

  Ajoute dans .env :   RAUVALIA_TOKEN=<une longue chaîne aléatoire>
  Génère-la avec   :   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

  Puis relance le serveur, et ce tunnel.
  (Pour passer outre en connaissance de cause : npm run tunnel -- --sans-jeton)
`);
  process.exit(1);
}

// Vérifie que le serveur tourne avant d'ouvrir le tunnel.
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
  const h = await r.json();
  if (!h.auth && !force) {
    console.error(`  Le serveur tourne sans authentification (auth: false). Définis RAUVALIA_TOKEN puis relance-le.`);
    process.exit(1);
  }
} catch {
  console.error(`  Aucun serveur Rauvalia sur le port ${PORT}. Lance « npm run serve » d'abord.`);
  process.exit(1);
}

console.log(`  Ouverture du tunnel vers http://localhost:${PORT}…\n`);

// Binaire cloudflared : chemin explicite, sinon le PATH.
const BIN = process.env.RAUVALIA_CLOUDFLARED || 'cloudflared';

const cf = spawn(BIN, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });

cf.on('error', (e) => {
  if (e.code === 'ENOENT') {
    console.error(`
  cloudflared est introuvable (${BIN}).
  Renseigne RAUVALIA_CLOUDFLARED dans .env avec le chemin complet du .exe, ou récupère-le :
    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

  Sur Windows :  winget install --id Cloudflare.cloudflared
  ou télécharge cloudflared-windows-amd64.exe, renomme-le cloudflared.exe et mets-le dans le PATH.
`);
  } else console.error(e);
  process.exit(1);
});

const show = (buf) => {
  const s = buf.toString();
  process.stderr.write(s);
  const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m) {
    const url = TOKEN ? `${m[0]}/?token=${encodeURIComponent(TOKEN)}` : m[0];
    console.log(`\n  ══════════════════════════════════════════════════════════`);
    console.log(`   Rauvalia accessible depuis n'importe quel PC :`);
    console.log(`   ${url}`);
    console.log(`   API    : ${m[0]}/api/…   (Authorization: Bearer <jeton>)`);
    console.log(`   Doc    : ${m[0]}/docs`);
    console.log(`  ══════════════════════════════════════════════════════════\n`);
  }
};
cf.stdout.on('data', show);
cf.stderr.on('data', show);

process.on('SIGINT', () => { cf.kill(); process.exit(0); });
