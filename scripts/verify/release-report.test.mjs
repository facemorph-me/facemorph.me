import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, labCells, timingCell, markdown } from './release-report.mjs';

const C = 'c0ffee';
const identity = { deploySource: { commit: C, sourceTreeSha256: 'tree' } };
const cell = (id, ok, extra = {}) => ({
  cell: id,
  ok,
  status: ok ? 'pass' : 'fail',
  journeys: ['cold-face'],
  artifact: { source: { commit: C } },
  runs: [{ cold: { route: id.includes('webgpu') ? 'GPU (webgpu)' : 'CPU' } }],
  evidenceErrors: ok ? [] : ['expected the WebGPU route'],
  ...extra,
});
const ALL = [
  'eris-cpu',
  'eris-webgpu',
  'eris-firefox-cpu',
  'eris-firefox-webgpu',
  'phone-cpu',
  'phone-webgpu',
];
const pass = {
  verdict: 'pass',
  digests: { build: 'd' },
  segments: { face: { rows: [{ measure: 'warmFaceMs', ok: true, ratio: 0.9 }] } },
};

test('every required local cell passing on the same artifact allows handover; hosted cells untested do not block', () => {
  const r = buildReport({
    identity,
    timing: pass,
    labs: [{ cells: ALL.map((id) => cell(id, true)) }],
  });
  assert.equal(r.handover, 'allowed');
  assert.equal(r.classes['desktop Chrome'], 'passed');
  assert.equal(r.classes['iOS (Simulator)'], 'untested');
  assert.deepEqual(r.claims.sort(), ['Android (P30 Pro)', 'desktop Chrome', 'desktop Firefox']);
});

test('a failed timing measure fails its class and names the measure', () => {
  const fail = {
    verdict: 'fail',
    segments: { face: { rows: [{ measure: 'repeatSaveMs', ok: false, ratio: 1.819 }] } },
  };
  assert.equal(timingCell(fail).reason, 'face repeatSaveMs 1.82x');
  const r = buildReport({
    identity,
    timing: fail,
    labs: [{ cells: ALL.map((id) => cell(id, true)) }],
  });
  assert.equal(r.handover, 'blocked');
  assert.equal(r.classes['desktop Chrome'], 'failed');
  assert.equal(r.classes['desktop Firefox'], 'passed'); // a loss on one class never moves another
});

test('timing still wanting pairs is inconclusive, which blocks a required cell', () => {
  assert.equal(timingCell({ verdict: 'more', segments: {} }).verdict, 'inconclusive');
});

test('a cell measured on another commit is untested, never merged', () => {
  const other = cell('phone-webgpu', true, { artifact: { source: { commit: 'beef' } } });
  const r = buildReport({
    identity,
    timing: pass,
    labs: [
      { cells: [...ALL.filter((x) => x !== 'phone-webgpu').map((id) => cell(id, true)), other] },
    ],
  });
  const c = r.cells.find((x) => x.id === 'phone-webgpu');
  assert.equal(c.verdict, 'untested');
  assert.match(c.reason, /beef/);
  assert.equal(r.handover, 'blocked');
});

test('the single pass and the phone pairs combine to the worse verdict', () => {
  const merged = labCells([
    { cells: [cell('phone-webgpu', true)] },
    { cells: [cell('phone-webgpu', false)] },
  ]);
  assert.equal(merged['phone-webgpu'].verdict, 'failed');
  assert.equal(
    labCells([{ cells: [cell('phone-cpu', true)] }, { cells: [cell('phone-cpu', true)] }])[
      'phone-cpu'
    ].verdict,
    'passed',
  );
});

test('a missing required cell blocks; lab-untested stays untested', () => {
  const r = buildReport({
    identity,
    timing: pass,
    labs: [{ cells: [cell('eris-cpu', false, { status: 'untested' })] }],
  });
  assert.equal(r.cells.find((x) => x.id === 'eris-cpu').verdict, 'untested');
  assert.equal(r.cells.find((x) => x.id === 'phone-cpu').reason, 'no evidence for this cell');
  assert.equal(r.handover, 'blocked');
  assert.match(markdown(r), /Handover: \*\*blocked\*\*/);
});

test('an available hosted failure blocks; a hosted pass is claimed', () => {
  const labs = [{ cells: ALL.map((id) => cell(id, true)) }];
  const bad = buildReport({
    identity,
    timing: pass,
    labs,
    hosted: { 'ios-simulator': { verdict: 'failed', reason: 'crash' } },
  });
  assert.equal(bad.handover, 'blocked');
  const good = buildReport({
    identity,
    timing: pass,
    labs,
    hosted: { 'ios-simulator': { verdict: 'passed' } },
  });
  assert.ok(good.claims.includes('iOS (Simulator)'));
  assert.ok(!good.claims.includes('iOS (physical iPhone)')); // never inferred from the Simulator
});
