// Language picker bottom-sheet: open / close / search / render list.
//
// The picker calls a registered handler when the user taps a language,
// so this module stays free of app-level concerns (lane state, render
// orchestration). App.js registers the handler at init.

import { els } from '../els.js';
import { languages } from '../domain/languages.js';
import { getRecentLanguages, pushRecentLanguage } from '../domain/storage.js';
import { currentLane } from '../domain/lanes.js';

let _languageSheetSide = 'source';
let _skipLanguagePopstate = false;
let _onLanguagePick = () => {};
const _languagesByName = [...languages].sort((a, b) => a.name.localeCompare(b.name, 'en'));

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
// closeLanguageSheet caused this popstate. The popstate handler in
// session/lifecycle.js uses this to skip its language-sheet branch.
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

function renderLanguageSheetList(currentLang, query) {
  const fragment = document.createDocumentFragment();
  const q = query.toLowerCase();

  if (q) {
    const filtered = _languagesByName.filter((l) => l.name.toLowerCase().includes(q));
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
    for (const item of _languagesByName) {
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
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', isActive ? 'true' : 'false');
  const label = document.createElement('span');
  label.textContent = item.name;
  row.appendChild(label);
  if (isActive) {
    row.insertAdjacentHTML('beforeend', '<svg class="language-option-check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>');
  }
  row.addEventListener('click', () => {
    pushRecentLanguage(item.name);
    _onLanguagePick(_languageSheetSide, item.name);
    closeLanguageSheet();
  });
  return row;
}
