function isEditableTarget(target) {
  return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]");
}

export function bindRouteHotkeys(router, bindings = []) {
  if (!router || typeof router.navigate !== "function" || typeof router.has !== "function") {
    throw new Error("bindRouteHotkeys requires a router with navigate() and has()");
  }

  const hotkeys = bindings
    .map(({ key, route, modifiers = [] }) => {
      const nextKey = String(key || "").trim().toLowerCase();
      const nextRoute = String(route || "").trim();
      if (!nextKey || !nextRoute) return null;

      return {
        key: nextKey,
        route: nextRoute,
        alt: modifiers.includes("alt"),
        ctrl: modifiers.includes("ctrl"),
        meta: modifiers.includes("meta"),
        shift: modifiers.includes("shift")
      };
    })
    .filter(Boolean);

  const onKeyDown = (event) => {
    const hasCommandModifier = !!event.ctrlKey || !!event.metaKey || !!event.altKey;
    if (event.repeat || (isEditableTarget(event.target) && !hasCommandModifier)) return;

    const key = String(event.key || "").trim().toLowerCase();
    const hotkey = hotkeys.find((candidate) =>
      candidate.key === key
      && candidate.alt === !!event.altKey
      && candidate.ctrl === !!event.ctrlKey
      && candidate.meta === !!event.metaKey
      && candidate.shift === !!event.shiftKey
    );

    if (!hotkey || !router.has(hotkey.route)) return;

    event.preventDefault();
    router.navigate(hotkey.route, null, { url: `#${hotkey.route}` });
  };

  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}
