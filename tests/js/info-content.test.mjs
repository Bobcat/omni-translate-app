import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INFO_CATEGORIES,
  getInfoCategory,
} from '../../static/shared/info/index.js';

test('third-party software notice is available as an info category', () => {
  const notice = getInfoCategory('third-party-software');

  assert.ok(notice);
  assert.equal(notice.title, 'Third-party software');
  assert.ok(notice.sections.some((section) => section.title === 'Website and account access'));
  assert.ok(notice.sections.some((section) => section.title === 'Translation and document processing'));
});

test('third-party software notice links to full upstream licence sources', () => {
  const notice = INFO_CATEGORIES.find((category) => category.id === 'third-party-software');
  const links = notice.sections.flatMap((section) => section.links || []);

  assert.ok(links.length >= 10);
  assert.ok(links.every((link) => link.href.startsWith('https://')));
  assert.ok(links.some((link) => link.href.includes('pypdfium2.readthedocs.io')));
  assert.ok(links.some((link) => link.href.includes('openai/whisper')));
});
