export class ModalController {
    constructor(modalElement, options = {}) {
        if (!modalElement) throw new Error("ModalController requires a modal element");

        this.modal = modalElement;
        this.hiddenClass = String(options.hiddenClass || "hidden");
        this.backdropEvent = String(options.backdropEvent || "click");

        this.onBackdrop = typeof options.onBackdrop === "function" ? options.onBackdrop : null;
        this.onEscape = typeof options.onEscape === "function" ? options.onEscape : null;
        this.onEnter = typeof options.onEnter === "function" ? options.onEnter : null;

        this.handleBackdrop = (event) => {
            if (event.target !== this.modal) return;
            if (this.onBackdrop) this.onBackdrop(event, { controller: this });
        };

        this.handleKeydown = (event) => {
            if (event.key === "Escape" && this.onEscape) {
                this.onEscape(event, { controller: this });
                return;
            }
            if (event.key === "Enter" && this.onEnter) this.onEnter(event, { controller: this });
        };

        this.attach();
    }

    attach() {
        if (this.onBackdrop) this.modal.addEventListener(this.backdropEvent, this.handleBackdrop);
        if (this.onEscape || this.onEnter) this.modal.addEventListener("keydown", this.handleKeydown);
    }

    open() { this.modal.classList.remove(this.hiddenClass); }
    close() { this.modal.classList.add(this.hiddenClass); }
    isOpen() { return !this.modal.classList.contains(this.hiddenClass); }

    destroy() {
        if (this.onBackdrop) this.modal.removeEventListener(this.backdropEvent, this.handleBackdrop);
        if (this.onEscape || this.onEnter) this.modal.removeEventListener("keydown", this.handleKeydown);
    }
}
