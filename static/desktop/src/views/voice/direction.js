export function visibleVoiceDirection(state) {
  if (state?.live && state.currentTurn) {
    return {
      sourceLanguage: state.currentTurn.sourceLanguage,
      targetLanguage: state.currentTurn.targetLanguage,
    };
  }
  return {
    sourceLanguage: state?.sideALanguage,
    targetLanguage: state?.sideBLanguage,
  };
}
