export function shouldStopMicrophoneAfterPlayback(item) {
  return item?.playbackTrigger !== 'automatic';
}
