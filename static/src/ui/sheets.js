// Bottom-sheet UI: the swipe-down-to-close gesture (reusable) and the
// language picker sheet (open/close + render list).
//
// The picker calls a registered handler when the user taps a language,
// so this module stays free of app-level concerns (lane state, render
// orchestration). App.js registers the handler at init.

import { els } from '../els.js';
import { state } from '../state.js';
import { languages, flagForLanguage } from '../shared/languages.js';
import { getRecentLanguages, pushRecentLanguage } from '../shared/storage.js';
import { currentLane } from '../shared/lanes.js';

let _languageSheetSide = 'source';
let _skipLanguagePopstate = false;
let _onLanguagePick = () => {};

export function setLanguagePickHandler(handler) {
  _onLanguagePick = typeof handler === 'function' ? handler : () => {};
}

// Wires the in-sheet search input. Open/close listeners on the pills stay
// in app.js since the pills live outside the sheet.
export function initLanguageSheetSearch() {
  els.languageSearch.addEventListener('input', () => {
    const lane = currentLane();
    const currentLang = _languageSheetSide === 'source' ? lane.sourceLanguage : lane.targetLanguage;
    renderLanguageSheetList(currentLang, els.languageSearch.value.trim());
  });
}

// True (and reset) once if a programmatic history.back() from
// closeLanguageSheet caused this popstate. app.js's popstate handler
// uses this to skip its language-sheet branch.
export function consumeLanguagePopstateSkip() {
  if (_skipLanguagePopstate) {
    _skipLanguagePopstate = false;
    return true;
  }
  return false;
}

export function openLanguageSheet(side) {
  _languageSheetSide = side;
  const lane = currentLane();
  const currentLang = side === 'source' ? lane.sourceLanguage : lane.targetLanguage;
  els.languageSheetTitle.textContent = side === 'source' ? 'Source language' : 'Target language';
  els.languageSearch.value = '';
  renderLanguageSheetList(currentLang, '');
  els.languageSheet.hidden = false;
  if (history.state?.view !== 'languageSheet') {
    history.pushState({ view: 'languageSheet' }, '');
  }
}

export function closeLanguageSheet() {
  const wasOpen = !els.languageSheet.hidden;
  els.languageSheet.hidden = true;
  els.languageSearch.value = '';
  _resetLanguageSheetPosition();
  if (wasOpen && history.state?.view === 'languageSheet') {
    _skipLanguagePopstate = true;
    history.back();
  }
}

export function setupSheetSwipeClose({ layer, sheet, scrollContainer, onClose, isAllowed }) {
  if (!layer || !sheet) return;
  const SWIPE_CLOSE_THRESHOLD_PCT = 0.40;
  let startY = null;
  let startScrollTop = 0;
  let dragging = false;
  let currentDelta = 0;
  let sheetHeight = 0;
  const onStart = (e) => {
    if (layer.hidden) return;
    if (e.touches.length !== 1) return;
    if (isAllowed && !isAllowed()) return;
    startY = e.touches[0].clientY;
    startScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    sheetHeight = sheet.getBoundingClientRect().height || 0;
    dragging = false;
    currentDelta = 0;
  };
  const onMove = (e) => {
    if (startY === null) return;
    const y = e.touches[0].clientY;
    const delta = y - startY;
    if (delta <= 0) return;
    if (startScrollTop > 0) return;
    if (scrollContainer && scrollContainer.scrollTop > 0) {
      sheet.style.removeProperty('transform');
      sheet.style.removeProperty('transition');
      dragging = false;
      return;
    }
    dragging = true;
    currentDelta = delta;
    // !important needed to beat the entry animation's fill-mode:both,
    // which otherwise keeps "transform: translateY(0)" pinned.
    sheet.style.setProperty('transition', 'none', 'important');
    sheet.style.setProperty('transform', `translateY(${delta}px)`, 'important');
    e.preventDefault();
  };
  const onEnd = () => {
    if (dragging) {
      const threshold = Math.max(40, sheetHeight * SWIPE_CLOSE_THRESHOLD_PCT);
      if (currentDelta > threshold) {
        // Animate the layer opacity together with the sheet so the scrim
        // fades instead of popping when we hide it.
        sheet.style.setProperty('transition', 'transform 0.18s ease', 'important');
        sheet.style.setProperty('transform', 'translateY(100%)', 'important');
        layer.style.setProperty('transition', 'opacity 0.18s ease', 'important');
        layer.style.setProperty('opacity', '0', 'important');
        setTimeout(() => {
          onClose();
          sheet.style.removeProperty('transform');
          sheet.style.removeProperty('transition');
          layer.style.removeProperty('opacity');
          layer.style.removeProperty('transition');
        }, 170);
      } else {
        sheet.style.setProperty('transition', 'transform 0.18s ease', 'important');
        sheet.style.setProperty('transform', 'translateY(0)', 'important');
        // Clear inline after the snap-back transition completes so the
        // entry animation can take over again on next open.
        setTimeout(() => {
          sheet.style.removeProperty('transform');
          sheet.style.removeProperty('transition');
        }, 200);
      }
    }
    startY = null;
    dragging = false;
    currentDelta = 0;
  };
  sheet.addEventListener('touchstart', onStart, { passive: true });
  sheet.addEventListener('touchmove', onMove, { passive: false });
  sheet.addEventListener('touchend', onEnd);
  sheet.addEventListener('touchcancel', onEnd);
}

