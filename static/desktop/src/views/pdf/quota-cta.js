import { renderGoogleButton } from '../../auth.js';

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

export function pdfPreviewQuotaExhausted({ previewPageLimit, usageResolved, remaining }) {
  return positiveInteger(previewPageLimit) > 0
    && usageResolved
    && typeof remaining === 'number'
    && remaining <= 0;
}

export function pdfAccountPlanFromConfig(payload) {
  const plan = payload?.pdf_translation?.account_plan || {};
  return {
    pagesPerPeriod: positiveInteger(plan.pages_per_period),
    maxPagesPerJob: positiveInteger(plan.max_pages_per_job),
  };
}

function allowanceText(value, fallback) {
  return value ? `${value} PDF pages each month` : fallback;
}

function perDocumentText(value, fallback) {
  return value ? `Up to ${value} pages per PDF` : fallback;
}

export function createPdfQuotaCta() {
  const section = document.createElement('section');
  section.className = 'pdf-quota-cta';
  section.hidden = true;
  section.setAttribute('aria-labelledby', 'pdfQuotaCtaTitle');
  section.innerHTML = `
    <header class="pdf-quota-cta-header">
      <h2 id="pdfQuotaCtaTitle">Your PDF preview is used up</h2>
      <p>Create a free account to continue translating PDFs.</p>
    </header>
    <div class="pdf-plan-grid">
      <article class="pdf-plan-card">
        <div class="pdf-plan-heading">
          <h3>Preview</h3>
          <span class="pdf-plan-badge">Current</span>
        </div>
        <div class="pdf-plan-price"><strong>€0</strong><span>/ month</span></div>
        <div class="pdf-plan-current">Current plan</div>
        <ul class="pdf-plan-features">
          <li>No account required</li>
          <li data-preview-allowance></li>
          <li data-preview-document-limit></li>
        </ul>
      </article>
      <article class="pdf-plan-card is-featured">
        <div class="pdf-plan-heading">
          <h3>Free account</h3>
        </div>
        <div class="pdf-plan-price"><strong>€0</strong><span>/ month</span></div>
        <div class="google-signin-holder" data-account-signin></div>
        <p class="pdf-plan-unavailable" data-account-unavailable hidden>Account sign-in is unavailable.</p>
        <ul class="pdf-plan-features">
          <li data-account-allowance></li>
          <li data-account-document-limit></li>
          <li>Translate complete PDFs within the per-PDF limit</li>
        </ul>
      </article>
    </div>
  `;

  const previewAllowance = section.querySelector('[data-preview-allowance]');
  const previewDocumentLimit = section.querySelector('[data-preview-document-limit]');
  const accountAllowance = section.querySelector('[data-account-allowance]');
  const accountDocumentLimit = section.querySelector('[data-account-document-limit]');
  const signInHolder = section.querySelector('[data-account-signin]');
  const unavailable = section.querySelector('[data-account-unavailable]');
  let signInRequested = false;

  function update({
    previewPagesPerPeriod,
    previewPageLimit,
    accountPlan,
    authConfigured,
    visible,
  }) {
    previewAllowance.textContent = allowanceText(
      positiveInteger(previewPagesPerPeriod),
      'A limited monthly PDF allowance',
    );
    previewDocumentLimit.textContent = perDocumentText(
      positiveInteger(previewPageLimit),
      'Translate a preview from each PDF',
    );
    accountAllowance.textContent = allowanceText(
      positiveInteger(accountPlan?.pagesPerPeriod),
      'A larger monthly PDF allowance',
    );
    accountDocumentLimit.textContent = perDocumentText(
      positiveInteger(accountPlan?.maxPagesPerJob),
      'Translate longer PDFs',
    );
    signInHolder.hidden = !authConfigured;
    unavailable.hidden = Boolean(authConfigured);
    if (authConfigured && visible && !signInRequested) {
      signInRequested = true;
      renderGoogleButton(signInHolder);
    }
  }

  return { element: section, update };
}
