import { iconMarkup } from '../../shared/icons.js';
import { populateLanguageSelect, recordLanguageMru } from '../../shared/languages.js';
import { translateText } from '../../shared/api.js?v=20260902-credits-23';
import { publishViewBusy } from '../../shared/view-activity.js?v=20260829-voice-modes-11';
import { guessSetupLanguages } from '../../../../src/domain/languages.js';
import { loadSetupLanguages, persistSetupLanguages } from '../../../../src/domain/storage.js?v=20260829-voice-modes-11';
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
const MIN_PANE_HEIGHT = 280;
const TRAILING_BLANK_LINES = 4;
const VIEWPORT_BOTTOM_MARGIN = 12;
const RESIZE_CORNER_SIZE = 24;

export function nextTextSwapState({
  sourceLanguage,
  targetLanguage,
  sourceText,
  targetText,
}) {
  const existingTargetText = String(targetText || '');
  return {
    sourceLanguage: String(targetLanguage || ''),
    targetLanguage: String(sourceLanguage || ''),
    sourceText: existingTargetText || String(sourceText || ''),
    promotedTargetText: Boolean(existingTargetText),
  };
}

export function createTextView() {
  const container = document.createElement('div');
  container.className = 'view text-view';
  container.innerHTML = `
    <h1 class="visually-hidden">Text translation</h1>
    <div class="view-toolbar">
      <div class="language-pair">
        <button type="button" id="textSource" aria-label="Choose source language"></button>
        <button type="button" class="language-swap" id="textSwapLanguages" aria-label="Swap direction" title="Swap direction">
          ${iconMarkup('swap')}
        </button>
        <button type="button" id="textTarget" aria-label="Choose target language"></button>
      </div>
    </div>
    <div class="text-panes" id="textPanes">
      <article class="pane text-pane">
        <textarea class="text-input" id="textInput" placeholder="Type or paste text to translate" aria-label="Source text"></textarea>
        <div class="text-pane-actions">
          <output class="text-character-count" id="textCharacterCount" for="textInput" hidden></output>
        </div>
      </article>
      <article class="pane text-pane">
        <div class="text-output" id="textOutput" data-empty="Translation appears here"></div>
        <div class="text-pane-actions">
          <button type="button" class="icon-square-btn" id="textCopy" title="Copy translation" aria-label="Copy translation" hidden>
            ${iconMarkup('copy')}
          </button>
        </div>
      </article>
    </div>
    <div class="status-line" id="textStatus" role="status"></div>
    <div class="text-height-measure" id="textSourceHeightMeasure" aria-hidden="true"></div>
    <div class="text-height-measure" id="textTargetHeightMeasure" aria-hidden="true"></div>
  `;

  const sourceSelect = container.querySelector('#textSource');
  const targetSelect = container.querySelector('#textTarget');
  const swapBtn = container.querySelector('#textSwapLanguages');
  const copyBtn = container.querySelector('#textCopy');
  const panes = container.querySelector('#textPanes');
  const paneElements = [...container.querySelectorAll('.text-pane')];
  const inputEl = container.querySelector('#textInput');
  const outputEl = container.querySelector('#textOutput');
  const statusEl = container.querySelector('#textStatus');
  const characterCountEl = container.querySelector('#textCharacterCount');
  const sourceHeightMeasure = container.querySelector('#textSourceHeightMeasure');
  const targetHeightMeasure = container.querySelector('#textTargetHeightMeasure');

  const initialLanguages = loadSetupLanguages() || guessSetupLanguages();
  populateLanguageSelect(sourceSelect, initialLanguages.source);
  populateLanguageSelect(targetSelect, initialLanguages.target);

  let debounceTimer = null;
  let ceilingTimer = null;
  let lastFireAt = 0;
  let defaultPaneHeight = null;
  let preferredPaneHeight = null;
  let paneHeightFrame = null;

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
      schedulePaneHeightSync();
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
    schedulePaneHeightSync();
  }

  function updateControls() {
    const characterCount = Array.from(inputEl.value).length;
    characterCountEl.textContent = String(characterCount);
    characterCountEl.hidden = characterCount === 0;
    characterCountEl.setAttribute(
      'aria-label', `${characterCount} ${characterCount === 1 ? 'character' : 'characters'}`,
    );
    copyBtn.hidden = !outputEl.textContent;
  }

  function contentHeight(content, measure, text) {
    const style = window.getComputedStyle(content);
    const lineHeight = Number.parseFloat(style.lineHeight) || 24;
    measure.style.width = `${content.clientWidth}px`;
    // The trailing zero-width character makes a final newline measurable.
    measure.textContent = `${text}\u200b`;
    return {
      content: Math.ceil(measure.getBoundingClientRect().height),
      trailing: lineHeight * TRAILING_BLANK_LINES,
    };
  }

  function requiredPaneHeight(pane, content, measure, text) {
    const paneStyle = window.getComputedStyle(pane);
    const actions = pane.querySelector('.text-pane-actions');
    const heights = contentHeight(content, measure, text);
    const padding = Number.parseFloat(paneStyle.paddingTop) + Number.parseFloat(paneStyle.paddingBottom);
    const gap = Number.parseFloat(paneStyle.rowGap || paneStyle.gap) || 0;
    return Math.ceil(padding + heights.content + heights.trailing + actions.offsetHeight + gap);
  }

  function availablePaneHeight() {
    const viewStyle = window.getComputedStyle(container);
    const viewRect = container.getBoundingClientRect();
    const paneRect = panes.getBoundingClientRect();
    const paneTop = paneRect.top - viewRect.top + container.scrollTop;
    const viewGap = Number.parseFloat(viewStyle.rowGap || viewStyle.gap) || 0;
    const bottomPadding = Number.parseFloat(viewStyle.paddingBottom) || 0;
    const reserved = viewGap + statusEl.offsetHeight + bottomPadding + VIEWPORT_BOTTOM_MARGIN;
    return Math.max(MIN_PANE_HEIGHT, Math.floor(container.clientHeight - paneTop - reserved));
  }

  function syncPaneHeight() {
    paneHeightFrame = null;
    if (!panes.isConnected || window.matchMedia('(max-width: 720px)').matches) return;
    if (defaultPaneHeight == null) {
      defaultPaneHeight = Math.max(MIN_PANE_HEIGHT, Math.round(panes.getBoundingClientRect().height));
    }
    const sourceRequired = requiredPaneHeight(
      paneElements[0], inputEl, sourceHeightMeasure, inputEl.value,
    );
    const targetRequired = requiredPaneHeight(
      paneElements[1], outputEl, targetHeightMeasure, outputEl.textContent,
    );
    const baseline = preferredPaneHeight ?? defaultPaneHeight;
    const required = Math.max(MIN_PANE_HEIGHT, baseline, sourceRequired, targetRequired);
    const available = availablePaneHeight();
    const next = Math.min(required, available);
    panes.style.setProperty('--text-pane-max-height', `${available}px`);
    panes.style.setProperty('--text-panes-height', `${Math.ceil(next)}px`);
    panes.classList.toggle('is-height-capped', required > available);
  }

  function schedulePaneHeightSync() {
    if (paneHeightFrame != null) return;
    paneHeightFrame = requestAnimationFrame(syncPaneHeight);
  }

  const paneResizeObserver = new ResizeObserver((entries) => {
    if (window.matchMedia('(max-width: 720px)').matches) return;
    const resized = entries.find((entry) => entry.target.style.height);
    if (resized) {
      preferredPaneHeight = Math.max(MIN_PANE_HEIGHT, Math.round(resized.target.getBoundingClientRect().height));
    }
    schedulePaneHeightSync();
  });
  paneResizeObserver.observe(container);
  for (const pane of paneElements) {
    paneResizeObserver.observe(pane);
    pane.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = pane.getBoundingClientRect();
      const inResizeCorner = event.clientX >= rect.right - RESIZE_CORNER_SIZE
        && event.clientY >= rect.bottom - RESIZE_CORNER_SIZE;
      if (!inResizeCorner) return;
      for (const item of paneElements) item.style.removeProperty('height');
      const finishResize = () => {
        window.removeEventListener('pointerup', finishResize);
        window.removeEventListener('pointercancel', finishResize);
        requestAnimationFrame(() => {
          for (const item of paneElements) item.style.removeProperty('height');
          schedulePaneHeightSync();
        });
      };
      window.addEventListener('pointerup', finishResize);
      window.addEventListener('pointercancel', finishResize);
    });
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
    schedulePaneHeightSync();
    updateControls();
    if (inputEl.value.trim().length < MIN_CHARS) {
      cancelTimers();
      runner.invalidate();
      outputEl.textContent = '';
      schedulePaneHeightSync();
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
    const next = nextTextSwapState({
      sourceLanguage: sourceSelect.value,
      targetLanguage: targetSelect.value,
      sourceText: inputEl.value,
      targetText: outputEl.textContent,
    });
    runner.invalidate();
    populateLanguageSelect(sourceSelect, next.sourceLanguage);
    populateLanguageSelect(targetSelect, next.targetLanguage);
    if (next.promotedTargetText) {
      inputEl.value = next.sourceText;
      outputEl.textContent = '';
    }
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
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(outputEl.textContent);
      setStatus('Copied to clipboard.');
    } catch {
      setStatus('Copy failed.', true);
    }
  });
  schedulePaneHeightSync();
  updateControls();
  return container;
}
