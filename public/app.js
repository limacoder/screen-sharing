import { Call } from './call.js';

const $ = (id) => document.getElementById(id);
const ROOM_ID = /^[\w-]{16,64}$/;
const TOAST_MS = 6000;
const SILENCE_LEVEL = 0.001;

let call = null;
let toastTimer = null;
let peerSharing = false;

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, TOAST_MS);
}

function renderStatus({ signaling, peer }, route) {
  const [text, tone] = (() => {
    if (signaling === 'full') return ['Sala cheia: já tem duas pessoas aqui', 'bad'];
    if (peer === 'failed') return ['Sem rota entre vocês. Veja "TURN" no README', 'bad'];
    if (peer === 'connected') {
      if (!route) return ['Conectado', 'good'];
      const rtt = route.rttMs === null ? '' : `, ${route.rttMs} ms`;
      return [`Conectado (${route.relayed ? 'via relay' : 'direto'}${rtt})`, 'good'];
    }
    if (signaling === 'connecting') return ['Conectando ao servidor…', 'wait'];
    if (peer === 'connecting') return ['Conectando com a outra pessoa…', 'wait'];
    return ['Aguardando a outra pessoa entrar', 'wait'];
  })();
  $('status').textContent = text;
  $('status').dataset.tone = tone;
  renderPlaceholder();
}

function renderPlaceholder() {
  const { peer } = call.status;
  const sharing = call.sharing;
  $('placeholder').hidden = peerSharing;
  if (sharing) {
    $('placeholder').textContent = 'Você está compartilhando. A outra pessoa vê a sua tela.';
  } else if (peer === 'connected') {
    $('placeholder').textContent = 'Conectados. Agora é só alguém compartilhar a tela.';
  } else {
    $('placeholder').textContent = 'Mande o link da sala para a outra pessoa.';
  }
}

function describeStream({ width, height, fps, mbps, codec, implementation, hardware, limitedBy, lost, freezes }) {
  const engine = hardware === undefined ? '' : hardware ? ' (hardware)' : ' (software)';
  const parts = [`${width}×${height}`, `${Math.round(fps)} fps`, `${mbps.toFixed(1)} Mbps`, `${codec}${engine}`];
  if (limitedBy && limitedBy !== 'none') parts.push(`limitado por ${limitedBy === 'cpu' ? 'CPU' : 'rede'}`);
  if (lost) parts.push(`${lost} pacotes perdidos`);
  if (freezes) parts.push(`${freezes} travadas`);
  return { line: parts.join('  ·  '), implementation };
}

function describeLevel(level) {
  if (level === null) return 'sem áudio';
  return level > SILENCE_LEVEL ? `${Math.ceil(level * 100)}%` : 'silêncio';
}

function renderAudioWarning(remoteHasNoAudio = false) {
  const sendingWithoutAudio = call.sharing && !call.sharingAudio;
  $('audio-warning').hidden = !sendingWithoutAudio && !remoteHasNoAudio;
  $('reshare').hidden = !sendingWithoutAudio;
  $('audio-warning-text').textContent = sendingWithoutAudio
    ? 'Você está compartilhando sem áudio.'
    : 'A outra pessoa está compartilhando sem áudio.';
}

function renderStats(stats) {
  renderStatus(call.status, stats?.route);
  renderAudioWarning(stats?.audioIn === null);
  if (!stats) {
    $('stats').textContent = '';
    return;
  }
  const lines = [];
  for (const [label, stream] of [['Enviando', stats.send], ['Recebendo', stats.receive]]) {
    if (!stream) continue;
    const { line, implementation } = describeStream(stream);
    lines.push(`${label}: ${line}`);
    if (implementation) lines.push(`  ${implementation}`);
  }
  if (stats.audioOut !== undefined) lines.push(`Áudio enviado: ${describeLevel(stats.audioOut)}`);
  if (stats.audioIn !== undefined) lines.push(`Áudio recebido: ${describeLevel(stats.audioIn)}`);
  $('stats').textContent = lines.join('\n') || 'Sem vídeo no momento.';
}

async function showRemote(stream) {
  const video = $('remote');
  peerSharing = Boolean(stream);
  video.hidden = !stream;
  renderPlaceholder();
  if (!stream) {
    video.srcObject = null;
    $('unmute').hidden = true;
    return;
  }
  if (video.srcObject === stream) return;
  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    if (err.name === 'NotAllowedError') $('unmute').hidden = false;
  }
}

