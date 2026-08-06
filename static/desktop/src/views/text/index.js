import { iconMarkup } from '../../shared/icons.js';
import { populateLanguageSelect, recordLanguageMru } from '../../shared/languages.js';
import { translateText } from '../../shared/api.js';
import { publishViewBusy } from '../../shared/view-activity.js';
import { guessSetupLanguages } from '../../../../src/domain/languages.js';
import { loadSetupLanguages, persistSetupLanguages } from '../../../../src/domain/storage.js';
import { createTranslationRunner } from './translation-runner.js';

// Text translation view — the classic typed/pasted-text workflow. The timing
// policy lives here (debounce + ceiling, see the research note): the backend
// is a stateless one-shot endpoint that always re-translates the full current
// text. Request coordination (one in flight, newest-wins, cleanup) lives in
// translation-runner.js — DOM-less so it is testable with node:test.
//
// The shell keeps views alive across navigation: text, output and an
// in-flight request survive view switches; the sidebar entry is marked busy
// while a translation runs.

const DEBOUNCE_MS = 350;
const CEILING_MS = 1750;
const MIN_CHARS = 3;

export function createTextView() {
  const container = document.createElement('div');
  container.className = 'view text-view';
  container.innerHTML = `
    <div class="view-toolbar">
      <div class="field">
        <span>Source</span>
        <button type="button" id="textSource"></button>
      </div>
      <button type="button" class="language-swap" id="textSwapLanguages" aria-label="Swap direction" title="Swap direction">
        ${iconMarkup('swap')}
      </button>
      <div class="field">
        <span>Target</span>
        <button type="button" id="textTarget"></button>
      </div>
      <div class="toolbar-actions">
        <button type="button" class="icon-square-btn" id="textCopy" title="Copy translation" aria-label="Copy translation" hidden>
          ${iconMarkup('copy')}
        </button>
        <button type="button" class="browse-btn" id="textTranslateNow" title="Translate now (Ctrl+Enter)" disabled>Translate</button>
      </div>
    </div>
    <div class="text-panes">
      <article class="pane text-pane">
        <div class="pane-header" id="textPaneSourceLabel"></div>
        <textarea class="text-input" id="textInput" placeholder="Type or paste text to translate" aria-label="Source text"></textarea>
      </article>
      <article class="pane text-pane">
        <div class="pane-header" id="textPaneTargetLabel"></div>
        <div class="text-output" id="textOutput" data-empty="Translation appears here"></div>
      </article>
    </div>
    <div class="status-line" id="textStatus" role="status"></div>
  `;

  const sourceSelect = container.querySelector('#textSource');
  const targetSelect = container.querySelector('#textTarget');
  const swapBtn = container.querySelector('#textSwapLanguages');
  const copyBtn = container.querySelector('#textCopy');
  const translateBtn = container.querySelector('#textTranslateNow');
  const paneSourceLabel = container.querySelector('#textPaneSourceLabel');
  const paneTargetLabel = container.querySelector('#textPaneTargetLabel');
  const inputEl = container.querySelector('#textInput');
  const outputEl = container.querySelector('#textOutput');
  const statusEl = container.querySelector('#textStatus');

  const initialLanguages = loadSetupLanguages() || guessSetupLanguages();
  populateLanguageSelect(sourceSelect, initialLanguages.source);
  populateLanguageSelect(targetSelect, initialLanguages.target);

  let debounceTimer = null;
  let ceilingTimer = null;
  let lastFireAt = 0;

  const runner = createTranslationRunner({
    minChars: MIN_CHARS,
    getPayload: () => ({
      source: sourceSelect.value,
      target: targetSelect.value,
      text: inputEl.value,
    }),
    translate: translateText,
    onResult: (result) => {
      outputEl.textContent = String(result.translated_text || '');
      setStatus('');
    },
    onError: (err) => {
      setStatus(err.message || 'Translation failed.', true);
    },
    onBusy: (busy) => {
      publishViewBusy('text', busy);
      if (busy) {
        // Every dispatch cancels pending timers — including the runner's own
        // dirty refire, which does not pass through fireTranslation.
        cancelTimers();
        lastFireAt = Date.now();
        setStatus('Translating…');
      }
    },
    onStateChange: updateControls,
  });

  function persistLanguages() {
    persistSetupLanguages(sourceSelect.value, targetSelect.value);
  }

  function setStatus(message, isError = false) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  function updateControls() {
    const hasText = inputEl.value.trim().length >= MIN_CHARS;
    translateBtn.disabled = runner.isInFlight() || !hasText;
    copyBtn.hidden = !outputEl.textContent;
    paneSourceLabel.textContent = sourceSelect.value;
    paneTargetLabel.textContent = targetSelect.value;
  }

  function cancelTimers() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (ceilingTimer) {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
    }
  }

  // Debounce after the last keystroke, but never wait longer than the
  // ceiling since the previous dispatch — that is what keeps a translation
  // trickling in while the user keeps typing.
  function scheduleTranslation({ immediate = false } = {}) {
    updateControls();
    if (inputEl.value.trim().length < MIN_CHARS) {
      cancelTimers();
      runner.invalidate();
      outputEl.textContent = '';
      setStatus('');
      updateControls();
      return;
    }
    if (immediate) {
      cancelTimers();
      fireTranslation();
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      fireTranslation();
    }, DEBOUNCE_MS);
    if (!ceilingTimer) {
      const wait = Math.max(DEBOUNCE_MS, CEILING_MS - (Date.now() - lastFireAt));
      ceilingTimer = setTimeout(() => {
        ceilingTimer = null;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        fireTranslation();
      }, wait);
    }
  }

  // Dispatch goes through the runner (request state, newest-wins, cleanup);
  // the view only makes sure no pending timer fires a second request.
  function fireTranslation() {
    cancelTimers();
    runner.fire();
  }

  function swapLanguages() {
    const source = sourceSelect.value;
    populateLanguageSelect(sourceSelect, targetSelect.value);
    populateLanguageSelect(targetSelect, source);
    persistLanguages();
    scheduleTranslation({ immediate: true });
  }

  inputEl.addEventListener('input', () => scheduleTranslation());
  inputEl.addEventListener('paste', () => {
    // Let the pasted text land in the textarea first, then translate at once.
    setTimeout(() => scheduleTranslation({ immediate: true }), 0);
  });
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      fireTranslation();
    }
  });

  sourceSelect.addEventListener('change', () => {
    recordLanguageMru(sourceSelect.value);
    persistLanguages();
    scheduleTranslation({ immediate: true });
  });
  targetSelect.addEventListener('change', () => {
    recordLanguageMru(targetSelect.value);
    persistLanguages();
    scheduleTranslation({ immediate: true });
  });
  swapBtn.addEventListener('click', swapLanguages);
  translateBtn.addEventListener('click', fireTranslation);
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(outputEl.textContent);
      setStatus('Copied to clipboard.');
    } catch {
      setStatus('Copy failed.', true);
    }
  });

  updateControls();
  return container;
}
