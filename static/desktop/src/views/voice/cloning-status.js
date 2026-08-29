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
