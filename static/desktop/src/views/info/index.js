import {
  getInfoCategory,
  renderInfoArticle,
  renderInfoOverview,
} from '../../../../shared/info/index.js?v=20260903-help-info-2';

export function createInfoView({ onNavigate = null, topicHref = null, overviewHref = '' } = {}) {
  const container = document.createElement('div');
  container.className = 'view info-view';

  function focusHeading() {
    const heading = container.querySelector('h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }

  function focusSection(section) {
    const heading = section?.querySelector('h2');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start' });
  }

  function showOverview({ moveFocus = false } = {}) {
    renderInfoOverview(container, { categoryHref: topicHref });
    container.scrollTop = 0;
    if (moveFocus) focusHeading();
  }

  function showArticle(categoryId, { sectionId = '', moveFocus = true } = {}) {
    if (!getInfoCategory(categoryId)) {
      showOverview({ moveFocus });
      return;
    }
    const section = renderInfoArticle(container, categoryId, {
      showBack: true,
      overviewHref,
      sectionId,
    });
    container.scrollTop = 0;
    if (moveFocus && section) focusSection(section);
    else if (moveFocus) focusHeading();
  }

  container.addEventListener('click', (event) => {
    const categoryButton = event.target.closest('[data-info-category]');
    if (categoryButton) {
      if (onNavigate) {
        event.preventDefault();
        onNavigate(
          categoryButton.dataset.infoCategory,
          categoryButton.dataset.infoSection || '',
        );
      } else {
        showArticle(categoryButton.dataset.infoCategory, {
          sectionId: categoryButton.dataset.infoSection || '',
        });
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
    const sectionId = String(data?.sectionId || '');
    if (categoryId) showArticle(categoryId, { sectionId });
    else showOverview({ moveFocus: true });
  };
  showOverview();
  return container;
}
