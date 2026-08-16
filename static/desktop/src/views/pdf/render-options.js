const SCALE_VALUES = Array.from({ length: 51 }, (_value, index) => {
  const value = Number((1 - index * 0.01).toFixed(2));
  return [String(value), value.toFixed(2)];
});

export const PDF_RENDER_DEFAULTS = Object.freeze({
  page_layout_mode: 'typeset',
  page_scale: 0.9,
  render_size_mode: 'median',
  erase_fill_mode: 'inpaint',
  width_fit_mode: 'footprint',
  size_metric_mode: 'extent',
  size_cohort_mode: 'vlm',
  pdf_structure_mode: 'source_only',
});

const FIELD_DEFINITIONS = [
  {
    key: 'page_layout_mode',
    label: 'Layout',
    primary: true,
    options: [
      ['typeset', 'Typeset — best layout'],
      ['fit', 'Fit — safest'],
    ],
  },
  {
    key: 'page_scale',
    label: 'Page scale',
    primary: true,
    options: SCALE_VALUES,
  },
  {
    key: 'width_fit_mode',
    label: 'Width fit',
    options: [
      ['footprint', 'Original footprint'],
      ['extend_to_margin', 'Extend to margin'],
    ],
  },
  {
    key: 'size_metric_mode',
    label: 'Text size',
    options: [
      ['extent', 'Source bounds'],
      ['band', 'Clamp outliers'],
      ['fill', 'Match source ink'],
    ],
  },
  {
    key: 'size_cohort_mode',
    label: 'Size consistency',
    options: [
      ['vlm', 'Match similar elements'],
      ['off', 'Per element'],
    ],
  },
  {
    key: 'render_size_mode',
    label: 'Multiline size',
    options: [
      ['median', 'Median'],
      ['min', 'Minimum'],
    ],
  },
  {
    key: 'erase_fill_mode',
    label: 'Background',
    output: true,
    options: [
      ['inpaint', 'Adaptive inpaint'],
      ['flat', 'Flat colour'],
    ],
  },
  {
    key: 'pdf_structure_mode',
    label: 'Accessibility',
    output: true,
    options: [
      ['source_only', 'Preserve source policy'],
      ['always', 'Always add structure'],
    ],
  },
];

const ALLOWED = Object.fromEntries(FIELD_DEFINITIONS.map((field) => [
  field.key,
  new Set(field.options.map(([value]) => String(value))),
]));

export function normalizePdfRenderOptions(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = { ...PDF_RENDER_DEFAULTS };
  for (const key of Object.keys(ALLOWED)) {
    if (key === 'page_scale') continue;
    const candidate = String(source[key] ?? '');
    if (ALLOWED[key].has(candidate)) normalized[key] = candidate;
  }
  const scale = Number(source.page_scale);
  if (Number.isFinite(scale) && scale >= 0.5 && scale <= 1) {
    normalized.page_scale = Number(scale.toFixed(2));
  }
  return normalized;
}

export function pdfRenderApplicability(options, envelope = null) {
  const values = normalizePdfRenderOptions(options);
  const reasons = {};
  if (values.page_layout_mode === 'fit') {
    reasons.page_scale = true;
  }

  const response = envelope?.response || {};
  const metadata = response.metadata || {};
  const pages = Array.isArray(response?.document?.pages) ? response.document.pages : [];
  const responseMatchesLayout = (
    pages.length > 0
    && String(metadata.page_layout_mode || '') === values.page_layout_mode
  );
  const allTypeset = (
    values.page_layout_mode === 'typeset'
    && responseMatchesLayout
    && pages.every((page) => page?.effective_page_layout_mode === 'typeset')
  );
  if (allTypeset) {
    for (const key of [
      'width_fit_mode',
      'size_metric_mode',
      'size_cohort_mode',
      'render_size_mode',
    ]) {
      reasons[key] = 'The typesetter controls this for every page.';
    }
  }

  const allBornDigital = (
    pages.length > 0
    && pages.every((page) => page?.page_class === 'born-digital')
  );
  if (allBornDigital) {
    reasons.erase_fill_mode = 'Vector text needs no background fill.';
  }

  const allExactFit = (
    values.page_layout_mode === 'fit'
    && responseMatchesLayout
    && pages.every((page) => page?.cell_source === 'pdf_text_layer')
  );
  if (allExactFit) {
    reasons.size_metric_mode = 'The PDF supplies exact text sizes.';
    reasons.size_cohort_mode = 'The PDF supplies exact text sizes.';
  }
  return reasons;
}

