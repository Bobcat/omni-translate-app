export { RouterCore } from "./RouterCore.js";
export { ShellState } from "./ShellState.js";
export { DialogService } from "./DialogService.js";
export { DialogAnchor } from "./DialogAnchor.js";
export { ModalController } from "./ModalController.js";
export { createDialogDragController } from "./DialogDragController.js";
export { bindRouteHotkeys } from "./RouteHotkeys.js";

export function createShellPersistence({ storageKey, shellState, getPreset, getRoundedSidebar }) {
    const readSaved = () => {
        if (!storageKey) return null;
        try {
            const saved = JSON.parse(window.localStorage.getItem(storageKey) || "null");
            return saved && typeof saved === "object" ? saved : null;
        } catch {
            return null;
        }
    };

    return {
        resolve(defaults = {}) {
            const saved = readSaved() || {};
            return {
                preset: typeof saved.preset === "string" && saved.preset ? saved.preset : defaults.preset,
                sidebarOpen: typeof saved.sidebarOpen === "boolean" ? saved.sidebarOpen : defaults.sidebarOpen,
                roundedSidebar: typeof saved.roundedSidebar === "boolean" ? saved.roundedSidebar : defaults.roundedSidebar
            };
        },

        save() {
            if (!storageKey) return;
            try {
                window.localStorage.setItem(storageKey, JSON.stringify({
                    preset: getPreset(),
                    sidebarOpen: !!shellState.getSnapshot().sidebarOpen,
                    roundedSidebar: !!getRoundedSidebar()
                }));
            } catch {}
        }
    };
}

export function bindMobileSidebarDismiss(shellState, sidebar, maxWidth = 600) {
    const isMobileViewport = () => window.matchMedia(`(max-width: ${maxWidth}px)`).matches;
    const isSidebarOpenOnMobile = () => isMobileViewport() && !!shellState.getSnapshot().sidebarOpen;

    const onDocumentClick = (event) => {
        if (!isSidebarOpenOnMobile() || sidebar.contains(event.target)) return;
        shellState.setSidebarOpen(false, "mobileSidebarOutsideClick");
    };

    const onSidebarClick = (event) => {
        if (!isSidebarOpenOnMobile() || !event.target.closest("[data-route]")) return;
        shellState.setSidebarOpen(false, "mobileSidebarRouteClick");
    };

    document.addEventListener("click", onDocumentClick);
    sidebar.addEventListener("click", onSidebarClick);

    return () => { document.removeEventListener("click", onDocumentClick); sidebar.removeEventListener("click", onSidebarClick); };
}
