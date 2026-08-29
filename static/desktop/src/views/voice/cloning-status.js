export function visibleVoiceCloningStatus(state, laneId) {
  if (!state?.live || state.voiceMode !== 'speaker_clone') return null;
  const status = state.voiceCloningStatus?.[laneId];
  const cloningState = status?.state;
  if (cloningState === 'preparing') {
    const fallbackVoice = status?.fallbackVoiceMode === 'male' ? 'Male' : 'Female';
    return {
      state: 'preparing',
      text: `Learning speaker voice — using ${fallbackVoice} until enough speech is collected.`,
    };
  }
  if (cloningState === 'ready') {
    return {
      state: 'ready',
      text: 'Speaker voice ready',
    };
  }
  return null;
}

export function visibleVoiceCloningGuidance(state) {
  if (
    !state?.ttsEnabled
    || !state.voiceModeAvailable
    || state.voiceMode !== 'speaker_clone'
  ) return '';
  return 'For best results, speak clearly with as little background sound as possible. '
    + 'Music, TV, other voices or unclear speech may make the cloned voice sound less like '
    + 'the original speaker. These conditions, as well as very short translations, may '
    + 'also produce strange or unintelligible sounds.';
}
