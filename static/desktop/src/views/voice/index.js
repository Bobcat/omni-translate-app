import { iconMarkup } from '../../shared/icons.js';

// Voice translation view — UI shell only (no backend wiring yet). Layout:
// language bar on top, source/target panes side by side, action bar below.

export function createVoiceView() {
  const container = document.createElement('div');
  container.className = 'view voice-view';
  container.innerHTML = `
    <div class="voice-languagebar">
      <button type="button" class="language-pill" id="voiceSourceLanguage" disabled>Dutch</button>
      <button type="button" class="language-swap" id="voiceSwapLanguages" aria-label="Swap direction" title="Swap direction" disabled>
        ${iconMarkup('swap')}
      </button>
      <button type="button" class="language-pill" id="voiceTargetLanguage" disabled>English</button>
      <span class="vad-badge" id="voiceVadBadge" hidden>Speech detected</span>
    </div>
    <div class="voice-panes">
      <article class="pane source-pane">
        <div class="text-stream" id="voiceSourceText" data-empty="No speech recognized yet"></div>
      </article>
      <article class="pane target-pane">
        <div class="text-stream" id="voiceTargetText" data-empty="No translation yet"></div>
      </article>
    </div>
    <div class="voice-actionbar">
      <button type="button" class="action-round" id="voiceTranslateNow" aria-label="Translate now" title="Translate now" disabled>
        ${iconMarkup('languages')}
      </button>
      <button type="button" class="action-round primary" id="voiceMicToggle" aria-label="Start microphone" title="Start microphone" disabled>
        ${iconMarkup('mic')}
      </button>
      <button type="button" class="action-round" id="voiceSpeakNow" aria-label="Speak now" title="Speak now" disabled>
        ${iconMarkup('volume-2')}
      </button>
    </div>
    <p class="preview-note">UI preview — not wired to the backend yet.</p>
  `;
  return container;
}
