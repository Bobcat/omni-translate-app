export function createDialogDragController(setDrag) {
  let dragX = 0;
  let dragY = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;

  function applyDrag(x, y) {
    dragX = x;
    dragY = y;
    setDrag(dragX, dragY);
  }

  function reset() { applyDrag(0, 0); }

  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    applyDrag(dragOriginX + dx, dragOriginY + dy);
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOriginX = dragX;
    dragOriginY = dragY;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  }

  return { reset, onUp, onMouseDown };
}
