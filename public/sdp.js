const VIDEO_PARAMS = 'x-google-start-bitrate=8000;x-google-max-bitrate=60000';
const OPUS_PARAMS = 'stereo=1;sprop-stereo=1;maxaveragebitrate=256000';
const AUXILIARY_CODEC = /^(rtx|red|ulpfec|flexfec)/i;

function tuneSection(section) {
  const isAudio = section.startsWith('m=audio');
  if (!isAudio && !section.startsWith('m=video')) return section;

  let tuned = section;
  for (const [rtpmap, payload, codec] of section.matchAll(/^a=rtpmap:(\d+) ([^/\r\n]+)\/[^\r\n]*/gm)) {
    const params = isAudio ? (codec.toLowerCase() === 'opus' ? OPUS_PARAMS : null)
      : (AUXILIARY_CODEC.test(codec) ? null : VIDEO_PARAMS);
    if (!params) continue;

    const fmtp = new RegExp(`^a=fmtp:${payload} [^\\r\\n]*`, 'm');
    tuned = fmtp.test(tuned)
      ? tuned.replace(fmtp, `$&;${params}`)
      : tuned.replace(rtpmap, `${rtpmap}\r\na=fmtp:${payload} ${params}`);
  }
  return tuned;
}

export function tuneRemoteSdp(sdp) {
  const [session, ...media] = sdp.split(/^(?=m=)/m);
  return session + media.map(tuneSection).join('');
}
