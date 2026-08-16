import assert from 'node:assert/strict';
import test from 'node:test';

import {
  micHaloVisual,
  normalizeMicLevel,
} from '../../static/src/shared/mic-level-visual.js';

test('microphone halo is shared, bounded, and silent while not listening', () => {
  assert.equal(normalizeMicLevel(-1), 0);
  assert.equal(normalizeMicLevel(2), 1);
  assert.equal(normalizeMicLevel('invalid'), 0);

  assert.deepEqual(micHaloVisual(0.7), {
    level: 0.7,
    clipRisk: false,
    scale: '1.000',
    color: 'transparent',
  });
});

test('microphone halo keeps a baseline and reacts to hot and clipping input', () => {
  assert.deepEqual(micHaloVisual(0, { listening: true }), {
    level: 0,
    clipRisk: false,
    scale: '1.220',
    color: 'rgba(59, 130, 246, 0.200)',
  });

  const hot = micHaloVisual(0.9, { listening: true });
  assert.equal(hot.scale, '1.550');
  assert.equal(hot.color, 'rgba(245, 158, 11, 0.440)');

  const clipping = micHaloVisual(1, { listening: true });
  assert.equal(clipping.clipRisk, true);
  assert.equal(clipping.color, 'rgba(185, 28, 28, 0.500)');
});
