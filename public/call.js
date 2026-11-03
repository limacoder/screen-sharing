import { tuneRemoteSdp } from './sdp.js';

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000];
const STATS_INTERVAL_MS = 1000;
const SHARE_AUDIO_BITRATE = 256_000;
const VOICE_BITRATE = 64_000;

export const RESOLUTIONS = {
  auto: null,
  2160: { width: 3840, height: 2160 },
  1440: { width: 2560, height: 1440 },
  1080: { width: 1920, height: 1080 },
  720: { width: 1280, height: 720 },
};

const CODECS = {
  AV1: { mime: 'video/AV1' },
  VP9: { mime: 'video/VP9', fmtp: 'profile-id=0' },
  H264: { mime: 'video/H264', fmtp: 'packetization-mode=1;profile-level-id=42e01f' },
};

const BANNED_MIME = 'video/H265';
const HARDWARE_ORDER = ['AV1', 'VP9', 'H264'];
const SOFTWARE_ORDER = ['VP9', 'AV1', 'H264'];

function matchesCodec(capability, name) {
  const { mime, fmtp } = CODECS[name];
  return capability.mimeType === mime && (!fmtp || capability.sdpFmtpLine?.includes(fmtp));
}

async function isHardware(name, width, height, framerate) {
  const { mime, fmtp } = CODECS[name];
  const video = {
    contentType: fmtp ? `${mime};${fmtp}` : mime,
    width,
    height,
    framerate,
    bitrate: maxBitrateFor(width, height, framerate),
  };
  const info = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video }).catch(() => null);
  return Boolean(info?.supported && info.powerEfficient);
}

async function rankCodecs(choice, width, height, fps) {
  const hardware = [];
  for (const name of HARDWARE_ORDER) {
    if (await isHardware(name, width, height, fps)) hardware.push(name);
  }
  const order = [...new Set([
    ...(choice === 'auto' ? [] : [choice]),
    ...hardware,
    ...SOFTWARE_ORDER,
  ])];
  const codecs = RTCRtpReceiver.getCapabilities('video').codecs.filter((c) => c.mimeType !== BANNED_MIME);
  const preferred = order.flatMap((name) => codecs.filter((c) => matchesCodec(c, name)));
  return [...preferred, ...codecs.filter((c) => !preferred.includes(c))];
}

function maxBitrateFor(width, height, fps) {
  const pixelsPerSecond = width * height * fps;
  return Math.round(12e6 * (pixelsPerSecond / (1920 * 1080 * 60)) ** 0.87);
}

function physicalScreen() {
  return {
    width: Math.round(screen.width * devicePixelRatio),
    height: Math.round(screen.height * devicePixelRatio),
  };
}

export class Call extends EventTarget {
  #room;
  #id = crypto.randomUUID();
  #ws = null;
  #retries = 0;
  #iceServers = [];
  #peer = null;
  #share = null;
  #mic = null;
  #codecs = [];
  #quality = { resolution: 'auto', fps: 60, hint: 'motion', codec: 'auto', excludeChrome: false };
  #previousStats = new Map();
  status = { signaling: 'connecting', peer: 'none' };

