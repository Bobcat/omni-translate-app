export class ShellState {
    constructor(initialState = {}) {
        this.state = {
            sidebarOpen: initialState.sidebarOpen !== undefined ? !!initialState.sidebarOpen : true
        };
        this.listeners = new Set();
    }

    getSnapshot() { return { ...this.state }; }

    subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    setSidebarOpen(nextOpen, reason = "setSidebarOpen") {
        const value = !!nextOpen;
        if (this.state.sidebarOpen === value) return false;
        const prev = this.getSnapshot();
        this.state.sidebarOpen = value;
        this.emitChange(reason, prev);
        return true;
    }

    toggleSidebar(reason = "toggleSidebar") {
        return this.setSidebarOpen(!this.state.sidebarOpen, reason);
    }

    emitChange(reason, prev) {
        const next = this.getSnapshot();
        this.listeners.forEach((listener) => listener({ reason, prev, next }));
    }
}
