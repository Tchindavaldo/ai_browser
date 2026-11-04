#!/usr/bin/env node
import { runAgent } from './agent.js';

const VALUE_FLAGS = new Set(['steps', 'engine']);
const argv = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const n = a.slice(2);
    opts[n] = VALUE_FLAGS.has(n) ? argv[++i] : true;
  } else {
    positional.push(a);
  }
}
const flag = (n, d) => opts[n] ?? d;
const has = (n) => opts[n] === true;

const objective = positional.join(' ').trim();

if (!objective) {
  console.log(`Usage: node src/cli.js "<objectif>" [--headless] [--steps 40] [--engine firefox|chromium|webkit]

Exemples:
  node src/cli.js "Va sur news.ycombinator.com et donne-moi les 10 titres de la une avec leur URL"
  node src/cli.js "Sur https://httpbin.org/forms/post, commande une pizza large au bacon pour Blair, tel 0600000000, puis soumets"
`);
  process.exit(1);
}

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', r: '\x1b[0m' };

const res = await runAgent({
  objective,
  headless: has('headless'),
  engine: flag('engine', undefined),
  maxSteps: Number(flag('steps', 40)),
  onEvent: (e) => {
    if (e.type === 'thought') console.log(`${C.dim}[${e.step}] ${e.text}${C.r}`);
    if (e.type === 'action') console.log(`${C.cyan}→ ${e.name}${C.r} ${JSON.stringify(e.args)}`);
    if (e.type === 'result') console.log(`${C.dim}  ${e.output.split('\n')[0]}${C.r}`);
    if (e.type === 'done') console.log(`${e.success ? C.green + 'OK' : C.red + 'ECHEC'} ${e.result}${C.r}`);
  }
});

process.exit(res.success ? 0 : 1);