function showLocal(stream) {
  $('local').srcObject = stream;
  $('local').hidden = !stream;
  $('share').textContent = stream ? 'Parar de compartilhar' : 'Compartilhar tela';
  $('share').classList.toggle('danger', Boolean(stream));
  $('codec').disabled = Boolean(stream);
  $('shared-sound').disabled = Boolean(stream);
  renderPlaceholder();
  renderAudioWarning();
}

async function toggleShare() {
  if (call.sharing) {
    call.stopShare();
    return;
  }
  $('share').disabled = true;
  toast('Para ir com som: escolha Tela inteira e ligue o áudio do sistema, que vem desligado.');
  try {
    await call.startShare();
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast(`Não deu para compartilhar: ${err.message}`);
  } finally {
    $('share').disabled = false;
  }
}

function shareAgainWithAudio() {
  call.stopShare();
  toggleShare();
}

async function toggleMic() {
  const on = $('mic').getAttribute('aria-pressed') !== 'true';
  $('mic').disabled = true;
  try {
    await call.setMic(on);
    $('mic').setAttribute('aria-pressed', String(on));
    $('mic').textContent = on ? 'Desligar microfone' : 'Ligar microfone';
  } catch (err) {
    toast(`Não deu para ligar o microfone: ${err.message}`);
  } finally {
    $('mic').disabled = false;
  }
}

async function copyLink() {
  await navigator.clipboard.writeText(location.href);
  toast('Link copiado.');
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen();
}

function bindControls() {
  $('share').onclick = toggleShare;
  $('reshare').onclick = shareAgainWithAudio;
  $('mic').onclick = toggleMic;
  $('copy-link').onclick = copyLink;
  $('fullscreen').onclick = toggleFullscreen;
  $('stage').ondblclick = toggleFullscreen;
  $('unmute').onclick = () => {
    $('unmute').hidden = true;
    $('remote').play();
  };
  $('toggle-stats').onclick = () => {
    const shown = $('stats').hidden;
    $('stats').hidden = !shown;
    $('toggle-stats').setAttribute('aria-pressed', String(shown));
  };
  $('volume').oninput = (event) => { $('remote').volume = event.target.value; };
  $('voice-volume').oninput = (event) => { $('voice').volume = event.target.value; };
  $('local').onresize = () => call.refreshEncoding();

  $('resolution').onchange = (event) => call.setQuality({ resolution: event.target.value });
  $('fps').onchange = (event) => call.setQuality({ fps: Number(event.target.value) });
  $('hint').onchange = (event) => call.setQuality({ hint: event.target.value });
  $('codec').onchange = (event) => call.setQuality({ codec: event.target.value });
  $('shared-sound').onchange = (event) => call.setQuality({ excludeChrome: event.target.value === 'without-chrome' });
}

function enterRoom(room) {
  $('home').hidden = true;
  $('room').hidden = false;

  call = new Call(room);
  call.addEventListener('status', ({ detail }) => renderStatus(detail));
  call.addEventListener('stats', ({ detail }) => renderStats(detail));
  call.addEventListener('local-share', ({ detail }) => showLocal(detail));
  call.addEventListener('remote-share', ({ detail }) => showRemote(detail));
  call.addEventListener('remote-voice', ({ detail }) => { $('voice').srcObject = detail; });
  bindControls();
  renderPlaceholder();
  call.connect();
}

function checkBrowser() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return 'Este navegador não compartilha tela, mas consegue assistir.';
  }
  if (!navigator.userAgentData) {
    return 'Use Chrome ou Edge: só eles enviam o áudio do sistema.';
  }
  return null;
}

function init() {
  const room = location.hash.slice(1);
  const warning = checkBrowser();
  if (warning) {
    $('home-warning').textContent = warning;
    $('home-warning').hidden = false;
  }

  if (ROOM_ID.test(room)) {
    $('home-text').textContent = 'Você foi convidado para uma sala.';
    $('enter').textContent = 'Entrar na sala';
    $('enter').onclick = () => enterRoom(room);
  } else {
    $('enter').onclick = () => {
      const created = newRoomId();
      history.replaceState(null, '', `#${created}`);
      enterRoom(created);
    };
  }
}

addEventListener('hashchange', () => location.reload());
init();
