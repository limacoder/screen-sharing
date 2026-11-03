import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tuneRemoteSdp } from '../public/sdp.js';

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 VP9/90000',
  'a=fmtp:98 profile-id=0',
  'a=rtpmap:99 red/90000',
  'a=rtpmap:100 ulpfec/90000',
  'a=rtpmap:101 flexfec-03/90000',
  'a=fmtp:101 repair-window=10000000',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=mid:2',
  'a=sctp-port:5000',
  '',
].join('\r\n');

const fmtpOf = (sdp, payload) => sdp.split('\r\n').filter((line) => line.startsWith(`a=fmtp:${payload} `));

test('liga estéreo e bitrate alto no Opus sem perder o que já estava lá', () => {
  assert.deepEqual(fmtpOf(tuneRemoteSdp(SDP), 111), [
    'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000',
  ]);
});

test('acrescenta os bitrates aos codecs de vídeo que já têm fmtp', () => {
  assert.deepEqual(fmtpOf(tuneRemoteSdp(SDP), 98), [
    'a=fmtp:98 profile-id=0;x-google-start-bitrate=8000;x-google-max-bitrate=60000',
  ]);
});

test('cria o fmtp logo depois do rtpmap para codec que não tinha nenhum', () => {
  const lines = tuneRemoteSdp(SDP).split('\r\n');
  const rtpmap = lines.indexOf('a=rtpmap:96 VP8/90000');
  assert.equal(lines[rtpmap + 1], 'a=fmtp:96 x-google-start-bitrate=8000;x-google-max-bitrate=60000');
});

test('não mexe em codecs auxiliares nem em seções sem mídia', () => {
  const tuned = tuneRemoteSdp(SDP);
  assert.deepEqual(fmtpOf(tuned, 97), ['a=fmtp:97 apt=96']);
  assert.deepEqual(fmtpOf(tuned, 63), ['a=fmtp:63 111/111']);
  assert.deepEqual(fmtpOf(tuned, 99), []);
  assert.deepEqual(fmtpOf(tuned, 100), []);
  assert.deepEqual(fmtpOf(tuned, 101), ['a=fmtp:101 repair-window=10000000']);
  assert.ok(tuned.endsWith('a=mid:2\r\na=sctp-port:5000\r\n'));
});

test('o mesmo número de payload em seções diferentes é tratado por seção', () => {
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 96',
    'a=rtpmap:96 opus/48000/2',
    'a=fmtp:96 useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=rtpmap:96 VP9/90000',
    'a=fmtp:96 profile-id=0',
    '',
  ].join('\r\n');
  assert.deepEqual(fmtpOf(tuneRemoteSdp(sdp), 96), [
    'a=fmtp:96 useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000',
    'a=fmtp:96 profile-id=0;x-google-start-bitrate=8000;x-google-max-bitrate=60000',
  ]);
});
