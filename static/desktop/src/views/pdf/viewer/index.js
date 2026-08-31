const PDFJS_ROOT_URL = new URL('../../../../vendor/pdfjs/6.3.289/', import.meta.url);
const PDFJS_MODULE_URL = new URL('legacy/build/pdf.min.mjs', PDFJS_ROOT_URL).href;
const PDFJS_WORKER_URL = new URL('legacy/build/pdf.worker.min.mjs', PDFJS_ROOT_URL).href;

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_FACTOR = 1.2;
const VIEWPORT_GUTTER_PX = 36;
const MIN_CANVAS_OUTPUT_SCALE = 2;
const MAX_CANVAS_OUTPUT_SCALE = 3;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const RENDER_MARGIN_VIEWPORTS = 1;
const RETAIN_MARGIN_VIEWPORTS = 2.5;

let pdfJsPromise = null;

function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import(PDFJS_MODULE_URL).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return pdfjs;
    }).catch((error) => {
      pdfJsPromise = null;
      throw error;
    });
  }
  return pdfJsPromise;
}

export function clampPdfScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function pdfFitWidthScale(containerWidth, pageWidth, gutter = VIEWPORT_GUTTER_PX) {
  const availableWidth = Number(containerWidth) - Number(gutter);
  const sourceWidth = Number(pageWidth);
  if (!(availableWidth > 0) || !(sourceWidth > 0)) return 1;
  return clampPdfScale(availableWidth / sourceWidth);
}

export function pdfFitPageScale(
  containerWidth,
  containerHeight,
  pageWidth,
  pageHeight,
  gutter = VIEWPORT_GUTTER_PX,
) {
  const availableWidth = Number(containerWidth) - Number(gutter);
  const availableHeight = Number(containerHeight) - Number(gutter);
  const sourceWidth = Number(pageWidth);
  const sourceHeight = Number(pageHeight);
  if (
    !(availableWidth > 0)
    || !(availableHeight > 0)
    || !(sourceWidth > 0)
    || !(sourceHeight > 0)
  ) return 1;
  return clampPdfScale(Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight));
}

export function pdfScaleFromPercentage(value) {
  const match = String(value ?? '').trim().match(/^(\d+(?:[.,]\d+)?)\s*%?$/);
  if (!match) return null;
  const percentage = Number(match[1].replace(',', '.'));
  if (!(percentage > 0)) return null;
  return clampPdfScale(percentage / 100);
}

export function pdfCanvasOutputScale(
  width,
  height,
  devicePixelRatio = 1,
  maxCanvasPixels = MAX_CANVAS_PIXELS,
) {
  const cssPixels = Math.max(1, Number(width) * Number(height));
  const preferred = Math.min(
    MAX_CANVAS_OUTPUT_SCALE,
    Math.max(MIN_CANVAS_OUTPUT_SCALE, Number(devicePixelRatio) || 1),
  );
  const pixelLimit = Math.max(1, Number(maxCanvasPixels) || MAX_CANVAS_PIXELS);
  return Math.max(0.25, Math.min(preferred, Math.sqrt(pixelLimit / cssPixels)));
}

export function pdfPageInViewport(pages, viewportTop, viewportHeight) {
  const top = Number(viewportTop) || 0;
  const height = Math.max(0, Number(viewportHeight) || 0);
  const bottom = top + height;
  const center = top + (height / 2);
  let closestPageNumber = 1;
  let largestOverlap = -1;
  let closestDistance = Infinity;

  for (const page of pages || []) {
    const pageNumber = Math.max(1, Math.round(Number(page?.pageNumber) || 1));
    const pageTop = Number(page?.top);
    const pageHeight = Number(page?.height);
    if (!Number.isFinite(pageTop) || !(pageHeight > 0)) continue;
    const pageBottom = pageTop + pageHeight;
    const overlap = Math.max(0, Math.min(bottom, pageBottom) - Math.max(top, pageTop));
    const distance = Math.abs((pageTop + (pageHeight / 2)) - center);
    if (overlap > largestOverlap || (overlap === largestOverlap && distance < closestDistance)) {
      closestPageNumber = pageNumber;
      largestOverlap = overlap;
      closestDistance = distance;
    }
  }
  return closestPageNumber;
}

