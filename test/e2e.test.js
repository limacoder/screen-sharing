import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const SCREEN_4K = { width: 3840, height: 2160 };
const SCREEN_720P = { width: 1280, height: 720 };

let server;
let browser;
let base;

before(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1' });
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch({ channel: 'chrome', args: FLAGS });
});

afterEach(async () => {
  await Promise.all(browser.contexts().map((context) => context.close()));
});

after(async () => {
  await browser.close();
  server.closeAllConnections();
  server.close();
});

async function open(screen) {
  const context = await browser.newContext({ screen, viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    const Native = RTCPeerConnection;
    window.connections = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.connections.push(this);
      }
    };
    const pickScreen = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      window.displayOptions = options;
      const stream = await pickScreen(options);
      if (window.pickWithoutAudio) {
        stream.getAudioTracks().forEach((track) => {
          track.stop();
          stream.removeTrack(track);
        });
      }
      return stream;
    };
    const NativeSocket = WebSocket;
    window.sockets = [];
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        window.sockets.push(this);
      }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => assert.fail(`erro na página: ${err}`));
  return page;
}

async function createRoom(screen = SCREEN_4K) {
  const page = await open(screen);
  await page.goto(base);
  await page.click('#enter');
  return page;
}

async function enterRoom(link, screen = SCREEN_720P) {
  const page = await open(screen);
  await page.goto(link);
  await page.click('#enter');
  return page;
}

async function connectedPair(screen) {
  const host = await createRoom();
  const guest = await enterRoom(host.url(), screen);
  await Promise.all([waitConnected(host), waitConnected(guest)]);
  return { host, guest };
}

const waitConnected = (page) => page.waitForFunction(
  () => document.getElementById('status').textContent.startsWith('Conectado'),
);

const share = (page) => page.click('#share');

const transceiverCount = (page) => page.evaluate(() => window.connections.at(-1).getTransceivers().length);

const audioReceived = (page) => page.evaluate(async () => {
  const report = await window.connections.at(-1).getStats();
  const inbound = [...report.values()].find((s) => s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > 0);
  return inbound && {
    bytes: inbound.bytesReceived,
    timestamp: inbound.timestamp,
    channels: report.get(inbound.codecId)?.channels,
    fmtp: report.get(inbound.codecId)?.sdpFmtpLine,
  };
});

const waitPlaying = (page) => page.waitForFunction(() => {
  const video = document.getElementById('remote');
  return !video.hidden && video.videoWidth > 0 && video.currentTime > 0.2;
});

const waitNoShare = (page) => page.waitForFunction(() => document.getElementById('remote').hidden);

const remoteSize = (page) => page.evaluate(() => {
  const { videoWidth: width, videoHeight: height } = document.getElementById('remote');
  return { width, height };
});

const waitRemoteHeight = (page, height) => page.waitForFunction(
  (expected) => document.getElementById('remote').videoHeight === expected,
  height,
);

test('a tela compartilhada chega e continua tocando', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);

  const start = await guest.evaluate(() => document.getElementById('remote').currentTime);
  await guest.waitForFunction((t) => document.getElementById('remote').currentTime > t + 1, start);
  assert.equal(await guest.isVisible('#unmute'), false, 'o clique em Entrar deve liberar o som');
  assert.equal(await host.isVisible('#local'), true);
});

test('nunca escolhe H.265, que derruba a aba de quem compartilha', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);

  const codec = await host.evaluate(async () => {
    const report = await window.connections.at(-1).getStats();
    const outbound = [...report.values()].find((s) => s.type === 'outbound-rtp' && s.kind === 'video' && s.codecId);
    return report.get(outbound.codecId).mimeType;
  });
  assert.notEqual(codec, 'video/H265');
});

test('o áudio da tela chega em estéreo e com bitrate alto', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);
  await guest.waitForFunction(() => document.getElementById('remote').srcObject.getAudioTracks().length === 1);
  await guest.waitForFunction(async () => {
    const report = await window.connections.at(-1).getStats();
    return [...report.values()].some((s) => s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > 10_000);
  });

  const first = await audioReceived(guest);
  assert.equal(first.channels, 2);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const second = await audioReceived(guest);
  const kbps = ((second.bytes - first.bytes) * 8) / (second.timestamp - first.timestamp);
  assert.ok(kbps > 96, `áudio chegando a só ${kbps.toFixed(0)} kbps`);
});

test('por padrão envia o som do Chrome, e tirá-lo é uma escolha', async () => {
  const host = await createRoom();
  await share(host);
  await host.waitForSelector('#local:not([hidden])');
  assert.equal(await host.evaluate(() => window.displayOptions.audio.restrictOwnAudio), false);
  await share(host);

  await host.click('#quality summary');
  await host.selectOption('#shared-sound', 'without-chrome');
  await share(host);
  await host.waitForSelector('#local:not([hidden])');
  assert.equal(await host.evaluate(() => window.displayOptions.audio.restrictOwnAudio), true);
  assert.equal(await host.isDisabled('#shared-sound'), true);
});

