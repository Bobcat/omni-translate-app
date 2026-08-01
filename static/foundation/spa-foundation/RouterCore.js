export class RouterCore {
    constructor(hostElement, hooks = {}) {
        if (!hostElement) throw new Error("RouterCore requires a host element");

        this.host = hostElement;
        this.routes = new Map();
        this.currentRoute = null;
        this.popStateHandler = null;
        this.hooks = {
            onSameRouteNavigate: null,
            onRouteWillMount: null,
            onRouteDidMount: null,
            ...hooks
        };
    }

    register(name, view) {
        this.routes.set(String(name), view);
        return this;
    }

    has(name) { return this.routes.has(String(name)); }
    getCurrentRoute() { return this.currentRoute; }

    start(viewName, data = null, options = {}) {
        return this.navigate(viewName, data, { ...options, replace: true, isPopState: false });
    }

    startFromHash(defaultViewName, defaultData = null, options = {}) {
        const fallbackView = String(defaultViewName || "");
        if (!this.has(fallbackView)) return false;

        const parseHash = typeof options.parseHash === "function" ? options.parseHash : null;
        const resolveInitialRoute =
            typeof options.resolveInitialRoute === "function" ? options.resolveInitialRoute : null;
        let nextRoute = { view: fallbackView, data: defaultData };

        const rawHash = String(window.location.hash || "").replace(/^#/, "");
        const hashRoute = this.resolveRouteFromHash(rawHash, parseHash);
        if (hashRoute) nextRoute = { view: hashRoute.view, data: hashRoute.data };

        if (resolveInitialRoute) {
            const maybeResolved = resolveInitialRoute({
                view: nextRoute.view,
                data: nextRoute.data,
                hash: rawHash,
                router: this
            });
            if (maybeResolved && maybeResolved.view && this.has(maybeResolved.view)) {
                nextRoute = {
                    view: String(maybeResolved.view),
                    data: Object.prototype.hasOwnProperty.call(maybeResolved, "data")
                        ? maybeResolved.data
                        : nextRoute.data
                };
            }
        }

        return this.start(nextRoute.view, nextRoute.data, {
            url: `#${rawHash || nextRoute.view}`,
            state: { view: nextRoute.view, data: nextRoute.data }
        });
    }

    bindPopState(options = {}) {
        if (this.popStateHandler) return this.popStateHandler;

        const parseHash = typeof options.parseHash === "function" ? options.parseHash : null;

        this.popStateHandler = (event) => {
            const state = event && event.state;
            if (state && state.view && this.has(state.view)) {
                this.navigate(state.view, state.data, { isPopState: true });
                return;
            }

            const rawHash = String(window.location.hash || "").replace(/^#/, "");
            const hashRoute = this.resolveRouteFromHash(rawHash, parseHash, event);
            if (!hashRoute) return;
            this.navigate(hashRoute.view, hashRoute.data, { isPopState: true });
        };

        window.addEventListener("popstate", this.popStateHandler);
        return this.popStateHandler;
    }

    unbindPopState() {
        if (!this.popStateHandler) return;
        window.removeEventListener("popstate", this.popStateHandler);
        this.popStateHandler = null;
    }

    resolveRouteFromHash(hash, parseHash = null, event = null) {
        const rawHash = String(hash || "").replace(/^#/, "");
        if (!rawHash) return null;

        let parsed = null;
        if (typeof parseHash === "function") parsed = parseHash({ hash: rawHash, router: this, event });
        else if (this.has(rawHash)) parsed = { view: rawHash, data: null };

        if (!parsed || !parsed.view) return null;
        const view = String(parsed.view);
        if (!this.has(view)) return null;

        const data = Object.prototype.hasOwnProperty.call(parsed, "data") ? parsed.data : null;
        return { view, data };
    }

    navigate(viewName, data = null, options = {}) {
        const name = String(viewName || "");
        if (!this.has(name)) return false;

        const {
            isPopState = false,
            replace = false,
            url = `#${name}`,
            state = null
        } = options;

        const from = this.currentRoute;
        const to = { view: name, data };

        if (from && from.view === name && typeof this.hooks.onSameRouteNavigate === "function") {
            const handled = this.hooks.onSameRouteNavigate({ from, to, isPopState, router: this });
            if (handled) return true;
        }

        let unmountState = null;
        if (from) {
            const currentView = this.routes.get(from.view);
            if (currentView && typeof currentView.unmount === "function") unmountState = currentView.unmount();
        }

        let nextData = data;
        if (typeof this.hooks.onRouteWillMount === "function") {
            const maybeNextData = this.hooks.onRouteWillMount({
                from,
                to,
                data,
                unmountState,
                isPopState,
                router: this
            });
            if (maybeNextData !== undefined) nextData = maybeNextData;
        }

        const historyState = state || { view: name, data: nextData };
        if (!isPopState) {
            if (replace) window.history.replaceState(historyState, "", url);
            else window.history.pushState(historyState, "", url);
        }

        this.currentRoute = { view: name, data: nextData };

        this.host.innerHTML = "";
        const nextView = this.routes.get(name);
        if (nextView && typeof nextView.mount === "function") nextView.mount(this.host, nextData);

        if (typeof this.hooks.onRouteDidMount === "function") {
            this.hooks.onRouteDidMount({
                from,
                to: this.currentRoute,
                data: nextData,
                unmountState,
                isPopState,
                router: this
            });
        }

        return true;
    }
}
