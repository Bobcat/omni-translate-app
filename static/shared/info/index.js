// Shared Info & help content and DOM rendering for the mobile and desktop
// frontends. Keep product claims factual: this is guidance, not a privacy or
// service-level policy.

export const INFO_CATEGORIES = [
  {
    id: 'about',
    label: 'About',
    title: 'About Omni Translate',
    summary: 'Why the project exists, how it is built and how PDF quality is measured.',
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
          'It remains my personal pet project. I am the project’s only engineer. I develop, host and maintain it independently. This gives me the freedom to spend time on problems such as document quality that I find worth solving properly.',
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
    label: 'How it works',
    title: 'How translation works',
    summary: 'What each translation mode does with its source.',
    lead: 'Each translation mode uses the context and structure that matter to its source.',
    sections: [
      {
        id: 'choose-a-mode',
        title: 'Choose by source',
        paragraphs: [
          'Use Text for text you can copy, Voice for spoken conversation, Image for text inside a picture and PDF for complete documents.',
        ],
      },
      {
        id: 'text',
        title: 'Text',
        paragraphs: [
          'Text translation uses the surrounding sentences to keep wording natural and consistent.',
        ],
      },
      {
        id: 'voice',
        title: 'Voice',
        paragraphs: [
          'Voice translation recognises and translates each spoken turn. It shows both the recognised speech and the translation, and can speak the result aloud. The selected direction applies to the current turn; swap languages when the other person speaks.',
        ],
      },
      {
        id: 'images',
        title: 'Images',
        paragraphs: [
          'Image translation finds visible text, translates it and places the translation back into the image. The result keeps the words connected to their original visual context.',
        ],
      },
      {
        id: 'pdfs',
        title: 'PDFs',
        paragraphs: [
          'PDF translation uses both text and page structure. It works with digital text, scanned pages and documents that combine the two.',
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
        id: 'three-kinds',
        title: 'Three kinds of PDF',
        bullets: [
          'Born-digital: exported from software such as a word processor or layout program. The letters are stored as selectable text, so the app can read them directly.',
          'Scanned: contains images of pages. Omni Translate uses optical character recognition, or OCR, to turn those images into translatable text.',
          'Hybrid: combines born-digital text with scanned pages or image-based text in the same document.',
        ],
      },
      {
        id: 'complex-layouts',
        title: 'Complex page layouts',
        paragraphs: [
          'Any of these PDF types can contain columns, forms, footnotes, charts or text inside illustrations. Omni Translate detects this page structure and uses it to build the translated pages.',
        ],
      },
      {
        id: 'building-pages',
        title: 'Building the translated pages',
        paragraphs: [
          'For every PDF, Omni Translate composes new pages for the translation. It adjusts placement, line breaks and text size when the target language needs more or less space than the source.',
        ],
      },
      {
        id: 'best-pdf-result',
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
        id: 'context-and-layout',
        title: 'Built for more than plain text',
        paragraphs: [
          'Documents, images and conversations contain more than individual sentences. Page order, text position and surrounding speech all add useful context. The app uses that information for the translation.',
        ],
      },
      {
        id: 'quality-inputs',
        title: 'What helps quality',
        bullets: [
          'Complete sentences and pages provide useful context.',
          'Clear audio and sharp scans make recognition more accurate.',
          'Consistent terminology helps specialist documents read naturally.',
          'Original files preserve more information than screenshots or compressed copies.',
        ],
      },
      {
        id: 'final-check',
        title: 'A quick final check',
        paragraphs: [
          'A short review makes any translation more useful. Check names, dates, amounts and specialist terms. For documents, look over tables, captions and page order as well.',
        ],
      },
      {
        id: 'professional-material',
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
    summary: 'How plans, credits and reservations work.',
    lead: 'Your plan provides a monthly credit budget. Work that uses credits shows the exact amount before it starts.',
    sections: [
      {
        id: 'account-required',
        title: 'Do I need an account?',
        paragraphs: [
          'No. Guest can be used without an account. Free requires sign-in so its credit balance is available on any signed-in device.',
        ],
      },
      {
        id: 'available-credits',
        title: 'Your available credits',
        paragraphs: [
          'The sidebar shows your current plan and available credits. Account shows the monthly grant, renewal date and the available Guest and Free plans. Included monthly credits do not carry over.',
          'PDF translation currently uses credits. Text, voice and image translation do not currently deduct from this balance.',
        ],
      },
      {
        id: 'before-work-starts',
        title: 'Before work starts',
        paragraphs: [
          'Uploading and inspecting a PDF does not use credits. The app first counts the pages and source characters, then shows one fixed credit amount. The confirmation dialog repeats that amount and the target language.',
          'The amount you confirm is the amount the work uses. It does not increase if the actual processing costs more than expected.',
        ],
      },
      {
        id: 'reservations-and-settlement',
        title: 'Reservations and settlement',
        bullets: [
          'Confirmation reserves the displayed credits and reduces the available balance immediately.',
          'Completed work uses the reserved credits.',
          'Cancelling before processing starts returns the complete reservation.',
          'Stopping after processing starts does not return the credits.',
          'A confirmed technical failure returns the reserved credits.',
          'If the final status is still unknown, the credits stay reserved until it is known.',
        ],
      },
      {
        id: 'document-limits',
        title: 'Document limits',
        paragraphs: [
          'Credits are the shared usage budget. A plan can also limit the size of one job. Guest translates a preview from a longer PDF; Free accepts longer PDFs within its per-document limit.',
        ],
      },
    ],
  },
  {
    id: 'privacy',
    label: 'Privacy',
    title: 'Privacy and file handling',
    summary: 'Where content is processed and how long it remains available.',
    lead: 'The current public version uses self-hosted translation and speech services. These are the retention settings in effect on 16 August 2026.',
    sections: [
      {
        id: 'current-limitations',
        style: 'notice',
        title: 'What is not in place yet',
        paragraphs: [
          'Omni Translate does not yet provide an in-app way to delete an account or its usage records. Temporary files are not stored in a personal document library and cannot be recovered from a backup. Do not submit confidential or regulated material that requires a contractual retention or deletion guarantee.',
        ],
      },
      {
        id: 'where-processing-happens',
        title: 'Where processing happens',
        paragraphs: [
          'Your text, audio, images and PDFs are processed on infrastructure operated by OmniScripta. They are not sent to an external translation or AI provider.',
          'Website traffic passes through Cloudflare. Google and Supabase handle sign-in when you choose to use an account. The browser also loads interface resources from Google Fonts and, when sign-in is enabled, the Google and jsDelivr content-delivery networks. These providers receive the connection data needed to deliver those services, not the content you submit for translation.',
        ],
      },
      {
        id: 'temporary-content',
        title: 'Temporary translation content',
        bullets: [
          'Text is handled without creating a document job. A successful translated result can remain in the app’s in-memory retry cache for up to 30 seconds.',
          'Image and PDF uploads, intermediate files and results are scheduled for deletion 24 hours after a completed or failed job. Data from a cancelled job is scheduled for deletion after 10 minutes.',
          'Voice audio chunks, the session transcript export and generated speech are kept for about 15 minutes after the voice session ends, then removed by the session cleanup process.',
        ],
      },
      {
        id: 'technical-records',
        title: 'Technical and usage records',
        paragraphs: [
          'A technical job record can remain for up to 400 days. It contains identifiers, task and status information, timestamps, timing and progress data, errors, artifact references and credit metadata. It does not contain the uploaded file or the full request and response payloads.',
          'The app also keeps internal account or anonymous identifiers, job ownership and usage events so it can enforce allowances and reconnect a browser with pending work. These control records do not contain the source document or translated document.',
          'Diagnostic logs can contain session or request identifiers, status, timing, counts and errors. They are not intended to contain submitted text or document files. The app does not yet enforce one published retention period across all host and service logs.',
        ],
      },
      {
        id: 'browser-storage',
        title: 'What the browser remembers',
        paragraphs: [
          'The browser stores preferences, sign-in state and identifiers that help recover pending work after a reload. Image and PDF recovery store an operation identifier and basic recovery details, not the uploaded file itself.',
          'Clearing the site data removes this browser-side information. It does not delete technical or usage records already held by the server.',
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
          'Fast text and live translation: a Gemma 4 E4B instruction model served through vLLM.',
          'Document, image and best-quality translation: a Gemma 4 26B-A4B instruction model served through vLLM.',
          'Text recognition: PaddleOCR with PP-OCRv5.',
          'Page-layout recognition: PP-DocLayout_plus-L.',
          'Image background reconstruction: LaMa, used selectively to rebuild non-uniform backgrounds after source text is removed.',
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
          'The current system runs on self-hosted consumer-grade hardware, paired with a workstation-class GPU for demanding model workloads. The pool services keep models ready, divide limited GPU capacity between jobs and prevent one type of work from blocking everything else.',
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
          'A project listed here is not necessarily downloaded to your device. Exact versions and transitive dependencies can differ between services and deployment platforms. This notice was reviewed on 31 August 2026.',
        ],
      },
      {
        title: 'Website and account access',
        bullets: [
          {
            label: 'Supabase JavaScript client 2.x',
            href: 'https://github.com/supabase/supabase-js/blob/master/LICENSE',
            description: 'MIT. Supports optional sign-in and browser sessions.',
          },
          {
            label: 'jsDelivr',
            href: 'https://www.jsdelivr.com/',
            description: 'Delivers the Supabase client when account access is configured.',
          },
          {
            label: 'Cormorant Garamond',
            href: 'https://github.com/CatharsisFonts/Cormorant/blob/master/OFL.txt',
            description: 'SIL Open Font License 1.1. Provides display typography.',
          },
          {
            label: 'Inter',
            href: 'https://github.com/rsms/inter/blob/master/LICENSE.txt',
            description: 'SIL Open Font License 1.1. Provides interface typography.',
          },
          {
            label: 'Source Sans 3',
            href: 'https://github.com/adobe-fonts/source-sans/blob/release/LICENSE.md',
            description: 'SIL Open Font License 1.1. Provides interface typography.',
          },
          {
            label: 'Google Fonts',
            href: 'https://fonts.google.com/',
            description: 'Hosts and delivers the interface fonts. It is a Google service, not an open-source component.',
          },
          {
            label: 'Google Identity Services',
            href: 'https://developers.google.com/identity/gsi/web',
            description: 'Supports optional Google sign-in. It is a Google service, not an open-source component.',
          },
          {
            label: 'PDF.js 6.3.289',
            href: 'https://github.com/mozilla/pdf.js/blob/v6.3.289/LICENSE',
            description: 'Apache License 2.0. Renders PDF previews in the browser. Bundled fonts and image decoders retain their included licence notices.',
          },
        ],
      },
      {
        title: 'Application and service foundations',
        bullets: [
          {
            label: 'FastAPI',
            href: 'https://github.com/fastapi/fastapi/blob/master/LICENSE',
            description: 'MIT. Provides the HTTP API framework.',
          },
          {
            label: 'Pydantic',
            href: 'https://github.com/pydantic/pydantic/blob/main/LICENSE',
            description: 'MIT. Validates application and service data.',
          },
          {
            label: 'PyJWT',
            href: 'https://github.com/jpadilla/pyjwt/blob/master/LICENSE',
            description: 'MIT. Validates signed account tokens.',
          },
          {
            label: 'Uvicorn',
            href: 'https://github.com/Kludex/uvicorn/blob/master/LICENSE.md',
            description: 'BSD-3-Clause. Runs the Python web services.',
          },
          {
            label: 'HTTPX',
            href: 'https://github.com/encode/httpx/blob/master/LICENSE.md',
            description: 'BSD-3-Clause. Provides HTTP clients for service communication.',
          },
          {
            label: 'Protocol Buffers',
            href: 'https://github.com/protocolbuffers/protobuf/blob/main/LICENSE',
            description: 'BSD-3-Clause. Defines compact messages between services.',
          },
          {
            label: 'websockets',
            href: 'https://github.com/python-websockets/websockets/blob/main/LICENSE',
            description: 'BSD-3-Clause. Supports live browser sessions.',
          },
          {
            label: 'pypdf',
            href: 'https://github.com/py-pdf/pypdf/blob/main/LICENSE',
            description: 'BSD-3-Clause. Reads and prepares PDF documents.',
          },
          {
            label: 'gRPC',
            href: 'https://github.com/grpc/grpc/blob/master/LICENSE',
            description: 'Apache License 2.0. Carries requests between pool services and the app.',
          },
          {
            label: 'cryptography',
            href: 'https://github.com/pyca/cryptography/blob/main/LICENSE',
            description: 'Apache License 2.0 or BSD-3-Clause. Supports account-token verification.',
          },
          {
            label: 'Pillow',
            href: 'https://github.com/python-pillow/Pillow/blob/main/LICENSE',
            description: 'HPND. Reads and validates uploaded images.',
          },
        ],
      },
      {
        title: 'Translation and document processing',
        bullets: [
          {
            label: 'PaddlePaddle',
            href: 'https://github.com/PaddlePaddle/Paddle/blob/develop/LICENSE',
            description: 'Apache License 2.0. Runs Paddle-based OCR and document models.',
          },
          {
            label: 'PaddleOCR',
            href: 'https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE',
            description: 'Apache License 2.0. Recognizes text in images and scanned documents.',
          },
          {
            label: 'PaddleX',
            href: 'https://github.com/PaddlePaddle/PaddleX/blob/release/3.6/LICENSE',
            description: 'Apache License 2.0. Provides document-layout analysis components.',
          },
          {
            label: 'PyTorch',
            href: 'https://github.com/pytorch/pytorch/blob/main/LICENSE',
            description: 'BSD-3-Clause. Runs several image and speech models.',
          },
          {
            label: 'OpenCV',
            href: 'https://github.com/opencv/opencv/blob/4.x/LICENSE',
            description: 'Apache License 2.0. Provides image-processing operations.',
          },
          {
            label: 'LaMa',
            href: 'https://github.com/advimman/lama/blob/main/LICENSE',
            description: 'Apache License 2.0. Rebuilds selected image backgrounds after source text is removed.',
          },
          {
            label: 'pikepdf 10.11.0',
            href: 'https://github.com/pikepdf/pikepdf/blob/v10.11.0/LICENSE.txt',
            description: 'MPL-2.0. Provides Python PDF container and object handling.',
          },
          {
            label: 'qpdf',
            href: 'https://qpdf.readthedocs.io/en/stable/license.html',
            description: 'Apache License 2.0. Provides the PDF engine used by pikepdf.',
          },
          {
            label: 'pypdfium2 5.12.1',
            href: 'https://pypdfium2.readthedocs.io/en/stable/readme.html#licensing',
            description: 'Apache-2.0 or BSD-3-Clause. Wraps PDFium and includes a build-specific licence bundle.',
          },
          {
            label: 'PDFium',
            href: 'https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE',
            description: 'BSD-3-Clause with bundled third-party notices. Renders PDF pages for pypdfium2.',
          },
          {
            label: 'uharfbuzz 0.56.0',
            href: 'https://github.com/harfbuzz/uharfbuzz/blob/main/LICENSE',
            description: 'Apache License 2.0. Provides Python bindings for HarfBuzz.',
          },
          {
            label: 'HarfBuzz',
            href: 'https://github.com/harfbuzz/harfbuzz/blob/main/COPYING',
            description: 'MIT-style licence. Shapes text for translated document output.',
          },
          {
            label: 'FontTools',
            href: 'https://github.com/fonttools/fonttools/blob/main/LICENSE',
            description: 'MIT. Reads, subsets and prepares fonts used in document output.',
          },
          {
            label: 'Pyphen',
            href: 'https://github.com/Kozea/Pyphen/blob/main/LICENSE',
            description: 'GPL-2.0-or-later, LGPL-2.1-or-later or MPL-1.1. Provides language-aware word breaks. Bundled dictionaries retain their own licence notices.',
          },
        ],
      },
      {
        title: 'Speech and language models',
        bullets: [
          {
            label: 'Whisper',
            href: 'https://github.com/openai/whisper/blob/main/LICENSE',
            description: 'MIT. Provides the speech-recognition model and code.',
          },
          {
            label: 'WhisperX',
            href: 'https://github.com/m-bain/whisperX/blob/main/LICENSE',
            description: 'BSD-2-Clause. Adds the speech-recognition workflow used by ASR Pool.',
          },
          {
            label: 'faster-whisper',
            href: 'https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE',
            description: 'MIT. Runs optimized Whisper inference.',
          },
          {
            label: 'CTranslate2',
            href: 'https://github.com/OpenNMT/CTranslate2/blob/master/LICENSE',
            description: 'MIT. Provides the inference runtime used by faster-whisper.',
          },
          {
            label: 'vLLM',
            href: 'https://github.com/vllm-project/vllm/blob/main/LICENSE',
            description: 'Apache License 2.0. Serves the language models used for translation.',
          },
          {
            label: 'Gemma 4 E4B instruction model',
            href: 'https://huggingface.co/unsloth/gemma-4-E4B-it-NVFP4',
            description: 'Apache License 2.0. Handles fast text and live translation.',
          },
          {
            label: 'Gemma 4 26B-A4B instruction model',
            href: 'https://huggingface.co/nvidia/Gemma-4-26B-A4B-NVFP4',
            description: 'Apache License 2.0. Handles document, image and best-quality translation.',
          },
          {
            label: 'Kokoro',
            href: 'https://huggingface.co/hexgrad/Kokoro-82M',
            description: 'Apache License 2.0. Generates speech with preset voices.',
          },
          {
            label: 'VoxCPM2',
            href: 'https://huggingface.co/openbmb/VoxCPM2',
            description: 'Apache License 2.0. Generates speech and supports voice cloning.',
          },
          {
            label: 'Nano-vLLM-VoxCPM',
            href: 'https://github.com/a710128/nanovllm-voxcpm/blob/main/LICENSE',
            description: 'MIT. Provides the concurrent VoxCPM2 inference backend.',
          },
          {
            label: 'Nano-vLLM core',
            href: 'https://github.com/GeeeekExplorer/nano-vllm/blob/main/LICENSE',
            description: 'MIT. Provides the inference core bundled with Nano-vLLM-VoxCPM.',
          },
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
];

export const INFO_QUESTIONS = [
  { question: 'Can Omni Translate translate a scanned PDF?', categoryId: 'pdfs', sectionId: 'three-kinds' },
  { question: 'Does the app preserve the document layout?', categoryId: 'pdfs', sectionId: 'building-pages' },
  { question: 'Which translation type should I choose?', categoryId: 'how-it-works', sectionId: 'choose-a-mode' },
  { question: 'How do I get the best PDF result?', categoryId: 'pdfs', sectionId: 'best-pdf-result' },
  { question: 'Should I review the translation?', categoryId: 'quality', sectionId: 'final-check' },
  { question: 'Do I need an account?', categoryId: 'usage', sectionId: 'account-required' },
  { question: 'How long are uploads and results kept?', categoryId: 'privacy', sectionId: 'temporary-content' },
  { question: 'Is my content sent to an external AI provider?', categoryId: 'privacy', sectionId: 'where-processing-happens' },
  { question: 'What happens to usage when a job fails?', categoryId: 'usage', sectionId: 'reservations-and-settlement' },
];

const INFO_GROUPS = [
  {
    title: 'Using Omni Translate',
    categoryIds: ['how-it-works', 'pdfs', 'quality'],
  },
  {
    title: 'Plans and privacy',
    categoryIds: ['usage', 'privacy'],
  },
  {
    title: 'Project and technology',
    categoryIds: ['about', 'under-the-hood'],
  },
];

export function getInfoCategory(categoryId) {
  return INFO_CATEGORIES.find((category) => category.id === categoryId) || null;
}

export function getInfoSection(categoryId, sectionId) {
  const category = getInfoCategory(categoryId);
  return category?.sections?.find((section) => infoSectionId(section) === sectionId) || null;
}

function infoSectionId(section) {
  if (section.id) return section.id;
  return String(section.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function infoGroupTitle(categoryId) {
  return INFO_GROUPS.find((group) => group.categoryIds.includes(categoryId))?.title || 'Reference';
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
    'Read how each translation mode works, how content is handled and what runs behind the app.',
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
      const href = typeof categoryHref === 'function' ? categoryHref(category.id, '') : '';
      const control = element(href ? 'a' : 'button', 'info-category-card');
      if (href) control.href = href;
      else control.type = 'button';
      control.dataset.infoCategory = category.id;
      control.setAttribute('aria-label', `Open ${category.label}`);

      const copy = element('span', 'info-category-copy');
      copy.append(
        element('strong', 'info-category-title', category.label),
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

  const questionIndex = element('section', 'info-question-index');
  questionIndex.appendChild(element('h2', 'info-question-index-title', 'Common questions'));
  const questionList = element('ul', 'info-question-list');
  for (const item of INFO_QUESTIONS) {
    const href = typeof categoryHref === 'function'
      ? categoryHref(item.categoryId, item.sectionId)
      : '';
    const listItem = element('li', '');
    const control = element(href ? 'a' : 'button', 'info-question-link', item.question);
    if (href) control.href = href;
    else control.type = 'button';
    control.dataset.infoCategory = item.categoryId;
    control.dataset.infoSection = item.sectionId;
    listItem.appendChild(control);
    questionList.appendChild(listItem);
  }
  questionIndex.appendChild(questionList);
  fragment.appendChild(questionIndex);

  const reference = getInfoCategory('third-party-software');
  const referenceRow = element('div', 'info-reference-row');
  referenceRow.appendChild(element('span', 'info-reference-label', 'Reference'));
  const referenceHref = typeof categoryHref === 'function' ? categoryHref(reference.id, '') : '';
  const referenceControl = element(
    referenceHref ? 'a' : 'button',
    'info-reference-link',
    'Third-party software and licences',
  );
  if (referenceHref) referenceControl.href = referenceHref;
  else referenceControl.type = 'button';
  referenceControl.dataset.infoCategory = reference.id;
  referenceRow.appendChild(referenceControl);
  fragment.appendChild(referenceRow);
  host.replaceChildren(fragment);
}

function appendSection(article, categoryId, section) {
  const sectionNode = element('section', 'info-article-section');
  const sectionId = infoSectionId(section);
  sectionNode.id = `info-${categoryId}-${sectionId}`;
  sectionNode.dataset.infoSection = sectionId;
  if (section.style === 'notice') sectionNode.classList.add('info-article-notice');
  sectionNode.appendChild(element('h2', '', section.title));
  for (const paragraph of section.paragraphs || []) {
    sectionNode.appendChild(element('p', '', paragraph));
  }
  if (section.bullets?.length) {
    const list = element('ul', '');
    for (const bullet of section.bullets) {
      const listItem = element('li', '');
      if (typeof bullet === 'string') {
        listItem.textContent = bullet;
      } else {
        const link = element('a', 'info-article-component-link', bullet.label);
        link.href = bullet.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        listItem.append(link, ` — ${bullet.description}`);
      }
      list.appendChild(listItem);
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
  return sectionNode;
}

export function renderInfoArticle(host, categoryId, {
  showBack = false,
  showTitle = true,
  overviewHref = '',
  sectionId = '',
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
  header.appendChild(element('p', 'info-eyebrow', infoGroupTitle(category.id)));
  if (showTitle) header.appendChild(element('h1', 'info-title', category.title));
  header.appendChild(element('p', 'info-lead', category.lead));
  article.appendChild(header);

  let targetSection = null;
  for (const section of category.sections || []) {
    const sectionNode = appendSection(article, category.id, section);
    if (infoSectionId(section) === sectionId) targetSection = sectionNode;
  }
  fragment.appendChild(article);
  host.replaceChildren(fragment);
  return targetSection;
}
