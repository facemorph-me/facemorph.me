// The first face's device check speaks one line with its step count (product-bridge deviceCheckLine).
// The stage order is the one the CPU worker emits on a cold device: the check starts, the model downloads, then
// seven reference syntheses, each after a small fixture download, then the face's own mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceCheckLine } from './product-bridge.mjs';

test('the device check holds one stepped line once the model is loaded, then lets the face speak', () => {
  const lines = [];
  const say = (stage, event) => lines.push([stage, deviceCheckLine(stage, event)]);
  say('canary', { loaded: 0, total: 7 });
  say('asset-acquisition', { loaded: 1, total: 9 });
  say('model-loading');
  say('model-loaded');
  say('synthesis');
  say('synthesis-complete', { elapsedMs: 7000 });
  say('asset-acquisition', { loaded: 8, total: 9 });
  say('canary', { loaded: 1, total: 7 });
  say('asset-acquisition', { loaded: 9, total: 9 });
  say('synthesis');
  say('canary', { loaded: 6, total: 7 });
  say('mapping');
  say('synthesis');
  assert.deepEqual(lines, [
    // Before the model is here the download speaks for itself.
    ['canary', undefined],
    ['asset-acquisition', undefined],
    ['model-loading', undefined],
    ['model-loaded', null],
    ['synthesis', 'Checking this device… step 1 of 7'],
    ['synthesis-complete', null],
    ['asset-acquisition', null],
    ['canary', 'Checking this device… step 2 of 7'],
    ['asset-acquisition', null],
    ['synthesis', 'Checking this device… step 2 of 7'],
    ['canary', 'Checking this device… step 7 of 7'],
    // The face's own stages are not the check's.
    ['mapping', undefined],
    ['synthesis', undefined],
  ]);
});
