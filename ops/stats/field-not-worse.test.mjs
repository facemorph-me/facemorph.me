import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wilson,
  compareShare,
  quantileBucket,
  countAbove,
  compareQuantile,
  report,
} from './field-not-worse.mjs';

const hist = (counts) => {
  // counts per bucket for bounds 1, 2, 5, 10, 20, +Inf -> cumulative
  const les = [1, 2, 5, 10, 20, Infinity];
  let c = 0;
  return les.map((le, i) => [le, (c += counts[i] ?? 0)]);
};

test('wilson bounds contain p and stay in [0,1]', () => {
  const w = wilson(5, 10);
  assert.ok(w.lo < 0.5 && w.hi > 0.5 && w.lo >= 0 && w.hi <= 1);
  assert.equal(wilson(0, 0).hi, 1);
});

test('share: too few jobs is untested, never ok', () => {
  assert.equal(compareShare(1, 5, 0, 500, 20).verdict, 'untested');
  assert.equal(compareShare(1, 500, 0, 5, 20).verdict, 'untested');
});

test('share: a clearly higher failure share is worse; a lower one is better; a small change is ok', () => {
  assert.equal(compareShare(2, 200, 60, 200, 20).verdict, 'worse');
  assert.equal(compareShare(60, 200, 2, 200, 20).verdict, 'better');
  assert.equal(compareShare(10, 200, 13, 200, 20).verdict, 'ok');
});

test('higher failure share flags even when timings improve', () => {
  const before = {
    jobs: [
      { m: { platform: 'ios', action: 'face', route: 'cpu', outcome: 'completed' }, v: 190 },
      { m: { platform: 'ios', action: 'face', route: 'cpu', outcome: 'failed' }, v: 10 },
    ],
    dur: [],
    ttfr: [],
  };
  const after = {
    jobs: [
      { m: { platform: 'ios', action: 'face', route: 'cpu', outcome: 'completed' }, v: 120 },
      { m: { platform: 'ios', action: 'face', route: 'cpu', outcome: 'failed' }, v: 80 },
    ],
    dur: [],
    ttfr: [],
  };
  const rows = report({ before, after }, 20);
  const f = rows.find((r) => r.scope === 'ios face all' && r.measure === 'failed share');
  assert.equal(f.verdict, 'worse');
  // the regression names its class only: desktop has no rows at all
  assert.ok(!rows.some((r) => r.scope.startsWith('desktop')));
});

test('quantile bucket and count above', () => {
  const h = hist([10, 30, 40, 20]); // total 100
  assert.deepEqual(quantileBucket(h, 0.5), { le: 5, total: 100 });
  assert.equal(countAbove(h, 5), 20);
  assert.equal(countAbove(h, 2), 60);
});

test('quantile: a move within one bucket reads unchanged', () => {
  const before = hist([0, 0, 100]); // all in (2,5]
  const after = hist([0, 0, 100]);
  assert.equal(compareQuantile(before, after, 0.5, 20).verdict, 'ok');
});

test('quantile: clearly slower is worse; faster within the before bound reads ok', () => {
  const before = hist([0, 100, 0, 0]);
  const slower = hist([0, 10, 10, 80]);
  const faster = hist([90, 10, 0, 0]);
  assert.equal(compareQuantile(before, slower, 0.5, 20).verdict, 'worse');
  assert.equal(compareQuantile(before, faster, 0.9, 20).verdict, 'ok');
  const r = compareQuantile(hist([0, 0, 100]), faster, 0.5, 20);
  assert.equal(r.verdict, 'ok');
  assert.equal(r.afterLe, 1);
});

test('quantile: few jobs is untested', () => {
  assert.equal(compareQuantile(hist([5]), hist([500]), 0.5, 20).verdict, 'untested');
});
