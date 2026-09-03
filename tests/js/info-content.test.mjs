import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INFO_CATEGORIES,
  INFO_QUESTIONS,
  getInfoCategory,
  getInfoSection,
} from '../../static/shared/info/index.js';

test('info overview topics exclude procedural help and the FAQ answer store', () => {
  assert.equal(getInfoCategory('quick-start'), null);
  assert.equal(getInfoCategory('faq'), null);
  assert.equal(getInfoCategory('privacy').label, 'Privacy');
  assert.equal(getInfoCategory('how-it-works').label, 'How it works');
});

test('common questions link to canonical sections without storing answers', () => {
  assert.equal(INFO_QUESTIONS.length, 9);
  assert.ok(INFO_QUESTIONS.every((item) => !Object.hasOwn(item, 'answer')));
  assert.ok(INFO_QUESTIONS.every((item) => getInfoSection(item.categoryId, item.sectionId)));
});

test('privacy opens with the current product limitations', () => {
  const privacy = getInfoCategory('privacy');

  assert.equal(privacy.sections[0].id, 'current-limitations');
  assert.equal(privacy.sections[0].style, 'notice');
  assert.match(privacy.sections[0].paragraphs[0], /does not yet provide an in-app way to delete/);
});

test('third-party software notice is available as an info category', () => {
  const notice = getInfoCategory('third-party-software');

  assert.ok(notice);
  assert.equal(notice.title, 'Third-party software');
  assert.ok(notice.sections.some((section) => section.title === 'Website and account access'));
  assert.ok(notice.sections.some((section) => section.title === 'Translation and document processing'));
});

test('third-party software notice lists each product as its own linked entry', () => {
  const notice = INFO_CATEGORIES.find((category) => category.id === 'third-party-software');
  const entries = notice.sections.flatMap((section) => section.bullets || []);
  const labels = entries.map((entry) => entry.label);

  assert.ok(entries.length >= 40);
  assert.ok(entries.every((entry) => typeof entry === 'object'));
  assert.ok(entries.every((entry) => entry.href.startsWith('https://')));
  assert.ok(entries.every((entry) => entry.description));
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.includes('LaMa'));
  assert.ok(labels.includes('Pyphen'));
  assert.ok(labels.includes('PDF.js 6.3.289'));
  assert.ok(labels.includes('faster-whisper'));
  assert.ok(labels.includes('CTranslate2'));
  assert.ok(labels.includes('Nano-vLLM-VoxCPM'));
  assert.ok(labels.includes('Gemma 4 E4B instruction model'));
  assert.equal(
    entries.find((entry) => entry.label === 'Nano-vLLM core').href,
    'https://github.com/GeeeekExplorer/nano-vllm/blob/main/LICENSE',
  );
});
