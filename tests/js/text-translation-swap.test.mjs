import assert from 'node:assert/strict';
import test from 'node:test';

import { nextTextSwapState } from '../../static/desktop/src/views/text/index.js';

test('text swap promotes the existing target text into the new source', () => {
  assert.deepEqual(nextTextSwapState({
    sourceLanguage: 'Dutch',
    targetLanguage: 'English',
    sourceText: 'Goedemorgen',
    targetText: 'Good morning',
  }), {
    sourceLanguage: 'English',
    targetLanguage: 'Dutch',
    sourceText: 'Good morning',
    promotedTargetText: true,
  });
});

test('text swap keeps the source text when no target text exists yet', () => {
  assert.deepEqual(nextTextSwapState({
    sourceLanguage: 'Dutch',
    targetLanguage: 'English',
    sourceText: 'Nog niet vertaald',
    targetText: '',
  }), {
    sourceLanguage: 'English',
    targetLanguage: 'Dutch',
    sourceText: 'Nog niet vertaald',
    promotedTargetText: false,
  });
});
