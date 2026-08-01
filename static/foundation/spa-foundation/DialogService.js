export class DialogService {
    constructor() {
        this.registry = new Map();
        this.openDialogs = new Set();
    }

    register(dialogId, handlers = {}) {
        const id = String(dialogId || "");
        if (!id) throw new Error("DialogService.register requires a dialog id");

        this.registry.set(id, {
            onOpen: typeof handlers.onOpen === "function" ? handlers.onOpen : null,
            onClose: typeof handlers.onClose === "function" ? handlers.onClose : null
        });
        return () => this.unregister(id);
    }

    unregister(dialogId) {
        const id = String(dialogId || "");
        this.openDialogs.delete(id);
        this.registry.delete(id);
    }

    open(dialogId, payload = {}) {
        const id = String(dialogId || "");
        const entry = this.registry.get(id);
        if (!entry) return false;

        const result = entry.onOpen ? entry.onOpen(payload, { id, service: this }) : undefined;
        if (result === false) return false;
        this.openDialogs.add(id);
        return true;
    }

    close(dialogId, payload = {}) {
        const id = String(dialogId || "");
        const entry = this.registry.get(id);
        if (!entry) return false;

        if (entry.onClose) entry.onClose(payload, { id, service: this });
        this.openDialogs.delete(id);
        return true;
    }

    isOpen(dialogId) { return this.openDialogs.has(String(dialogId || "")); }
}
