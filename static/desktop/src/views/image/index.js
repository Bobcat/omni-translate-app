import { iconMarkup } from '../../shared/icons.js';
import { populateLanguageSelect, recordLanguageMru } from '../../shared/languages.js';
import { translateImage, retranslateImage } from '../../shared/api.js';

// Image translation view, same stage model as the PDF view: an empty state
// (dropzone) swaps for a loaded state (original frame + translated frame) once
// a file is chosen. The translated frame shows a spinner while the backend
// translates (synchronous call — no server-side cancel, so there is no Cancel
// button; × simply abandons the wait). Changing the target re-translates the
// current image (the service reuses its OCR, so that is cheap). `runToken`
// makes a stale response a no-op when the user drops a new file, switches
// target, or resets mid-flight.

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function createImageView() {
  const container = document.createElement('div');
  container.className = 'view image-view';
  container.innerHTML = `
    <div class="view-toolbar">
      <div class="field">
        <span>Target</span>
        <button type="button" id="imageTarget"></button>
      </div>
      <label class="field switch-field">
        <span>Show original</span>
        <span class="switch">
          <input type="checkbox" id="imageShowOriginal" checked>
          <span class="switch-slider"></span>
        </span>
      </label>
      <div class="toolbar-actions">
        <label class="zoom-field" id="imageZoomField" title="Image size" hidden>
          <input type="range" id="imageZoom" min="25" max="200" step="5" value="100">
          <output id="imageZoomValue">100%</output>
        </label>
        <a class="icon-square-btn" id="imageDownload" title="Download translated image" aria-label="Download translated image" hidden>${iconMarkup('download')}</a>
        <button type="button" class="icon-square-btn" id="imageReset" title="Choose another image" aria-label="Choose another image" hidden>${iconMarkup('x')}</button>
      </div>
    </div>
    <div class="dropzone-card" id="imageDropzone">
      <div class="dropzone-drop">
        ${iconMarkup('upload-cloud')}
        <div class="dropzone-hint">Drag and drop an image</div>
      </div>
      <div class="dropzone-sep"></div>
      <div class="dropzone-choose">
        <span>Or choose a file</span>
        <button type="button" class="browse-btn" id="imageBrowseBtn">Browse your files</button>
      </div>
    </div>
    <div class="result-grid" id="imageStage" hidden>
      <figure class="result-frame result-frame-original">
        <img id="imageOriginal" alt="Original image">
      </figure>
      <figure class="result-frame">
        <div class="stage-pending" id="imagePending">
          <div class="spinner" role="status" aria-label="Translating"></div>
          <div class="stage-pending-text">Translating…</div>
        </div>
        <img id="imageTranslated" alt="Translated image" hidden>
      </figure>
    </div>
    <div class="status-line" id="imageStatus" role="status"></div>
    <input type="file" id="imageFileInput" accept="image/png,image/jpeg,image/webp" hidden>
  `;

  const targetSelect = container.querySelector('#imageTarget');
  const showOriginalToggle = container.querySelector('#imageShowOriginal');
  const downloadLink = container.querySelector('#imageDownload');
  const resetBtn = container.querySelector('#imageReset');
  const zoomField = container.querySelector('#imageZoomField');
  const zoomInput = container.querySelector('#imageZoom');
  const zoomValue = container.querySelector('#imageZoomValue');
  const dropzone = container.querySelector('#imageDropzone');
  const browseBtn = container.querySelector('#imageBrowseBtn');
  const fileInput = container.querySelector('#imageFileInput');
  const stage = container.querySelector('#imageStage');
  const originalImg = container.querySelector('#imageOriginal');
  const translatedImg = container.querySelector('#imageTranslated');
  const pending = container.querySelector('#imagePending');
  const statusEl = container.querySelector('#imageStatus');

  let requestId = '';
  let fileName = '';
  let originalUrl = '';
  let translatedUrl = '';
  let runToken = 0;
  // Auto-fit wins until the user touches the slider; re-armed for each image.
  let zoomAuto = true;

  populateLanguageSelect(targetSelect, 'English');
  applyViewMode();

  function setStatus(message, isError = false) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  function applyViewMode() {
    stage.classList.toggle('is-single', !showOriginalToggle.checked);
  }

  // Zoom is relative to the image's NATIVE size (CSS zoom scales the layout
  // box), so the frame grows with the image and >100% scrolls inside it.
  function applyZoom(pct) {
    zoomInput.value = String(pct);
    zoomValue.textContent = `${pct}%`;
    originalImg.style.zoom = String(pct / 100);
    translatedImg.style.zoom = String(pct / 100);
  }

  // Largest step-of-5 zoom that still fits the column width, capped at 100%
  // (small images stay native; the user can upscale manually past that).
  function fitZoom() {
    const naturalWidth = originalImg.naturalWidth;
    const frameWidth = translatedImg.closest('.result-frame').clientWidth;
    if (!naturalWidth || !frameWidth) return;
    const pct = Math.max(25, Math.min(100, Math.floor((frameWidth / naturalWidth) * 100 / 5) * 5));
    applyZoom(pct);
  }

  function setStageLoaded(loaded) {
    dropzone.hidden = loaded;
    stage.hidden = !loaded;
    resetBtn.hidden = !loaded;
    zoomField.hidden = !loaded;
  }

  function showTranslated(blob) {
    if (translatedUrl) URL.revokeObjectURL(translatedUrl);
    translatedUrl = URL.createObjectURL(blob);
    translatedImg.src = translatedUrl;
    translatedImg.hidden = false;
    pending.hidden = true;
    const extension = blob.type === 'image/jpeg' ? 'jpg' : (blob.type.split('/')[1] || 'png');
    const stem = fileName.replace(/\.[^.]+$/, '') || 'image';
    downloadLink.href = translatedUrl;
    downloadLink.download = `${stem}_${targetSelect.value.toLowerCase()}.${extension}`;
    downloadLink.hidden = false;
    setStatus('');
  }

  function showError(message) {
    pending.hidden = true;
    setStatus(message || 'Translation failed.', true);
  }

  async function translate(file) {
    const token = ++runToken;
    requestId = '';
    zoomAuto = true;
    fileName = file.name || 'image';
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = URL.createObjectURL(file);
    originalImg.src = originalUrl;
    translatedImg.removeAttribute('src');
    translatedImg.hidden = true;
    downloadLink.hidden = true;
    setStageLoaded(true);
    pending.hidden = false;
    setStatus('');
    try {
      const result = await translateImage(file, { source: 'auto', target: targetSelect.value });
      if (token !== runToken || !container.isConnected) return;
      requestId = result.requestId;
      showTranslated(result.blob);
    } catch (err) {
      if (token !== runToken || !container.isConnected) return;
      showError(err.message);
    }
  }

  async function retranslate() {
    const token = ++runToken;
    downloadLink.hidden = true;
    translatedImg.hidden = true;
    pending.hidden = false;
    setStatus('');
    try {
      const result = await retranslateImage(requestId, { target: targetSelect.value });
      if (token !== runToken || !container.isConnected) return;
      requestId = result.requestId;
      showTranslated(result.blob);
    } catch (err) {
      if (token !== runToken || !container.isConnected) return;
      showError(err.message);
    }
  }

  function resetView() {
    ++runToken;
    requestId = '';
    downloadLink.hidden = true;
    originalImg.removeAttribute('src');
    translatedImg.removeAttribute('src');
    if (originalUrl) {
      URL.revokeObjectURL(originalUrl);
      originalUrl = '';
    }
    if (translatedUrl) {
      URL.revokeObjectURL(translatedUrl);
      translatedUrl = '';
    }
    pending.hidden = true;
    setStatus('');
    setStageLoaded(false);
  }

  targetSelect.addEventListener('change', () => {
    recordLanguageMru(targetSelect.value);
    populateLanguageSelect(targetSelect, targetSelect.value);
    if (requestId) retranslate();
  });

  showOriginalToggle.addEventListener('change', () => {
    applyViewMode();
    if (zoomAuto) fitZoom();
  });
  resetBtn.addEventListener('click', resetView);
  originalImg.addEventListener('load', () => {
    if (zoomAuto) fitZoom();
  });
  zoomInput.addEventListener('input', () => {
    zoomAuto = false;
    applyZoom(Number(zoomInput.value));
  });

  function acceptFile(file) {
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type)) {
      setStatus('Unsupported file type — use PNG, JPEG or WebP.', true);
      return;
    }
    translate(file);
  }

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    acceptFile(fileInput.files[0]);
    fileInput.value = '';
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragover');
    acceptFile(event.dataTransfer.files[0]);
  });

  return container;
}
