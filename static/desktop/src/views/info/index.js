import {
  getInfoCategory,
  renderInfoArticle,
  renderInfoOverview,
} from '../../../../shared/info/index.js?v=20260831-pdfjs-1';

export function createInfoView({ onNavigate = null, topicHref = null, overviewHref = '' } = {}) {
  const container = document.createElement('div');
  container.className = 'view info-view';

  function focusHeading() {
    const heading = container.querySelector('h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }

  function showOverview({ moveFocus = false } = {}) {
    renderInfoOverview(container, { categoryHref: topicHref });
    container.scrollTop = 0;
    if (moveFocus) focusHeading();
  }

  function showArticle(categoryId, { moveFocus = true } = {}) {
    if (!getInfoCategory(categoryId)) {
      showOverview({ moveFocus });
      return;
    }
    renderInfoArticle(container, categoryId, { showBack: true, overviewHref });
    container.scrollTop = 0;
    if (moveFocus) focusHeading();
  }

  container.addEventListener('click', (event) => {
    const categoryButton = event.target.closest('[data-info-category]');
    if (categoryButton) {
      if (onNavigate) {
        event.preventDefault();
        onNavigate(categoryButton.dataset.infoCategory);
      } else {
        showArticle(categoryButton.dataset.infoCategory);
      }
      return;
    }
    if (event.target.closest('[data-info-back]')) {
      if (onNavigate) {
        event.preventDefault();
        onNavigate('');
      } else {
        showOverview({ moveFocus: true });
      }
    }
  });

  container.__onRoute = (data) => {
    const categoryId = String(data?.categoryId || '');
    if (categoryId) showArticle(categoryId);
    else showOverview({ moveFocus: true });
  };
  showOverview();
  return container;
}