test('compartilhar sem áudio avisa os dois lados e dá para refazer', async () => {
  const { host, guest } = await connectedPair();
  await host.evaluate(() => { window.pickWithoutAudio = true; });
  await share(host);
  await waitPlaying(guest);

  await host.waitForSelector('#reshare:visible');
  assert.match(await host.textContent('#audio-warning-text'), /Você está compartilhando sem áudio/);
  await guest.waitForSelector('#audio-warning:visible');
  assert.match(await guest.textContent('#audio-warning-text'), /outra pessoa/);
  assert.equal(await guest.isVisible('#reshare'), false);

  await host.evaluate(() => { window.pickWithoutAudio = false; });
  await host.click('#reshare');
  await host.waitForSelector('#audio-warning', { state: 'hidden' });
  await guest.waitForSelector('#audio-warning', { state: 'hidden' });
  await waitPlaying(guest);
});

test('as estatísticas mostram o nível do áudio nos dois lados', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);
  await host.click('#toggle-stats');
  await guest.click('#toggle-stats');

  await host.waitForFunction(() => document.getElementById('stats').textContent.includes('Áudio enviado:'));
  await guest.waitForFunction(() => /Áudio recebido: \d+%/.test(document.getElementById('stats').textContent));
});

test('reduz para a tela de quem assiste e obedece a escolha manual', async () => {
  const host = await createRoom();
  await host.click('#quality summary');
  await host.selectOption('#resolution', '2160');
  const guest = await enterRoom(host.url(), { width: 640, height: 360 });
  await Promise.all([waitConnected(host), waitConnected(guest)]);
  await share(host);
  await waitPlaying(guest);

  const native = (await remoteSize(guest)).height;
  assert.ok(native > 360, `fonte de ${native}p é pequena demais para testar a redução`);

  await host.selectOption('#resolution', 'auto');
  await waitRemoteHeight(guest, 360);
});

test('os dois podem compartilhar ao mesmo tempo', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);
  await share(guest);
  await waitPlaying(host);
  await waitPlaying(guest);
});

test('parar e voltar a compartilhar não acumula transceivers', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);
  const before = await transceiverCount(host);

  for (let round = 0; round < 2; round++) {
    await share(host);
    await waitNoShare(guest);
    await share(host);
    await waitPlaying(guest);
  }
  assert.equal(await transceiverCount(host), before);
});

test('microfone chega separado da tela', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);
  await host.click('#mic');

  await guest.waitForFunction(() => document.getElementById('voice').srcObject?.getAudioTracks().length === 1);
  const routing = await guest.evaluate(() => ({
    voiceHasVideo: document.getElementById('voice').srcObject.getVideoTracks().length > 0,
    screenHasVideo: document.getElementById('remote').srcObject.getVideoTracks().length > 0,
  }));
  assert.deepEqual(routing, { voiceHasVideo: false, screenHasVideo: true });

  await host.click('#mic');
  await guest.waitForFunction(() => !document.getElementById('voice').srcObject);
  assert.equal(await guest.isVisible('#remote'), true);
});

test('quem entra depois recebe o compartilhamento em andamento', async () => {
  for (let round = 0; round < 8; round++) {
    const host = await createRoom();
    await share(host);
    await host.waitForSelector('#local:not([hidden])');

    const guest = await enterRoom(host.url());
    await waitPlaying(guest);
    await Promise.all([host.context().close(), guest.context().close()]);
  }
});

test('recarregar a página reconecta e o vídeo volta', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);

  await guest.reload();
  await guest.click('#enter');
  await waitPlaying(guest);
  await waitConnected(host);
});

test('cair o WebSocket não interrompe o vídeo', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);

  await guest.evaluate(() => window.sockets.at(-1).close());
  await guest.waitForFunction(() => window.sockets.length === 2 && window.sockets[1].readyState === 1);
  await waitConnected(guest);

  const start = await guest.evaluate(() => document.getElementById('remote').currentTime);
  await guest.waitForFunction((t) => document.getElementById('remote').currentTime > t + 1, start);
  assert.equal(await guest.evaluate(() => window.connections.length), 1);
  assert.equal(await host.evaluate(() => window.connections.length), 1);

  await share(guest);
  await waitPlaying(host);
});

test('perder a conexão e o WebSocket juntos reconstrói dos dois lados', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);

  await guest.evaluate(() => {
    window.connections.at(-1).close();
    window.sockets.at(-1).close();
  });

  await guest.waitForFunction(() => window.connections.length === 2);
  await host.waitForFunction(() => window.connections.length === 2);
  await waitConnected(host);
  await waitConnected(guest);
  await guest.waitForFunction(() => {
    const video = document.getElementById('remote');
    return !video.hidden && video.videoWidth > 0;
  });
  const start = await guest.evaluate(() => document.getElementById('remote').currentTime);
  await guest.waitForFunction((t) => document.getElementById('remote').currentTime > t + 1, start);
});

test('quem fica vê o outro sair na hora', async () => {
  const { host, guest } = await connectedPair();
  await share(guest);
  await waitPlaying(host);

  await guest.close({ runBeforeUnload: true });
  await host.waitForFunction(
    () => document.getElementById('remote').hidden
      && document.getElementById('status').textContent.startsWith('Aguardando'),
    null,
    { timeout: 3000 },
  );
});

test('terceira pessoa vê sala cheia e não atrapalha', async () => {
  const { host, guest } = await connectedPair();
  await share(host);
  await waitPlaying(guest);

  const third = await enterRoom(host.url());
  await third.waitForFunction(() => document.getElementById('status').textContent.startsWith('Sala cheia'));
  await waitPlaying(guest);
});

test('um link sem sala mostra a tela inicial', async () => {
  const page = await open(SCREEN_4K);
  await page.goto(`${base}#curto`);
  assert.equal(await page.textContent('#enter'), 'Criar sala');
});
