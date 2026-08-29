// Keep iOS audio routing stable when voice translation alternates between
// microphone capture and playback. Unsupported browsers keep their defaults.

export function usesIosVoiceAudioPath(navigatorObject = globalThis.navigator) {
  const ua = String(navigatorObject?.userAgent || '');
  const platform = String(navigatorObject?.platform || '');
  return /iphone|ipad|ipod/i.test(ua)
    || (platform === 'MacIntel' && Number(navigatorObject?.maxTouchPoints || 0) > 1);
}

export function setVoiceAudioSessionCaptureActive(active, navigatorObject = globalThis.navigator) {
  const audioSession = navigatorObject?.audioSession;
  if (!audioSession) return false;
  try {
    audioSession.type = active ? 'play-and-record' : 'playback';
    return true;
  } catch {
    return false;
  }
}