function _resetLanguageSheetPosition() {
  const sheet = els.languageSheet.querySelector('.bottom-sheet');
  if (!sheet) return;
  sheet.style.marginBottom = '';
  sheet.style.height = '';
}

export function onLanguageSheetViewportResize() {
  if (els.languageSheet.hidden) return;
  const vv = window.visualViewport;
  if (!vv) return;
  const kbHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  const sheet = els.languageSheet.querySelector('.bottom-sheet');
  if (!sheet) return;
  if (kbHeight > 50) {
    sheet.style.marginBottom = `${kbHeight}px`;
    sheet.style.height = `${vv.height}px`;
  } else {
    _resetLanguageSheetPosition();
  }
}

export function renderLanguageSheetList(currentLang, query) {
  const fragment = document.createDocumentFragment();
  const q = query.toLowerCase();

  if (q) {
    const filtered = languages.filter((l) => l.name.toLowerCase().includes(q));
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'language-option-empty';
      empty.textContent = 'No languages found';
      fragment.appendChild(empty);
    } else {
      for (const item of filtered) fragment.appendChild(_languageRow(item, currentLang));
    }
  } else {
    const recentNames = getRecentLanguages().filter((n) => languages.some((l) => l.name === n));
    if (recentNames.length) {
      fragment.appendChild(_sectionHeader('Recent'));
      for (const name of recentNames) {
        const item = languages.find((l) => l.name === name);
        if (item) fragment.appendChild(_languageRow(item, currentLang));
      }
    }
    const groups = {};
    for (const item of languages) {
      const letter = item.name[0].toUpperCase();
      (groups[letter] = groups[letter] || []).push(item);
    }
    for (const letter of Object.keys(groups).sort()) {
      fragment.appendChild(_sectionHeader(letter));
      for (const item of groups[letter]) fragment.appendChild(_languageRow(item, currentLang));
    }
  }

  els.languageSheetList.replaceChildren(fragment);
}

function _sectionHeader(label) {
  const el = document.createElement('div');
  el.className = 'language-section-header';
  el.textContent = label;
  return el;
}

function _languageRow(item, currentLang) {
  const isActive = item.name === currentLang;
  const row = document.createElement('button');
  row.className = `language-option-row${isActive ? ' is-active' : ''}`;
  row.type = 'button';
  row.innerHTML = `<span>${flagForLanguage(item.name)} ${item.name}</span>${isActive ? '<svg class="language-option-check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}`;
  row.addEventListener('click', () => {
    pushRecentLanguage(item.name);
    _onLanguagePick(_languageSheetSide, item.name);
    closeLanguageSheet();
  });
  return row;
}