export function createPdfViewer({ label = 'PDF' } = {}) {
  const element = document.createElement('section');
  element.className = 'pdf-document-viewer';
  element.setAttribute('aria-label', `${label} viewer`);
  element.innerHTML = `
    <div class="pdf-viewer-toolbar" role="toolbar" aria-label="${label} controls">
      <div class="pdf-viewer-page-controls">
        <button type="button" class="pdf-viewer-icon-button" data-action="previous" aria-label="Previous page" title="Previous page" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <label class="pdf-viewer-page-field">
          <span class="visually-hidden">Page number</span>
          <input type="number" inputmode="numeric" min="1" value="1" aria-label="Page number" disabled>
        </label>
        <span class="pdf-viewer-page-total" aria-live="polite">/ 0</span>
        <button type="button" class="pdf-viewer-icon-button" data-action="next" aria-label="Next page" title="Next page" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
      <div class="pdf-viewer-zoom-controls">
        <button type="button" class="pdf-viewer-icon-button" data-action="zoom-out" aria-label="Zoom out" title="Zoom out" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>
        </button>
        <input type="text" class="pdf-viewer-zoom-value" inputmode="decimal" value="100%" aria-label="Zoom percentage" disabled>
        <button type="button" class="pdf-viewer-icon-button" data-action="zoom-in" aria-label="Zoom in" title="Zoom in" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>
        </button>
        <button type="button" class="pdf-viewer-icon-button" data-action="fit" aria-label="Fit page" title="Fit page" disabled>
          <svg data-fit-icon="width" viewBox="0 0 24 24" aria-hidden="true" hidden>
            <path d="m18 8 4 4-4 4"/>
            <path d="M2 12h20"/>
            <path d="m6 8-4 4 4 4"/>
          </svg>
          <svg data-fit-icon="page" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2v20"/>
            <path d="m8 18 4 4 4-4"/>
            <path d="m8 6 4-4 4 4"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="pdf-viewer-viewport" tabindex="0">
      <div class="pdf-viewer-message" role="status">Choose a PDF to preview.</div>
      <div class="pdf-viewer-pages" role="document" aria-label="${label}" hidden></div>
    </div>
  `;

  const viewportElement = element.querySelector('.pdf-viewer-viewport');
  const messageElement = element.querySelector('.pdf-viewer-message');
  const pagesElement = element.querySelector('.pdf-viewer-pages');
  const pageInput = element.querySelector('input[type="number"]');
  const pageTotal = element.querySelector('.pdf-viewer-page-total');
  const zoomInput = element.querySelector('.pdf-viewer-zoom-value');
  const previousButton = element.querySelector('[data-action="previous"]');
  const nextButton = element.querySelector('[data-action="next"]');
  const zoomOutButton = element.querySelector('[data-action="zoom-out"]');
  const zoomInButton = element.querySelector('[data-action="zoom-in"]');
  const fitButton = element.querySelector('[data-action="fit"]');
  const fitWidthIcon = fitButton.querySelector('[data-fit-icon="width"]');
  const fitPageIcon = fitButton.querySelector('[data-fit-icon="page"]');
  const documentControls = [
    pageInput,
    previousButton,
    nextButton,
    zoomOutButton,
    zoomInButton,
    zoomInput,
    fitButton,
  ];

  let loadingTask = null;
  let pdfDocument = null;
  let pages = [];
  let maxUnitPageWidth = 0;
  let currentPageNumber = 1;
  let currentScale = 1;
  let fitMode = 'width';
  let loadToken = 0;
  let renderToken = 0;
  let resizeFrame = 0;
  let scrollFrame = 0;
  let lastFitContainerWidth = 0;
  let lastFitContainerHeight = 0;
  let destroyed = false;

  function setMessage(message, isError = false) {
    messageElement.textContent = message || '';
    messageElement.classList.toggle('is-error', Boolean(isError));
    messageElement.hidden = !message;
    pagesElement.hidden = Boolean(message);
  }

  function setLoading(loading) {
    element.setAttribute('aria-busy', String(Boolean(loading)));
  }

  function updateToolbar() {
    const pageCount = pdfDocument?.numPages || 0;
    const hasDocument = pageCount > 0;
    for (const control of documentControls) control.disabled = !hasDocument;
    pageInput.max = String(pageCount || 1);
    if (document.activeElement !== pageInput) pageInput.value = String(currentPageNumber);
    pageTotal.textContent = `/ ${pageCount}`;
    previousButton.disabled = !hasDocument || currentPageNumber <= 1;
    nextButton.disabled = !hasDocument || currentPageNumber >= pageCount;
    zoomOutButton.disabled = !hasDocument || currentScale <= MIN_SCALE;
    zoomInButton.disabled = !hasDocument || currentScale >= MAX_SCALE;
    const fitAction = fitMode === 'width' ? 'page' : 'width';
    const fitLabel = fitAction === 'width' ? 'Fit page width' : 'Fit page';
    fitButton.dataset.fitAction = fitAction;
    fitButton.setAttribute('aria-label', fitLabel);
    fitButton.title = fitLabel;
    fitWidthIcon.toggleAttribute('hidden', fitAction !== 'width');
    fitPageIcon.toggleAttribute('hidden', fitAction !== 'page');
    if (document.activeElement !== zoomInput) {
      zoomInput.value = `${Math.round(currentScale * 100)}%`;
    }
  }

  function releasePage(page) {
    const task = page.renderTask;
    page.renderTask = null;
    page.renderPromise = null;
    page.renderedScale = 0;
    if (task) {
      // A cancelled PDF.js task may settle asynchronously. Give any immediate
      // replacement render its own canvas so the two tasks never share one.
      const replacement = page.canvas.cloneNode(false);
      replacement.width = 0;
      replacement.height = 0;
      page.canvas.replaceWith(replacement);
      page.canvas = replacement;
      task.cancel();
    } else {
      page.canvas.width = 0;
      page.canvas.height = 0;
    }
  }

  function cancelRenders() {
    ++renderToken;
    for (const page of pages) releasePage(page);
  }

  async function disposeDocument() {
    cancelRenders();
    const task = loadingTask;
    loadingTask = null;
    pdfDocument = null;
    pages = [];
    maxUnitPageWidth = 0;
    pagesElement.replaceChildren();
    if (task) {
      try {
        await task.destroy();
      } catch {}
    }
  }

  function buildPageElements(pdfPages) {
    const fragment = document.createDocumentFragment();
    pages = pdfPages.map((pdfPage, index) => {
      const pageNumber = index + 1;
      const unitViewport = pdfPage.getViewport({ scale: 1 });
      const pageElement = document.createElement('div');
      pageElement.className = 'pdf-viewer-page';
      pageElement.dataset.pageNumber = String(pageNumber);
      pageElement.setAttribute('role', 'group');
      pageElement.setAttribute('aria-label', `Page ${pageNumber} of ${pdfPages.length}`);
      const canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${label}, page ${pageNumber} of ${pdfPages.length}`);
      const errorElement = document.createElement('div');
      errorElement.className = 'pdf-viewer-page-error';
      errorElement.textContent = 'This page could not be rendered.';
      errorElement.hidden = true;
      pageElement.append(canvas, errorElement);
      fragment.append(pageElement);
      return {
        pageNumber,
        pdfPage,
        unitWidth: unitViewport.width,
        unitHeight: unitViewport.height,
        cssWidth: unitViewport.width,
        cssHeight: unitViewport.height,
        element: pageElement,
        canvas,
        errorElement,
        renderTask: null,
        renderPromise: null,
        renderedScale: 0,
      };
    });
    maxUnitPageWidth = Math.max(0, ...pages.map((page) => page.unitWidth));
    pagesElement.replaceChildren(fragment);
  }

  function layoutPages() {
    for (const page of pages) {
      const pageViewport = page.pdfPage.getViewport({ scale: currentScale });
      page.cssWidth = pageViewport.width;
      page.cssHeight = pageViewport.height;
      page.element.style.width = `${page.cssWidth}px`;
      page.element.style.height = `${page.cssHeight}px`;
      page.canvas.style.width = `${page.cssWidth}px`;
      page.canvas.style.height = `${page.cssHeight}px`;
    }
  }

  function captureScrollAnchor() {
    const page = pages[currentPageNumber - 1];
    if (!page || page.element.hidden) return null;
    const pageRect = page.element.getBoundingClientRect();
    const viewportRect = viewportElement.getBoundingClientRect();
    if (!(pageRect.height > 0) || !(viewportRect.height > 0)) return null;
    const viewportCenter = viewportRect.top + (viewportElement.clientHeight / 2);
    return {
      pageNumber: page.pageNumber,
      ratio: Math.min(1, Math.max(0, (viewportCenter - pageRect.top) / pageRect.height)),
    };
  }

  function restoreScrollAnchor(anchor) {
    const page = pages[(anchor?.pageNumber || 1) - 1];
    if (!page) return;
    const pageRect = page.element.getBoundingClientRect();
    const viewportRect = viewportElement.getBoundingClientRect();
    const currentPoint = pageRect.top + ((anchor?.ratio || 0) * pageRect.height);
    const desiredPoint = viewportRect.top + (viewportElement.clientHeight / 2);
    viewportElement.scrollTop += currentPoint - desiredPoint;
  }

  async function renderPage(page) {
    if (destroyed || !pdfDocument) return;
    if (page.renderPromise) return page.renderPromise;
    if (page.canvas.width > 0 && Math.abs(page.renderedScale - currentScale) < 0.0001) return;

    const token = renderToken;
    const scaleAtStart = currentScale;
    let task = null;
    let promise = null;
    promise = Promise.resolve().then(async () => {
      try {
        const pageViewport = page.pdfPage.getViewport({ scale: scaleAtStart });
        const outputScale = pdfCanvasOutputScale(
          pageViewport.width,
          pageViewport.height,
          globalThis.devicePixelRatio,
        );
        page.canvas.width = Math.max(1, Math.ceil(pageViewport.width * outputScale));
        page.canvas.height = Math.max(1, Math.ceil(pageViewport.height * outputScale));
        const context = page.canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas rendering is unavailable.');
        page.errorElement.hidden = true;
        task = page.pdfPage.render({
          canvasContext: context,
          viewport: pageViewport,
          transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
          background: '#ffffff',
        });
        page.renderTask = task;
        await task.promise;
        if (token !== renderToken || page.renderTask !== task) return;
        page.renderedScale = scaleAtStart;
      } catch (error) {
        if (token !== renderToken || error?.name === 'RenderingCancelledException') return;
        console.error(`Could not render PDF page ${page.pageNumber}.`, error);
        page.canvas.width = 0;
        page.canvas.height = 0;
        page.errorElement.hidden = false;
      } finally {
        if (page.renderTask === task) page.renderTask = null;
        if (page.renderPromise === promise) page.renderPromise = null;
      }
    });
    page.renderPromise = promise;
    return promise;
  }

  function verticalDistance(rect, viewportRect) {
    if (rect.bottom < viewportRect.top) return viewportRect.top - rect.bottom;
    if (rect.top > viewportRect.bottom) return rect.top - viewportRect.bottom;
    return 0;
  }

  function renderVisiblePages() {
    if (!pdfDocument || pagesElement.hidden || viewportElement.clientHeight <= 0) {
      return Promise.resolve([]);
    }
    const viewportRect = viewportElement.getBoundingClientRect();
    const renderMargin = viewportElement.clientHeight * RENDER_MARGIN_VIEWPORTS;
    const retainMargin = viewportElement.clientHeight * RETAIN_MARGIN_VIEWPORTS;
    const renderPromises = [];
    for (const page of pages) {
      const distance = verticalDistance(page.element.getBoundingClientRect(), viewportRect);
      if (distance <= renderMargin) {
        renderPromises.push(renderPage(page));
      } else if (distance > retainMargin && (page.renderTask || page.canvas.width > 0)) {
        releasePage(page);
      }
    }
    return Promise.allSettled(renderPromises);
  }

  function updateCurrentPage() {
    if (!pages.length || pagesElement.hidden) return;
    const viewportRect = viewportElement.getBoundingClientRect();
    const pageRects = pages.map((page) => {
      const rect = page.element.getBoundingClientRect();
      return { pageNumber: page.pageNumber, top: rect.top, height: rect.height };
    });
    const nextPageNumber = pdfPageInViewport(
      pageRects,
      viewportRect.top,
      viewportElement.clientHeight,
    );
    if (nextPageNumber === currentPageNumber) return;
    currentPageNumber = nextPageNumber;
    updateToolbar();
  }

  function updateViewport() {
    scrollFrame = 0;
    updateCurrentPage();
    renderVisiblePages();
  }

  function scheduleViewportUpdate() {
    if (scrollFrame || destroyed) return;
    scrollFrame = requestAnimationFrame(updateViewport);
  }

  async function refreshDocumentLayout({ resetScroll = false, preservePosition = true } = {}) {
    if (!pdfDocument || !pages.length || destroyed) return;
    const anchor = preservePosition ? captureScrollAnchor() : null;
    cancelRenders();
    const token = renderToken;
    if (fitMode) {
      lastFitContainerWidth = viewportElement.clientWidth;
      lastFitContainerHeight = viewportElement.clientHeight;
      if (fitMode === 'page') {
        const fittedPage = pages[currentPageNumber - 1] || pages[0];
        currentScale = pdfFitPageScale(
          lastFitContainerWidth,
          lastFitContainerHeight,
          fittedPage.unitWidth,
          fittedPage.unitHeight,
        );
      } else {
        currentScale = pdfFitWidthScale(lastFitContainerWidth, maxUnitPageWidth);
      }
    }
    layoutPages();
    setMessage('');
    if (resetScroll) {
      viewportElement.scrollTop = 0;
      viewportElement.scrollLeft = 0;
    } else if (anchor) {
      restoreScrollAnchor(anchor);
    }
    updateCurrentPage();
    updateToolbar();
    setLoading(true);
    await renderVisiblePages();
    if (token === renderToken) setLoading(false);
  }

  function scheduleFitRender() {
    if (!fitMode || !pdfDocument || !pages.length || destroyed || viewportElement.clientWidth <= 0) return;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      const width = viewportElement.clientWidth;
      const height = viewportElement.clientHeight;
      const widthChanged = Math.abs(width - lastFitContainerWidth) >= 2;
      const heightChanged = fitMode === 'page' && Math.abs(height - lastFitContainerHeight) >= 2;
      if (!widthChanged && !heightChanged) return;
      refreshDocumentLayout();
    });
  }

  function goToPage(value) {
    if (!pdfDocument) return;
    const nextPage = Math.min(
      pdfDocument.numPages,
      Math.max(1, Math.round(Number(value) || currentPageNumber)),
    );
    pageInput.value = String(nextPage);
    currentPageNumber = nextPage;
    updateToolbar();
    const page = pages[nextPage - 1];
    if (!page) return;
    const pageRect = page.element.getBoundingClientRect();
    const viewportRect = viewportElement.getBoundingClientRect();
    viewportElement.scrollTop += pageRect.top - viewportRect.top - (VIEWPORT_GUTTER_PX / 2);
    scheduleViewportUpdate();
  }

  function changeScale(nextScale) {
    if (!pdfDocument) return;
    fitMode = null;
    currentScale = clampPdfScale(nextScale);
    updateToolbar();
    refreshDocumentLayout();
  }

  function commitZoomInput() {
    const nextScale = pdfScaleFromPercentage(zoomInput.value);
    if (nextScale === null) {
      zoomInput.value = `${Math.round(currentScale * 100)}%`;
      return;
    }
    changeScale(nextScale);
    zoomInput.value = `${Math.round(currentScale * 100)}%`;
  }

  previousButton.addEventListener('click', () => goToPage(currentPageNumber - 1));
  nextButton.addEventListener('click', () => goToPage(currentPageNumber + 1));
  zoomOutButton.addEventListener('click', () => changeScale(currentScale / ZOOM_FACTOR));
  zoomInButton.addEventListener('click', () => changeScale(currentScale * ZOOM_FACTOR));
  zoomInput.addEventListener('focus', () => zoomInput.select());
  zoomInput.addEventListener('change', commitZoomInput);
  zoomInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') zoomInput.blur();
    if (event.key === 'Escape') {
      zoomInput.value = `${Math.round(currentScale * 100)}%`;
      zoomInput.blur();
    }
  });
  fitButton.addEventListener('click', () => {
    if (!pdfDocument) return;
    fitMode = fitMode === 'width' ? 'page' : 'width';
    lastFitContainerWidth = 0;
    lastFitContainerHeight = 0;
    updateToolbar();
    refreshDocumentLayout();
  });
  pageInput.addEventListener('change', () => goToPage(pageInput.value));
  pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') pageInput.blur();
  });
  viewportElement.addEventListener('scroll', scheduleViewportUpdate, { passive: true });

  const resizeObserver = new ResizeObserver(scheduleFitRender);
  resizeObserver.observe(viewportElement);
  updateToolbar();

  async function load(source) {
    if (destroyed) return false;
    const token = ++loadToken;
    await disposeDocument();
    if (token !== loadToken || destroyed) return false;

    currentPageNumber = 1;
    currentScale = 1;
    fitMode = 'width';
    lastFitContainerWidth = 0;
    lastFitContainerHeight = 0;
    updateToolbar();
    setLoading(true);
    setMessage('Loading PDF…');

    try {
      const [pdfjs, buffer] = await Promise.all([loadPdfJs(), source.arrayBuffer()]);
      if (token !== loadToken || destroyed) return false;
      const task = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        cMapUrl: new URL('cmaps/', PDFJS_ROOT_URL).href,
        cMapPacked: true,
        iccUrl: new URL('iccs/', PDFJS_ROOT_URL).href,
        standardFontDataUrl: new URL('standard_fonts/', PDFJS_ROOT_URL).href,
        wasmUrl: new URL('wasm/', PDFJS_ROOT_URL).href,
        useWorkerFetch: true,
        canvasMaxAreaInBytes: 64 * 1024 * 1024,
      });
      loadingTask = task;
      const passwordFailure = new Promise((_resolve, reject) => {
        task.onPassword = () => reject(new Error('PASSWORD_REQUIRED'));
      });
      const loadedDocument = await Promise.race([task.promise, passwordFailure]);
      if (token !== loadToken || destroyed || task !== loadingTask) {
        try { await task.destroy(); } catch {}
        return false;
      }
      pdfDocument = loadedDocument;
      const pdfPages = await Promise.all(
        Array.from({ length: loadedDocument.numPages }, (_unused, index) => loadedDocument.getPage(index + 1)),
      );
      if (token !== loadToken || destroyed || task !== loadingTask) return false;
      buildPageElements(pdfPages);
      updateToolbar();
      await refreshDocumentLayout({ resetScroll: true, preservePosition: false });
      return true;
    } catch (error) {
      if (token !== loadToken || destroyed) return false;
      const task = loadingTask;
      loadingTask = null;
      pdfDocument = null;
      if (task) {
        try { await task.destroy(); } catch {}
      }
      updateToolbar();
      const passwordRequired = error?.message === 'PASSWORD_REQUIRED';
      setMessage(
        passwordRequired
          ? 'Password-protected PDFs cannot be previewed yet.'
          : 'This PDF could not be previewed.',
        true,
      );
      return false;
    } finally {
      if (token === loadToken) setLoading(false);
    }
  }

  function clear() {
    ++loadToken;
    disposeDocument();
    currentPageNumber = 1;
    currentScale = 1;
    fitMode = 'width';
    lastFitContainerWidth = 0;
    lastFitContainerHeight = 0;
    setLoading(false);
    setMessage('Choose a PDF to preview.');
    updateToolbar();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    resizeObserver.disconnect();
    viewportElement.removeEventListener('scroll', scheduleViewportUpdate);
    clear();
  }

  return {
    element,
    load,
    clear,
    destroy,
    refreshLayout: scheduleFitRender,
  };
}