  constructor(room) {
    super();
    this.#room = room;
    addEventListener('pagehide', () => this.#dropPeer());
  }

  connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws`);
    this.#ws = ws;
    ws.onopen = () => {
      this.#retries = 0;
      ws.send(JSON.stringify({ type: 'join', room: this.#room, clientId: this.#id }));
    };
    ws.onmessage = (event) => this.#onSignal(JSON.parse(event.data));
    ws.onclose = () => {
      if (this.status.signaling !== 'full') this.#setStatus({ signaling: 'connecting' });
      const delay = RECONNECT_DELAYS_MS[Math.min(this.#retries++, RECONNECT_DELAYS_MS.length - 1)];
      setTimeout(() => this.connect(), delay);
    };
  }

  get sharing() {
    return Boolean(this.#share);
  }

  get sharingAudio() {
    return Boolean(this.#share?.getAudioTracks().length);
  }

  async startShare() {
    const { fps, hint, codec, excludeChrome } = this.#quality;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
        suppressLocalAudioPlayback: false,
        restrictOwnAudio: excludeChrome,
      },
      systemAudio: 'include',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'include',
    });
    const [video] = stream.getVideoTracks();
    video.contentHint = hint;
    video.onended = () => this.stopShare();

    const { width, height } = video.getSettings();
    this.#codecs = await rankCodecs(codec, width, height, fps);
    this.#share = stream;
    this.#syncSenders();
    this.#emit('local-share', stream);
  }

  stopShare() {
    if (!this.#share) return;
    this.#share.getTracks().forEach((track) => track.stop());
    this.#share = null;
    this.#syncSenders();
    this.#emit('local-share', null);
  }

  async setMic(on) {
    if (on) {
      this.#mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } else {
      this.#mic?.getTracks().forEach((track) => track.stop());
      this.#mic = null;
    }
    this.#syncSenders();
  }

  setQuality(changes) {
    Object.assign(this.#quality, changes);
    const video = this.#share?.getVideoTracks()[0];
    if (!video) return;
    video.contentHint = this.#quality.hint;
    const { fps } = this.#quality;
    video.applyConstraints({ frameRate: { ideal: fps, max: fps } }).catch(() => {});
    this.refreshEncoding();
  }

  refreshEncoding() {
    const sender = this.#peer?.tx.video?.sender;
    const video = this.#share?.getVideoTracks()[0];
    if (!sender?.track || !video) return;

    const { width, height } = video.getSettings();
    const { resolution, fps } = this.#quality;
    const limit = RESOLUTIONS[resolution] ?? this.#peer.screen ?? { width, height };
    const scale = Math.max(1, width / limit.width, height / limit.height);

    const parameters = sender.getParameters();
    Object.assign(parameters.encodings[0], {
      scaleResolutionDownBy: scale,
      maxFramerate: fps,
      maxBitrate: maxBitrateFor(width / scale, height / scale, fps),
    });
    sender.setParameters(parameters).catch((err) => console.error('setParameters', err));
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #setStatus(changes) {
    Object.assign(this.status, changes);
    this.#emit('status', this.status);
  }

  #signal(data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ type: 'signal', data }));
    }
  }

  #onSignal(message) {
    switch (message.type) {
      case 'joined':
        this.#iceServers = message.iceServers;
        this.#setStatus({ signaling: 'open' });
        if (this.#peer && this.#peer.pc.connectionState !== 'connected') this.#rejoin();
        else if (message.peerId) this.#ensurePeer(message.peerId);
        break;
      case 'peer-joined':
        this.#ensurePeer(message.peerId);
        break;
      case 'peer-left':
        this.#onPeerLeft(message.peerId);
        break;
      case 'signal':
        if (message.from === this.#peer?.id) this.#onRemoteDescription(message.data);
        break;
      case 'full':
        this.#setStatus({ signaling: 'full' });
        break;
    }
  }

  #ensurePeer(peerId) {
    const peer = this.#peer;
    if (peer?.id === peerId) {
      peer.online = true;
      return;
    }
    this.#dropPeer();
    this.#createPeer(peerId);
  }

  #onPeerLeft(peerId) {
    const peer = this.#peer;
    if (peer?.id !== peerId) return;
    peer.online = false;
    if (['new', 'connecting'].includes(peer.pc.connectionState)) this.#dropPeer();
  }

  #rejoin() {
    this.#dropPeer();
    this.#id = crypto.randomUUID();
    this.#ws.close();
  }

  #createPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers, bundlePolicy: 'max-bundle' });
    const peer = {
      id,
      pc,
      polite: this.#id < id,
      online: true,
      makingOffer: false,
      ignoreOffer: false,
      settingAnswer: false,
      restarted: false,
      screen: null,
      remoteShare: null,
      channel: null,
      tx: {},
      shareStream: new MediaStream(),
      voiceStream: new MediaStream(),
      statsTimer: setInterval(() => this.#readStats(peer), STATS_INTERVAL_MS),
    };
    this.#peer = peer;

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.#signal({ description: pc.localDescription });
      } catch (err) {
        console.error('negociação', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.#signal({ candidate });
    };
    pc.onconnectionstatechange = () => this.#onConnectionState(peer);
    pc.ontrack = ({ streams: [stream] }) => {
      const event = stream.getVideoTracks().length ? 'remote-share' : 'remote-voice';
      if (event === 'remote-share') peer.remoteShare = stream;
      this.#emit(event, stream);
      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) this.#emit(event, null);
      };
    };

    if (peer.polite) pc.ondatachannel = ({ channel }) => this.#wireChannel(peer, channel);
    else this.#wireChannel(peer, pc.createDataChannel('control'));

    this.#setStatus({ peer: 'connecting' });
    this.#syncSenders();
  }

  #wireChannel(peer, channel) {
    peer.channel = channel;
    const announceScreen = () => channel.send(JSON.stringify({ screen: physicalScreen() }));
    if (channel.readyState === 'open') announceScreen();
    else channel.onopen = announceScreen;
    channel.onmessage = (event) => {
      peer.screen = JSON.parse(event.data).screen;
      this.refreshEncoding();
    };
    channel.onclose = () => {
      if (this.#peer === peer) this.#dropPeer();
    };
  }

  #onConnectionState(peer) {
    if (this.#peer !== peer) return;
    const state = peer.pc.connectionState;
    if (state === 'connected') {
      peer.restarted = false;
      this.#setStatus({ peer: 'connected' });
    } else if (state === 'disconnected') {
      this.#setStatus({ peer: 'connecting' });
    } else if (state === 'failed') {
      if (!peer.online) {
        this.#dropPeer();
      } else if (peer.restarted) {
        this.#setStatus({ peer: 'failed' });
      } else {
        peer.restarted = true;
        peer.pc.restartIce();
      }
    }
  }

  #dropPeer() {
    const peer = this.#peer;
    if (!peer) return;
    this.#peer = null;
    clearInterval(peer.statsTimer);
    peer.pc.close();
    this.#previousStats.clear();
    this.#setStatus({ peer: 'none' });
    this.#emit('remote-share', null);
    this.#emit('remote-voice', null);
    this.#emit('stats', null);
  }

  async #onRemoteDescription({ description, candidate }) {
    const peer = this.#peer;
    const { pc } = peer;
    try {
      if (description) {
        const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
        peer.ignoreOffer = !peer.polite && description.type === 'offer' && !ready;
        if (peer.ignoreOffer) return;

        peer.settingAnswer = description.type === 'answer';
        await pc.setRemoteDescription({ type: description.type, sdp: tuneRemoteSdp(description.sdp) })
          .finally(() => { peer.settingAnswer = false; });
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.#signal({ description: pc.localDescription });
        }
      } else if (candidate) {
        await pc.addIceCandidate(candidate);
      }
    } catch (err) {
      if (!peer.ignoreOffer && this.#peer === peer) console.error('sinalização', err);
    }
  }

  #syncSenders() {
    if (!this.#peer) return;
    this.#assign('video', this.#share?.getVideoTracks()[0]);
    this.#assign('audio', this.#share?.getAudioTracks()[0]);
    this.#assign('voice', this.#mic?.getAudioTracks()[0]);
    this.refreshEncoding();
  }

  #assign(slot, track = null) {
    const peer = this.#peer;
    if (!track && !peer.tx[slot]) return;

    peer.tx[slot] ??= this.#createTransceiver(slot);
    const transceiver = peer.tx[slot];
    if (slot === 'video' && track) transceiver.setCodecPreferences(this.#codecs);
    transceiver.sender.replaceTrack(track).catch((err) => console.error('replaceTrack', err));
    transceiver.direction = track ? 'sendonly' : 'inactive';
  }

  #createTransceiver(slot) {
    const peer = this.#peer;
    const options = {
      video: {
        kind: 'video',
        stream: peer.shareStream,
        encoding: { scalabilityMode: 'L1T1' },
      },
      audio: { kind: 'audio', stream: peer.shareStream, encoding: { maxBitrate: SHARE_AUDIO_BITRATE } },
      voice: { kind: 'audio', stream: peer.voiceStream, encoding: { maxBitrate: VOICE_BITRATE } },
    }[slot];
    return peer.pc.addTransceiver(options.kind, {
      direction: 'inactive',
      streams: [options.stream],
      sendEncodings: [options.encoding],
    });
  }

  async #readStats(peer) {
    if (this.#peer !== peer || peer.pc.connectionState !== 'connected') return;
    const report = await peer.pc.getStats();
    if (this.#peer !== peer) return;

    const shareAudioId = this.#share?.getAudioTracks()[0]?.id;
    const remoteAudioId = peer.remoteShare?.getAudioTracks()[0]?.id;
    const level = (trackId, stat) => (trackId ? stat?.audioLevel ?? 0 : null);

    let outbound, inbound, pair, audioOut, audioIn;
    report.forEach((stat) => {
      if (stat.kind === 'video' && stat.type === 'outbound-rtp') outbound = stat;
      else if (stat.kind === 'video' && stat.type === 'inbound-rtp') inbound = stat;
      else if (stat.type === 'media-source' && stat.trackIdentifier === shareAudioId) audioOut = stat;
      else if (stat.type === 'inbound-rtp' && stat.trackIdentifier === remoteAudioId) audioIn = stat;
      else if (stat.type === 'transport' && stat.selectedCandidatePairId) {
        pair = report.get(stat.selectedCandidatePairId);
      }
    });

    this.#emit('stats', {
      route: pair && this.#describeRoute(report, pair),
      send: this.#share && outbound ? this.#describeStream(report, outbound, outbound.bytesSent) : null,
      receive: inbound?.framesPerSecond ? this.#describeStream(report, inbound, inbound.bytesReceived) : null,
      audioOut: this.#share ? level(shareAudioId, audioOut) : undefined,
      audioIn: peer.remoteShare?.getTracks().length ? level(remoteAudioId, audioIn) : undefined,
    });
  }

  #describeRoute(report, pair) {
    const local = report.get(pair.localCandidateId);
    const remote = report.get(pair.remoteCandidateId);
    return {
      relayed: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
      rttMs: pair.currentRoundTripTime === undefined ? null : Math.round(pair.currentRoundTripTime * 1000),
    };
  }

  #describeStream(report, stat, bytes) {
    const previous = this.#previousStats.get(stat.id);
    this.#previousStats.set(stat.id, { bytes, timestamp: stat.timestamp });
    const seconds = previous ? (stat.timestamp - previous.timestamp) / 1000 : 0;
    return {
      width: stat.frameWidth,
      height: stat.frameHeight,
      fps: stat.framesPerSecond ?? 0,
      mbps: seconds > 0 ? ((bytes - previous.bytes) * 8) / seconds / 1e6 : 0,
      codec: report.get(stat.codecId)?.mimeType.replace('video/', ''),
      implementation: stat.encoderImplementation ?? stat.decoderImplementation,
      hardware: stat.powerEfficientEncoder ?? stat.powerEfficientDecoder,
      limitedBy: stat.qualityLimitationReason,
      lost: stat.packetsLost,
      freezes: stat.freezeCount,
    };
  }
}