export function createPdfRenderControls({ trigger, onChange = () => {} } = {}) {
  if (!trigger) throw new Error('PDF render controls require a toolbar trigger');
  const element = document.createElement('div');
  element.className = 'pdf-render-toolbox';
  element.hidden = true;
  element.innerHTML = `
    <div class="pdf-render-dismiss-layer" aria-hidden="true"></div>
    <aside class="pdf-render-panel" id="pdfRenderPanel" aria-label="PDF render options" aria-hidden="true">
      <header class="pdf-render-panel-header">
        <h2>Render options</h2>
        <button type="button" class="pdf-render-panel-close" aria-label="Close render options">×</button>
      </header>
      <div class="pdf-render-panel-scroll">
        <section class="pdf-render-group">
          <h3>Layout</h3>
          <div class="pdf-render-primary"></div>
        </section>
        <section class="pdf-render-group">
          <h3>Text fitting</h3>
          <div class="pdf-render-secondary"></div>
        </section>
        <section class="pdf-render-group">
          <h3>Output</h3>
          <div class="pdf-render-output"></div>
        </section>
        <div class="pdf-render-actions">
          <button type="button" class="pdf-render-help-trigger" aria-haspopup="dialog">What’s this?</button>
        </div>
      </div>
    </aside>
    <dialog class="pdf-render-help-dialog" aria-labelledby="pdfRenderHelpTitle">
      <div class="pdf-render-help-card">
        <header>
          <h2 id="pdfRenderHelpTitle">PDF render options</h2>
          <button type="button" class="pdf-render-help-close" aria-label="Close">×</button>
        </header>
        <div class="pdf-render-help-copy">
          <p><strong>Typeset</strong> usually gives document pages the most natural result: it reflows text through the page’s columns and rhythm. <strong>Fit</strong> is the safer choice for designed pages because every translation stays inside its source area.</p>
          <p><strong>Page scale</strong> controls the type size used by Typeset. The Fit controls tune text kept in its source areas. Adaptive inpaint repairs variable backgrounds; flat colour is simpler. Accessibility structure gives screen readers an explicit reading order.</p>
          <p>Changing these options after completion reuses the existing translation and only renders the PDF again.</p>
        </div>
      </div>
    </dialog>
  `;

  const primary = element.querySelector('.pdf-render-primary');
  const secondary = element.querySelector('.pdf-render-secondary');
  const output = element.querySelector('.pdf-render-output');
  const dismissLayer = element.querySelector('.pdf-render-dismiss-layer');
  const panel = element.querySelector('.pdf-render-panel');
  const panelClose = element.querySelector('.pdf-render-panel-close');
  const helpTrigger = element.querySelector('.pdf-render-help-trigger');
  const helpDialog = element.querySelector('.pdf-render-help-dialog');
  const helpClose = element.querySelector('.pdf-render-help-close');
  const controls = new Map();
  let values = normalizePdfRenderOptions();
  let envelope = null;
  let busy = false;
  let open = false;
  let isAvailable = false;

  for (const definition of FIELD_DEFINITIONS) {
    const field = document.createElement('label');
    field.className = 'pdf-render-field';
    field.innerHTML = `
      <span>${definition.label}</span>
      <select data-pdf-render="${definition.key}" aria-describedby="pdfRenderReason-${definition.key}"></select>
      <small id="pdfRenderReason-${definition.key}" hidden></small>
    `;
    (definition.primary ? primary : definition.output ? output : secondary).append(field);
    const select = field.querySelector('select');
    select.addEventListener('change', () => {
      if (select.value === '__na__') return;
      values = normalizePdfRenderOptions({ ...values, [definition.key]: select.value });
      sync();
      onChange({ ...values });
    });
    controls.set(definition.key, { definition, select, reason: field.querySelector('small') });
  }

  trigger.addEventListener('click', () => setOpen(!open));
  dismissLayer.addEventListener('click', () => setOpen(false, { restoreFocus: true }));
  panelClose.addEventListener('click', () => setOpen(false, { restoreFocus: true }));
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setOpen(false, { restoreFocus: true });
  });
  helpTrigger.addEventListener('click', () => {
    if (!helpDialog.open) helpDialog.showModal();
  });
  helpClose.addEventListener('click', () => helpDialog.close());
  helpDialog.addEventListener('click', (event) => {
    if (event.target === helpDialog) helpDialog.close();
  });
  helpDialog.addEventListener('close', () => {
    if (isAvailable && open) helpTrigger.focus();
  });

  function setOpen(nextOpen, { restoreFocus = false } = {}) {
    open = Boolean(nextOpen);
    element.classList.toggle('is-open', open);
    trigger.classList.toggle('is-active', open);
    trigger.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    if (open) panelClose.focus();
    else if (restoreFocus && !trigger.hidden) trigger.focus();
  }

  function setAvailable(available) {
    const nextAvailable = Boolean(available);
    isAvailable = nextAvailable;
    if (!nextAvailable) {
      setOpen(false);
      if (helpDialog.open) helpDialog.close();
    }
    element.hidden = !nextAvailable;
    trigger.hidden = !nextAvailable;
  }

  function sync() {
    const reasons = pdfRenderApplicability(values, envelope);
    for (const [key, control] of controls) {
      const reason = reasons[key] || '';
      const reasonText = typeof reason === 'string' ? reason : '';
      control.select.replaceChildren();
      if (reason) {
        control.select.add(new Option('n/a', '__na__'));
        control.select.value = '__na__';
      } else {
        for (const [optionValue, label] of control.definition.options) {
          control.select.add(new Option(label, optionValue));
        }
        control.select.value = String(values[key]);
      }
      control.select.disabled = busy || Boolean(reason);
      control.reason.textContent = reasonText;
      control.reason.hidden = !reasonText;
    }
  }

  function setValues(nextValues) {
    values = normalizePdfRenderOptions(nextValues);
    sync();
  }

  function setEnvelope(nextEnvelope) {
    envelope = nextEnvelope || null;
    sync();
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    sync();
  }

  sync();
  setOpen(false);
  setAvailable(false);
  return {
    element,
    getValues: () => ({ ...values }),
    setAvailable,
    setValues,
    setEnvelope,
    setBusy,
  };
}
