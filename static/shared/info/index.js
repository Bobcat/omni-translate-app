// Shared Info & help content and DOM rendering for the mobile and desktop
// frontends. Keep product claims factual: this is guidance, not a privacy or
// service-level policy.

export const INFO_CATEGORIES = [
  {
    id: 'quick-start',
    label: 'Getting started',
    title: 'Quick start',
    summary: 'The first steps for text, voice, images and PDFs.',
    lead: 'Choose the translation type that matches your source. Each workflow starts differently and keeps the controls relevant to that format.',
    sections: [
      {
        title: 'Text translation',
        paragraphs: [
          'Paste or type your text, then choose the target language. Translation starts automatically after a short pause. Copy the result when it is ready.',
        ],
      },
      {
        title: 'Voice translation',
        paragraphs: [
          'Choose the source and target languages, start a session and allow microphone access. Speak when the session is ready. The app shows the recognised speech and its translation, and can speak the result aloud.',
        ],
      },
      {
        title: 'Image translation',
        paragraphs: [
          'Choose the target language, then select or drop a PNG, JPEG or WebP image. Translation starts when the file is accepted. Compare the original and translated image, then download the result.',
        ],
      },
      {
        title: 'PDF translation',
        paragraphs: [
          'Choose the target language, then select or drop a PDF. The app checks the file and starts processing it. Follow the page progress and download the translated PDF when it completes.',
          'Anonymous use can translate a preview of the first pages. The PDF view shows the current page allowance before you upload a document.',
        ],
      },
    ],
  },
  {
    id: 'about',
    label: 'About',
    title: 'About Omni Translate',
    summary: 'The purpose and ideas behind the app.',
    lead: 'Omni Translate is an OmniScripta project. It brings text, voice, image and document translation together in one app.',
    sections: [
      {
        title: 'How it started',
        paragraphs: [
          'The project began in January 2026 with a personal need. I wanted to transcribe audio, but none of the services I tried gave me the result I needed. So I wrote my own WhisperX script.',
          'When the Dutch transcript still needed correction, I asked ChatGPT to build a browser-based transcript editor with a synchronised audio player. It produced a working first version in a single response. I found that remarkable, and it brought back my interest in software engineering after four years away from it.',
        ],
      },
      {
        title: 'Who is behind it',
        paragraphs: [
          'My name is Gunnar. I spent several decades as a backend software engineer in the financial services industry. In 2008, I joined a hedge fund as its second employee. I built the backend of the fund\u2019s trading system, which could trade in markets around the world. When the founders later launched a brokerage for professional and retail clients, we built it around that same system. Serving external clients brought very different operational demands and European regulatory requirements. The company grew into one of Europe\u2019s largest brokers.',
          'In my final role, I led the department responsible for that system. The work was rarely out of my mind, and the role gradually took me further away from the engineering work I enjoyed. I later took early retirement.',
          'That experience still shapes this project: reliable services, clear system states and behaviour that can be measured and tested.',
        ],
        mediaTitle: 'Measured and tested',
        media: [
          {
            src: '/assets/info/workbench-pdf-benchmark.png',
            width: 735,
            height: 600,
            alt: 'Workbench benchmark table showing preservation measurements for Omni Translate across PDF test documents.',
            caption: 'The PDF benchmark records preservation measurements for each document in the test corpus. This view shows only Omni Translate runs.',
          },
          {
            src: '/assets/info/workbench-pdf-regression.png',
            width: 1200,
            height: 360,
            alt: 'Workbench PDF regression view showing a passed two-page fixture.',
            caption: 'A regression replay compares the current result with an accepted fixture and reports a verdict for every page.',
          },
        ],
      },
      {
        title: 'What the project became',
        paragraphs: [
          'The first transcript tool led to services for speech recognition, language models, document processing and generated speech. Omni Translate brings those parts together for text, voice, image and PDF translation.',
          'It remains my personal pet project. I develop and host it independently, with the freedom to spend time on problems such as document quality that I find worth solving properly.',
        ],
      },
      {
        title: 'What matters to me',
        bullets: [
          'Translations that preserve meaning, readability and document structure.',
          'Simple workflows for text, conversations, images and documents.',
          'Technical complexity that stays behind a clear interface.',
          'Clear information about plans, usage and how each feature works.',
        ],
      },
    ],
  },
  {
    id: 'how-it-works',
    label: 'Guide',
    title: 'How translation works',
    summary: 'What happens in text, voice, image and PDF translation.',
    lead: 'Each type of content is handled in the way that suits it best. This helps the app use context, structure and layout.',
    sections: [
      {
        title: 'Text',
        paragraphs: [
          'Text translation works directly with the words you enter. It uses the surrounding sentences to produce a natural, consistent translation.',
        ],
      },
      {
        title: 'Voice',
        paragraphs: [
          'Voice translation turns speech into written text, translates it and can speak the result in the target language. You can listen, read the recognised text and hear the translation in one place.',
        ],
      },
      {
        title: 'Images',
        paragraphs: [
          'Image translation finds visible text, translates it and places the translation back into the image. The result keeps the words connected to their original visual context.',
        ],
      },
      {
        title: 'PDFs',
        paragraphs: [
          'PDF translation looks at both text and page structure. It can work with digital text, scanned pages and documents that combine the two.',
        ],
      },
      {
        title: 'Specialised from start to finish',
        paragraphs: [
          'Behind the scenes, Omni Translate uses separate tools matched to each format. These include speech recognition, OCR, translation, page layout and spoken output.',
        ],
      },
    ],
  },
  {
    id: 'pdfs',
    label: 'Documents',
    title: 'PDFs and scanned documents',
    summary: 'Born-digital files, scans, OCR and complex page layouts.',
    lead: 'PDF translation is a core part of Omni Translate. It works with born-digital, scanned and hybrid PDFs while keeping text and page structure together.',
    sections: [
      {
        title: 'Three kinds of PDF',
        bullets: [
          'Born-digital: exported from software such as a word processor or layout program. The letters are stored as selectable text, so the app can read them directly.',
          'Scanned: contains images of pages. Omni Translate uses optical character recognition, or OCR, to turn those images into translatable text.',
          'Hybrid: combines born-digital text with scanned pages or image-based text in the same document.',
        ],
      },
      {
        title: 'Complex page layouts',
        paragraphs: [
          'Any of these PDF types can contain columns, forms, footnotes, charts or text inside illustrations. Omni Translate detects this page structure and uses it to build the translated pages.',
        ],
      },
      {
        title: 'Building the translated pages',
        paragraphs: [
          'For every PDF, Omni Translate composes new pages for the translation. It adjusts placement, line breaks and text size when the target language needs more or less space than the source.',
        ],
      },
      {
        title: 'Get the best PDF result',
        bullets: [
          'Choose the original digital PDF when you have it.',
          'Use a sharp, correctly oriented scan with complete page edges.',
          'Remove password protection so the document can be processed.',
        ],
      },
    ],
  },
  {
    id: 'quality',
    label: 'Quality',
    title: 'Getting the best translation',
    summary: 'How context, source quality and a quick review help.',
    lead: 'Omni Translate uses context, recognised text and page layout together. This is especially important for documents, where meaning and structure belong together.',
    sections: [
      {
        title: 'Built for more than plain text',
        paragraphs: [
          'Documents, images and conversations contain more than individual sentences. Page order, text position and surrounding speech all add useful context. The app uses that information for the translation.',
        ],
      },
      {
        title: 'What helps quality',
        bullets: [
          'Complete sentences and pages provide useful context.',
          'Clear audio and sharp scans make recognition more accurate.',
          'Consistent terminology helps specialist documents read naturally.',
          'Original files preserve more information than screenshots or compressed copies.',
        ],
      },
      {
        title: 'A quick final check',
        paragraphs: [
          'A short review makes any translation more useful. Check names, dates, amounts and specialist terms. For documents, look over tables, captions and page order as well.',
        ],
      },
      {
        title: 'Important professional material',
        paragraphs: [
          'Omni Translate can save substantial time on specialist material. Legal, medical, financial and safety-critical translations should still receive the professional review required for their intended use.',
        ],
      },
    ],
  },
  {
    id: 'usage',
    label: 'Plans',
    title: 'Usage and plans',
    summary: 'How allowances, balances and reservations work.',
    lead: 'Your plan defines the allowances and limits for each translation type. PDF translation, for example, is measured in pages.',
    sections: [
      {
        title: 'Your available usage',
        paragraphs: [
          'Your available usage depends on the current plan. The PDF view shows the page balance for a signed-in account or the preview limit for anonymous use.',
        ],
      },
      {
        title: 'While a job is running',
        paragraphs: [
          'When a job starts, the app can temporarily set aside the usage it expects to need. This keeps the displayed balance accurate when more than one job is running. The balance is updated when the job finishes.',
        ],
      },
      {
        title: 'How the balance is updated',
        bullets: [
          'Completed work is deducted from the applicable balance.',
          'If a job fails because of a confirmed technical problem, its reserved usage is returned.',
          'If the final result is still being checked, the usage stays reserved until the status is known.',
          'A job cancelled after processing has started may still count toward usage.',
        ],
      },
      {
        title: 'Units that match the translation type',
        paragraphs: [
          'A PDF plan can count pages, while another translation type can count jobs or the amount of original text. This makes each balance easier to understand.',
        ],
      },
    ],
  },
  {
    id: 'privacy',
    label: 'Trust',
    title: 'Privacy and file handling',
    summary: 'Where content is processed and how long it remains available.',
    lead: 'The current public version uses self-hosted translation and speech services. These are the retention settings in effect on 16 August 2026.',
    sections: [
      {
        title: 'Where processing happens',
        paragraphs: [
          'Your text, audio, images and PDFs are processed on infrastructure operated by OmniScripta. They are not sent to an external translation or AI provider.',
          'Website traffic passes through Cloudflare. Google and Supabase handle sign-in when you choose to use an account. The browser also loads interface resources from Google Fonts and, when sign-in is enabled, the Google and jsDelivr content-delivery networks. These providers receive the connection data needed to deliver those services, not the content you submit for translation.',
        ],
      },
      {
        title: 'Temporary translation content',
        bullets: [
          'Text is handled without creating a document job. A successful translated result can remain in the app’s in-memory retry cache for up to 30 seconds.',
          'Image and PDF uploads, intermediate files and results are scheduled for deletion 24 hours after a completed or failed job. Data from a cancelled job is scheduled for deletion after 10 minutes.',
          'Voice audio chunks, the session transcript export and generated speech are kept for about 15 minutes after the voice session ends, then removed by the session cleanup process.',
        ],
      },
      {
        title: 'Technical and usage records',
        paragraphs: [
          'A technical job record can remain for up to 400 days. It contains identifiers, task and status information, timestamps, timing and progress data, errors, artifact references and quota metadata. It does not contain the uploaded file or the full request and response payloads.',
          'The app also keeps internal account or anonymous identifiers, job ownership and usage events so it can enforce allowances and reconnect a browser with pending work. These control records do not contain the source document or translated document.',
          'Diagnostic logs can contain session or request identifiers, status, timing, counts and errors. They are not intended to contain submitted text or document files. The app does not yet enforce one published retention period across all host and service logs.',
        ],
      },
      {
        title: 'What the browser remembers',
        paragraphs: [
          'The browser stores preferences, sign-in state and identifiers that help recover pending work after a reload. Image and PDF recovery store an operation identifier and basic recovery details, not the uploaded file itself.',
          'Clearing the site data removes this browser-side information. It does not delete technical or usage records already held by the server.',
        ],
      },
      {
        title: 'Deletion and sensitive material',
        paragraphs: [
          'Temporary files are not placed in a personal document library, and the app does not offer backup recovery for them. There is not yet an in-app control for deleting an account or its usage records. Until a direct deletion channel and formal privacy policy are available, do not submit confidential or regulated material that requires a contractual retention or deletion guarantee.',
        ],
      },
    ],
  },
  {
    id: 'under-the-hood',
    label: 'Technology',
    title: 'Under the hood',
    summary: 'The services, models and hardware behind the app.',
    lead: 'Omni Translate is not built around one model. It combines separate services for speech recognition, translation, document analysis and generated speech.',
    sections: [
      {
        title: 'A set of specialised services',
        bullets: [
          'ASR Pool keeps speech-recognition workers ready and schedules incoming audio.',
          'LLM Pool loads and schedules the language and vision models used for translation and document analysis.',
          'Translation Services processes text, images and PDFs, including OCR, page analysis, translation and rendering.',
          'TTS Pool turns translated text into speech and streams the generated audio back to the app.',
        ],
      },
      {
        title: 'Current models',
        bullets: [
          'Speech recognition: WhisperX with the Whisper large-v3 model.',
          'Fast text and live translation: a Gemma 4 E4B instruction model.',
          'Document, image and best-quality translation: a Gemma 4 26B-A4B instruction model served through vLLM.',
          'Text recognition: PaddleOCR with PP-OCRv5.',
          'Page-layout recognition: PP-DocLayout_plus-L.',
          'Speech generation: Kokoro and VoxCPM2, including a NanoVLLM-based VoxCPM2 backend.',
        ],
      },
      {
        title: 'How documents are processed',
        paragraphs: [
          'Each PDF page is classified as born-digital, scanned or hybrid. Digital pages provide selectable text and style information. Scanned pages are read with OCR. Page-layout recognition helps identify columns, tables, figures, formulas and other regions.',
          'The extracted text is grouped into meaningful units, translated and composed into new pages. Image translation uses a related process and can use LaMa inpainting to rebuild the background where source text was removed.',
        ],
      },
      {
        title: 'Current infrastructure',
        paragraphs: [
          'The current system runs on self-hosted consumer-grade hardware. The pool services keep models ready, divide limited GPU capacity between jobs and prevent one type of work from blocking everything else.',
          'This is a practical constraint, not a design ideal. I would prefer to run Omni Translate on a dedicated NVIDIA datacenter accelerator such as an H200, hosted in the EEA. Keeping that class of hardware available continuously costs thousands of euros per month, which is not viable for a personal project at this stage.',
        ],
      },
      {
        title: 'Models change as the project develops',
        paragraphs: [
          'These names describe the configured stack in August 2026. A model can be replaced when another option improves quality, language coverage or efficiency. The surrounding services keep the app workflow stable when that happens.',
        ],
      },
      {
        title: 'Source code',
        paragraphs: [
          'The source code for the app and its supporting services lives in repositories on GitHub.',
        ],
        links: [
          { label: 'My GitHub profile', href: 'https://github.com/Bobcat' },
        ],
      },
    ],
  },
  {
    id: 'third-party-software',
    label: 'Licences',
    title: 'Third-party software',
    summary: 'Open-source licences and acknowledgements.',
    lead: 'Omni Translate uses open-source libraries, models and fonts. This page credits the main projects behind the website and its supporting services.',
    sections: [
      {
        title: 'About this notice',
        paragraphs: [
          'This notice covers software delivered to your browser and the main third-party components used on OmniScripta infrastructure. Server-side projects are included for transparency, even when their licences do not require a notice for hosted use.',
          'A project listed here is not necessarily downloaded to your device. Exact versions and transitive dependencies can differ between services and deployment platforms. This notice was reviewed on 23 August 2026.',
        ],
      },
      {
        title: 'Website and account access',
        bullets: [
          'Supabase JavaScript client 2.x — MIT — supports optional sign-in and browser sessions. It is loaded from jsDelivr only when account access is configured.',
          'Cormorant Garamond, Inter and Source Sans 3 — SIL Open Font License 1.1 — provide interface typography through Google Fonts.',
          'Google Identity Services supports optional Google sign-in. It is a Google service, not an open-source component. Its role is also described under Privacy and file handling.',
        ],
        links: [
          { label: 'Supabase JavaScript client — MIT licence', href: 'https://github.com/supabase/supabase-js/blob/master/LICENSE' },
          { label: 'SIL Open Font License 1.1', href: 'https://openfontlicense.org/open-font-license-official-text/' },
        ],
      },
      {
        title: 'Application and service foundations',
        bullets: [
          'FastAPI and PyJWT — MIT.',
          'Uvicorn, HTTPX, Protocol Buffers, websockets and pypdf — BSD licences.',
          'gRPC — Apache License 2.0.',
          'cryptography — Apache License 2.0 or BSD-3-Clause.',
          'Pillow — HPND.',
        ],
        links: [
          { label: 'FastAPI — MIT licence', href: 'https://github.com/fastapi/fastapi/blob/master/LICENSE' },
          { label: 'gRPC — Apache License 2.0', href: 'https://github.com/grpc/grpc/blob/master/LICENSE' },
          { label: 'HTTPX — BSD-3-Clause licence', href: 'https://github.com/encode/httpx/blob/master/LICENSE.md' },
        ],
      },
      {
        title: 'Translation and document processing',
        bullets: [
          'PaddlePaddle, PaddleOCR and PaddleX — Apache License 2.0 — provide OCR and document-analysis components.',
          'PyTorch — BSD-3-Clause; OpenCV — Apache License 2.0; LaMa — Apache License 2.0.',
          'pikepdf 10.11.0 — MPL-2.0 — uses qpdf under Apache License 2.0 for PDF container and object handling.',
          'pypdfium2 5.12.1 — Apache-2.0 or BSD-3-Clause — packages PDFium and its build-specific third-party licence bundle.',
          'uharfbuzz 0.56.0 — Apache License 2.0 — packages HarfBuzz under its MIT-style licence for text shaping.',
          'FontTools — MIT — reads, subsets and prepares fonts used in document output.',
        ],
        links: [
          { label: 'PaddleX — Apache License 2.0', href: 'https://github.com/PaddlePaddle/PaddleX/blob/release/3.6/LICENSE' },
          { label: 'pypdfium2 and PDFium licensing', href: 'https://pypdfium2.readthedocs.io/en/stable/readme.html#licensing' },
          { label: 'qpdf — Apache License 2.0', href: 'https://qpdf.readthedocs.io/en/stable/license.html' },
          { label: 'pikepdf wheel licence bundle', href: 'https://github.com/pikepdf/pikepdf/blob/v10.11.0/licenses-for-wheels.txt' },
        ],
      },
      {
        title: 'Speech and language models',
        bullets: [
          'Whisper code and model weights — MIT; WhisperX — BSD-2-Clause — support speech recognition.',
          'vLLM — Apache License 2.0 — serves language models used for translation.',
          'The configured Gemma 4 translation model is published under Apache License 2.0.',
          'Kokoro and VoxCPM2 — Apache License 2.0 — are available in the speech-generation stack.',
        ],
        links: [
          { label: 'Whisper — MIT licence', href: 'https://github.com/openai/whisper/blob/main/LICENSE' },
          { label: 'WhisperX — BSD-2-Clause licence', href: 'https://github.com/m-bain/whisperX/blob/main/LICENSE' },
          { label: 'vLLM — Apache License 2.0', href: 'https://github.com/vllm-project/vllm/blob/main/LICENSE' },
          { label: 'Configured Gemma 4 model card', href: 'https://huggingface.co/nvidia/Gemma-4-26B-A4B-NVFP4' },
          { label: 'Kokoro model card', href: 'https://huggingface.co/hexgrad/Kokoro-82M' },
          { label: 'VoxCPM2 model card', href: 'https://huggingface.co/openbmb/VoxCPM2' },
        ],
      },
      {
        title: 'Copyright and trademarks',
        paragraphs: [
          'Copyright remains with each project and its contributors. The linked licence files contain the applicable copyright notices and terms. Project and product names remain trademarks of their respective owners. Their inclusion does not imply endorsement of Omni Translate.',
        ],
      },
    ],
  },
  {
    id: 'faq',
    label: 'FAQ',
    title: 'Frequently asked questions',
    summary: 'Short answers to common questions about the app.',
    lead: 'Find quick answers about documents, accounts, quality and usage. The other guides offer more background when you want it.',
    questions: [
      {
        question: 'Can Omni Translate translate a scanned PDF?',
        answer: 'Yes. Omni Translate uses OCR to read scanned pages before translating them. Sharp, straight pages with good contrast give the app the best source.',
      },
      {
        question: 'Does the app preserve the document layout?',
        answer: 'The PDF feature uses the original page structure when composing the translation. It adjusts text size, placement and line breaks when the target language needs a different amount of space.',
      },
      {
        question: 'Which translation type should I choose?',
        answer: 'Use Text for text you can copy, Voice for conversations, Image for text inside a picture and PDF for complete documents. Each option uses a workflow designed for that format.',
      },
      {
        question: 'How do I get the best PDF result?',
        answer: 'Upload the original digital PDF when possible. For scans, use sharp and correctly oriented pages with complete edges. Remove password protection before uploading.',
      },
      {
        question: 'Should I review the translation?',
        answer: 'A quick review is useful for every important translation. Check names, dates, amounts and specialist terms. Material used for legal, medical, financial or safety decisions should receive the professional review required for that purpose.',
      },
      {
        question: 'Do I need an account?',
        answer: 'Some workflows can be used anonymously with their own allowances. Signing in applies the plan and balance linked to your account.',
      },
      {
        question: 'How long are uploads and results kept?',
        answer: 'Completed and failed image or PDF jobs are scheduled for deletion after 24 hours. Cancelled job data is scheduled for deletion after 10 minutes. Voice session files are kept for about 15 minutes after the session ends. See Privacy and file handling for the separate technical-record retention period.',
      },
      {
        question: 'Is my content sent to an external AI provider?',
        answer: 'No. Text, speech, images and PDFs are translated on infrastructure operated by OmniScripta. External services used for site delivery and optional sign-in do not perform the translation.',
      },
      {
        question: 'What happens to usage when a job fails?',
        answer: 'If a job fails because of a confirmed technical problem, its reserved usage is returned to the balance. If the final result is still being checked, the usage stays reserved until the status is known.',
      },
    ],
  },
];

