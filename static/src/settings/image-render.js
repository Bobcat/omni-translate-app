// Image-translation render options, driven from two surfaces that share one state:
//   - the settings-sheet subpage (the `els.image*` selects), and
//   - the ad-hoc inline strip on the image view (selects carrying data-image-render="<key>").
// Both read from and write to state.imageRender; changing either re-renders the current image
// (reusing the cached translations, no re-translation). Only the settings sheet persists to
// localStorage — the strip is ad-hoc and never written.

import { state } from '../state.js';
import { els } from '../els.js';
import { rerenderCurrentImage } from '../image/lifecycle.js';
import { saveImageRenderSettings, DEFAULT_IMAGE_RENDER } from '../domain/storage.js';

// Settings-sheet select id -> the state.imageRender key it drives.
const SHEET_FIELDS = {
  imageRenderSizeMode: 'render_size_mode',
  imageEraseFillMode: 'erase_fill_mode',
  imageWidthFitMode: 'width_fit_mode',
  imageSizeMetricMode: 'size_metric_mode',
  imageSizeCohortMode: 'size_cohort_mode',
};

function stripSelects() {
  return document.querySelectorAll('[data-image-render]');
}

// Set every control (both surfaces) from state, so the two stay in lockstep.
export function renderImageRenderControls() {
  for (const [elKey, stateKey] of Object.entries(SHEET_FIELDS)) {
    if (els[elKey]) els[elKey].value = state.imageRender[stateKey];
  }
  for (const select of stripSelects()) {
    select.value = state.imageRender[select.dataset.imageRender];
  }
}

// `persist` is true only for settings-sheet changes; the strip passes false so it stays ad-hoc.
function applyChange(stateKey, value, { persist }) {
  if (state.imageRender[stateKey] === value) return;
  state.imageRender[stateKey] = value;
  if (persist) saveImageRenderSettings(state.imageRender);
  renderImageRenderControls();  // mirror the change onto the other surface
  rerenderCurrentImage();
}

// Reset the settings-sheet options to the service defaults, persist, and re-render.
export function resetImageRenderDefaults() {
  state.imageRender = { ...DEFAULT_IMAGE_RENDER };
  saveImageRenderSettings(state.imageRender);
  renderImageRenderControls();
  rerenderCurrentImage();
}

// One-time: attach change listeners to both surfaces (the strip lives in the always-present
// image view, so its selects exist at init even while hidden).
export function bindImageRenderControls() {
  for (const [elKey, stateKey] of Object.entries(SHEET_FIELDS)) {
    const select = els[elKey];
    if (select) select.addEventListener('change', () => applyChange(stateKey, select.value, { persist: true }));
  }
  for (const select of stripSelects()) {
    select.addEventListener('change', () => applyChange(select.dataset.imageRender, select.value, { persist: false }));
  }
  if (els.imageRenderResetButton) {
    els.imageRenderResetButton.addEventListener('click', resetImageRenderDefaults);
  }
}
