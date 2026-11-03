import { exec } from 'node:child_process';
import fs from 'node:fs';
import { bin, install, Tunnel } from 'cloudflared';
import { startServer } from './server.js';

const REACHABLE_TIMEOUT_MS = 30_000;

async function waitUntilReachable(url) {
  const deadline = Date.now() + REACHABLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function openBrowser(url) {
  if (process.platform === 'win32') exec(`start "" "${url}"`);
  else exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${url}"`);
}

const server = await startServer({ host: '127.0.0.1' });
const { port } = server.address();

if (!fs.existsSync(bin)) {
  console.log('Baixando o cloudflared…');
  await install(bin);
}

console.log('Abrindo o túnel…');
const tunnel = Tunnel.quick(`http://127.0.0.1:${port}`);
tunnel.once('exit', () => {
  console.error('O túnel caiu. Rode npm start de novo: o link muda a cada vez.');
  process.exit(1);
});
const url = await new Promise((resolve) => tunnel.once('url', resolve));
await waitUntilReachable(url);

console.log(`\nTelão no ar: ${url}`);
console.log('Crie a sala por esse link e mande o link da sala para a outra pessoa.');
console.log('Deixe esta janela aberta enquanto usarem. Ctrl+C encerra.\n');
openBrowser(url);

process.on('SIGINT', () => {
  tunnel.stop();
  process.exit(0);
});