const INFO_GROUPS = [
  {
    title: 'Get started',
    categoryIds: ['quick-start', 'how-it-works', 'pdfs', 'quality'],
  },
  {
    title: 'Account and data',
    categoryIds: ['usage', 'privacy', 'faq'],
  },
  {
    title: 'About the project',
    categoryIds: ['about', 'under-the-hood', 'third-party-software'],
  },
];

export function getInfoCategory(categoryId) {
  return INFO_CATEGORIES.find((category) => category.id === categoryId) || null;
}

function element(tagName, className, text = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function arrowMarkup() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path>
    </svg>
  `;
}

export function renderInfoOverview(host, { showTitle = true, categoryHref = null } = {}) {
  const fragment = document.createDocumentFragment();
  const header = element('header', 'info-intro');
  const eyebrow = element('p', 'info-eyebrow', 'Guides and information');
  header.appendChild(eyebrow);
  if (showTitle) header.appendChild(element('h1', 'info-title', 'Info & help'));
  header.appendChild(element(
    'p',
    'info-lead',
    'Start with a practical guide, learn how each translation type works or read about the project and its technology.',
  ));
  fragment.appendChild(header);

  const groups = element('div', 'info-category-groups');
  for (const group of INFO_GROUPS) {
    const section = element('section', 'info-category-group');
    section.appendChild(element('h2', 'info-category-group-title', group.title));
    const grid = element('div', 'info-category-grid');
    for (const categoryId of group.categoryIds) {
      const category = getInfoCategory(categoryId);
      if (!category) continue;
      const href = typeof categoryHref === 'function' ? categoryHref(category.id) : '';
      const control = element(href ? 'a' : 'button', 'info-category-card');
      if (href) control.href = href;
      else control.type = 'button';
      control.dataset.infoCategory = category.id;
      control.setAttribute('aria-label', `Open ${category.title}`);

      const copy = element('span', 'info-category-copy');
      copy.append(
        element('span', 'info-category-label', category.label),
        element('strong', 'info-category-title', category.title),
        element('span', 'info-category-summary', category.summary),
      );
      const arrow = element('span', 'info-category-arrow');
      arrow.innerHTML = arrowMarkup();
      control.append(copy, arrow);
      grid.appendChild(control);
    }
    section.appendChild(grid);
    groups.appendChild(section);
  }
  fragment.appendChild(groups);

  const note = element('aside', 'info-trust-note');
  note.append(
    element('strong', '', 'New to Omni Translate?'),
    element('p', '', 'Quick start shows the exact first steps for text, voice, image and PDF translation.'),
  );
  fragment.appendChild(note);
  host.replaceChildren(fragment);
}

function appendSection(article, section) {
  const sectionNode = element('section', 'info-article-section');
  sectionNode.appendChild(element('h2', '', section.title));
  for (const paragraph of section.paragraphs || []) {
    sectionNode.appendChild(element('p', '', paragraph));
  }
  if (section.bullets?.length) {
    const list = element('ul', '');
    for (const bullet of section.bullets) {
      list.appendChild(element('li', '', bullet));
    }
    sectionNode.appendChild(list);
  }
  if (section.links?.length) {
    const links = element('ul', 'info-article-links');
    for (const item of section.links) {
      const listItem = element('li', '');
      const link = element('a', '', item.label);
      link.href = item.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      listItem.appendChild(link);
      links.appendChild(listItem);
    }
    sectionNode.appendChild(links);
  }
  if (section.media?.length) {
    if (section.mediaTitle) {
      sectionNode.appendChild(element('h3', 'info-article-media-title', section.mediaTitle));
    }
    const media = element('div', 'info-article-media');
    for (const item of section.media) {
      const figure = element('figure', 'info-article-figure');
      const link = element('a', 'info-article-image-link');
      link.href = item.src;
      link.target = '_blank';
      link.rel = 'noopener';
      link.setAttribute('aria-label', `Open full-size screenshot: ${item.alt}`);

      const image = element('img', 'info-article-image');
      image.src = item.src;
      image.alt = item.alt;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.width = item.width;
      image.height = item.height;
      link.appendChild(image);
      figure.append(link, element('figcaption', '', item.caption));
      media.appendChild(figure);
    }
    sectionNode.appendChild(media);
  }
  article.appendChild(sectionNode);
}

function appendQuestions(article, questions) {
  const list = element('div', 'info-faq-list');
  questions.forEach((item, index) => {
    const details = element('details', 'info-faq-item');
    if (index === 0) details.open = true;
    details.append(
      element('summary', '', item.question),
      element('p', '', item.answer),
    );
    list.appendChild(details);
  });
  article.appendChild(list);
}

export function renderInfoArticle(host, categoryId, {
  showBack = false,
  showTitle = true,
  overviewHref = '',
} = {}) {
  const category = getInfoCategory(categoryId);
  if (!category) {
    renderInfoOverview(host, { showTitle });
    return;
  }

  const fragment = document.createDocumentFragment();
  if (showBack) {
    const back = element(overviewHref ? 'a' : 'button', 'info-back-button', 'All topics');
    if (overviewHref) back.href = overviewHref;
    else back.type = 'button';
    back.dataset.infoBack = '';
    fragment.appendChild(back);
  }

  const article = element('article', 'info-article');
  const header = element('header', 'info-article-header');
  header.appendChild(element('p', 'info-eyebrow', category.label));
  if (showTitle) header.appendChild(element('h1', 'info-title', category.title));
  header.appendChild(element('p', 'info-lead', category.lead));
  article.appendChild(header);

  for (const section of category.sections || []) appendSection(article, section);
  if (category.questions?.length) appendQuestions(article, category.questions);
  fragment.appendChild(article);
  host.replaceChildren(fragment);
}
