const DEFAULT_SPLIT_PERCENT = 50;
const DEFAULT_MIN_PANE_PX = 260;
const DEFAULT_DIVIDER_PX = 10;

export function pdfSplitPercent(
  clientX,
  containerLeft,
  containerWidth,
  { minPanePx = DEFAULT_MIN_PANE_PX, dividerPx = DEFAULT_DIVIDER_PX } = {},
) {
  const width = Number(containerWidth);
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_SPLIT_PERCENT;
  const minimum = Math.min(45, ((Number(minPanePx) + Number(dividerPx) / 2) / width) * 100);
  const requested = ((Number(clientX) - Number(containerLeft)) / width) * 100;
  return Math.min(100 - minimum, Math.max(minimum, requested));
}

export function attachPdfSplitView({ container, separator }) {
  let splitPercent = DEFAULT_SPLIT_PERCENT;
  let pointerId = null;

  function render() {
    const rounded = Math.round(splitPercent);
    container.style.setProperty('--pdf-credit-split', `${splitPercent}%`);
    separator.setAttribute('aria-valuenow', String(rounded));
    separator.setAttribute(
      'aria-valuetext',
      `${rounded}% source, ${100 - rounded}% translation`,
    );
  }

  function setFromClientX(clientX) {
    const bounds = container.getBoundingClientRect();
    splitPercent = pdfSplitPercent(clientX, bounds.left, bounds.width);
    render();
  }

  function finishDrag(event) {
    if (pointerId === null || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
    pointerId = null;
    container.classList.remove('is-resizing');
  }

  separator.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    separator.setPointerCapture(pointerId);
    container.classList.add('is-resizing');
    setFromClientX(event.clientX);
  });
  separator.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointerId) setFromClientX(event.clientX);
  });
  separator.addEventListener('pointerup', finishDrag);
  separator.addEventListener('pointercancel', finishDrag);
  separator.addEventListener('lostpointercapture', finishDrag);
  separator.addEventListener('dblclick', () => {
    splitPercent = DEFAULT_SPLIT_PERCENT;
    render();
  });
  separator.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const bounds = container.getBoundingClientRect();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    const step = event.shiftKey ? 48 : 16;
    setFromClientX(bounds.left + (bounds.width * splitPercent) / 100 + direction * step);
  });

  render();
}
