// Language picker for the desktop translation views. The list itself is the
// app's single source of truth (static/src/domain/languages.js, shared with
// the mobile app). Flag emoji follows the LLM Workbench pattern.
//
// UI-wise this is the desktop adaptation of the mobile language bottom sheet
// (search field, "Recent" section, A-Z group headers, check on the active
// language), presented as a centered modal instead of a sheet. It replaces
// the native <select>: Chromium renders that popup with fixed theme colors,
// which made the MRU divider unthemable. The picker exposes just enough of
// the <select> API for the views: host.value and 'change' events.

import { languages, flagForLanguage, normalizeLanguageName } from '../../../src/domain/languages.js';
import { iconMarkup } from './icons.js';

const MRU_STORAGE_KEY = 'omni-translate.desktop.language-mru';
const MRU_MAX = 4;

const byNameAscending = [...languages].sort((a, b) => a.name.localeCompare(b.name, 'en'));
const states = new WeakMap();

function readMru() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(MRU_STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((name) => languages.some((item) => item.name === name));
  } catch {
    return [];
  }
}

export function recordLanguageMru(name) {
  const normalized = normalizeLanguageName(name);
  const next = [normalized, ...readMru().filter((item) => item !== normalized)].slice(0, MRU_MAX);
  try {
    window.localStorage.setItem(MRU_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: MRU simply resets next load.
  }
}

function labelFor(name) {
  const flag = flagForLanguage(name);
  return flag ? `${flag} ${name}` : name;
}

function sectionHeader(label) {
  const el = document.createElement('div');
  el.className = 'language-section-header';
  el.textContent = label;
  return el;
}

function languageRow(name, currentName, onPick) {
  const isActive = name === currentName;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `language-option-row${isActive ? ' is-active' : ''}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', isActive ? 'true' : 'false');
  row.innerHTML = `<span>${labelFor(name)}</span>${isActive ? iconMarkup('check', 'language-option-check') : ''}`;
  row.addEventListener('click', () => onPick(name));
  return row;
}

function renderList(list, state, query, onPick) {
  const fragment = document.createDocumentFragment();
  const q = query.toLowerCase();
  if (q) {
    const filtered = byNameAscending.filter((language) => language.name.toLowerCase().includes(q));
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'language-option-empty';
      empty.textContent = 'No languages found';
      fragment.appendChild(empty);
    } else {
      for (const language of filtered) fragment.appendChild(languageRow(language.name, state.value, onPick));
    }
  } else {
    const mru = readMru();
    if (mru.length) {
      fragment.appendChild(sectionHeader('Recent'));
      for (const name of mru) fragment.appendChild(languageRow(name, state.value, onPick));
    }
    const groups = {};
    for (const language of byNameAscending) {
      const letter = language.name[0].toUpperCase();
      (groups[letter] = groups[letter] || []).push(language);
    }
    for (const letter of Object.keys(groups)) {
      fragment.appendChild(sectionHeader(letter));
      for (const language of groups[letter]) fragment.appendChild(languageRow(language.name, state.value, onPick));
    }
  }
  list.replaceChildren(fragment);
}

function openDialog(state) {
  if (state.dialog) return;
  const scrim = document.createElement('div');
  scrim.className = 'language-dialog-scrim';
  scrim.innerHTML = `
    <div class="language-dialog" role="dialog" aria-modal="true" aria-label="Target language">
      <div class="language-dialog-header">
        <span class="language-dialog-title">Target language</span>
        <button type="button" class="icon-square-btn language-dialog-close" aria-label="Close">${iconMarkup('x')}</button>
      </div>
      <input type="text" class="language-dialog-search" placeholder="Search languages" aria-label="Search languages">
      <div class="language-dialog-list" role="listbox"></div>
    </div>`;
  document.body.appendChild(scrim);
  state.dialog = scrim;

  // Anchor the dialog to the trigger, like a popover.
  const dialog = scrim.querySelector('.language-dialog');
  const rect = state.host.getBoundingClientRect();
  dialog.style.top = `${rect.bottom + 6}px`;
  dialog.style.left = `${Math.min(rect.left, window.innerWidth - dialog.offsetWidth - 16)}px`;

  const search = scrim.querySelector('.language-dialog-search');
  const list = scrim.querySelector('.language-dialog-list');
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeDialog(state);
    }
  };
  const pick = (name) => {
    state.value = name;
    state.host.textContent = labelFor(name);
    closeDialog(state);
    state.host.dispatchEvent(new Event('change', { bubbles: true }));
  };

  search.addEventListener('input', () => renderList(list, state, search.value.trim(), pick));
  scrim.addEventListener('pointerdown', (event) => {
    if (event.target === scrim) closeDialog(state);
  });
  scrim.querySelector('.language-dialog-close').addEventListener('click', () => closeDialog(state));
  document.addEventListener('keydown', onKeyDown, true);
  state.onKeyDown = onKeyDown;

  renderList(list, state, '', pick);
  search.focus();
}

function closeDialog(state) {
  if (!state.dialog) return;
  state.dialog.remove();
  state.dialog = null;
  document.removeEventListener('keydown', state.onKeyDown, true);
  state.host.focus();
}

// Initializes (first call) or updates (later calls) a language picker on the
// host <button>. After initialization host.value reads the current language
// and the host emits 'change' when the user picks another one.
export function populateLanguageSelect(host, selectedName) {
  const normalized = normalizeLanguageName(selectedName);
  let state = states.get(host);
  if (!state) {
    host.classList.add('language-trigger');
    host.setAttribute('aria-haspopup', 'dialog');
    state = { host, value: normalized, dialog: null, onKeyDown: null };
    Object.defineProperty(host, 'value', { get: () => states.get(host).value });
    host.addEventListener('click', () => openDialog(state));
    states.set(host, state);
  }
  state.value = normalized;
  host.textContent = labelFor(normalized);
}
