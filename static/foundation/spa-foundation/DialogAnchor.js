export class DialogAnchor {
    constructor(options = {}) {
        this.viewportPadding = Number.isFinite(options.viewportPadding) ? Math.max(0, options.viewportPadding) : 8;
        this.horizontalOffset = Number.isFinite(options.horizontalOffset) ? options.horizontalOffset : 8;
        this.verticalOffset = Number.isFinite(options.verticalOffset) ? options.verticalOffset : 10;
    }

    compute(anchorRect, dialogSize, viewportSize = null) {
        if (!anchorRect || !dialogSize) return null;

        const rect = this.normalizeRect(anchorRect);
        const width = Number(dialogSize.width);
        const height = Number(dialogSize.height);
        if (!rect || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

        const viewportWidth = viewportSize && Number.isFinite(viewportSize.width) ? viewportSize.width : window.innerWidth;
        const viewportHeight = viewportSize && Number.isFinite(viewportSize.height) ? viewportSize.height : window.innerHeight;

        let left = rect.right + this.horizontalOffset;
        let top = rect.top - height - this.verticalOffset;

        if (left + width > viewportWidth - this.viewportPadding) left = rect.left - width - this.horizontalOffset;

        left = Math.max(this.viewportPadding, Math.min(left, viewportWidth - width - this.viewportPadding));
        top = Math.max(this.viewportPadding, Math.min(top, viewportHeight - height - this.viewportPadding));

        return { left, top };
    }

    applyCssVars(targetElement, position, xVar = "--anchor-left", yVar = "--anchor-top") {
        if (!targetElement || !position) return false;
        const left = Number(position.left);
        const top = Number(position.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return false;

        targetElement.style.setProperty(xVar, `${left}px`);
        targetElement.style.setProperty(yVar, `${top}px`);
        return true;
    }

    normalizeRect(anchorRect) {
        const left = Number(anchorRect.left);
        const right = Number(anchorRect.right);
        const top = Number(anchorRect.top);
        if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top)) return null;
        return { left, right, top };
    }
}
