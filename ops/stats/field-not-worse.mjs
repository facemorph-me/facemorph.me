// Real-visitor not-worse check (fm-js8i): the monorepo build's real-visitor jobs against the candidate's, per
// platform class (ios, android, desktop), action and route, from the changeover statistics on the triton Prometheus.
//
// Windows. Before: everything the candidate build sent (its counters stopped growing at the next.facemorph.me
// handover, so its value at --before-end is its whole recorded life; the sink only shipped on 24 October, so this
// is days, not the four weeks PLAN.md hoped for). After: the monorepo build's counter growth between --after-start
// and --after-end.
//
// Verdicts are count tests, so they are honest about small samples instead of comparing two noisy medians:
// - failure share and cancel share: Wilson 95% intervals; `worse` only when the after interval lies wholly above
//   the before interval.
// - median and p90 job duration (completed jobs, histogram buckets): take the before quantile's bucket upper bound
//   B; `worse` only when the share of after jobs slower than B is, by Wilson intervals, wholly above the share of
//   before jobs slower than B. A quantile that moves within its bucket therefore reads as unchanged.
// - time to first result (cold, warm): the same quantile rule per platform.
// - a row with fewer than --min jobs (visits) on either side is `untested`, never `ok`.
// Exit 1 when any row is `worse`. `untested` rows never fail the run and never count as passing.
//
// Usage: node ops/stats/field-not-worse.mjs [--prom http://localhost:9090] [--host next]
//   [--after-start 2026-10-30T00:00:00Z] [--after-end now] [--before-end now] [--min 20] [--json out.json]
// Run on triton (Prometheus listens on localhost:9090 there) or through an SSH tunnel to it.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PLATFORMS = ['desktop', 'android', 'ios'];
export const ACTIONS = ['face', 'photo', 'morph', 'blend', 'names'];

/** Wilson 95% interval for k successes in n trials. */
export function wilson(k, n, z = 1.96) {
  if (n <= 0) return { lo: 0, hi: 1, p: NaN };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h), p };
}

/** Share comparison: `worse` when after's interval lies wholly above before's, `better` when wholly below. */
export function compareShare(beforeK, beforeN, afterK, afterN, min) {
  if (beforeN < min || afterN < min)
    return { verdict: 'untested', why: `n ${beforeN}/${afterN} < ${min}` };
  const b = wilson(beforeK, beforeN);
  const a = wilson(afterK, afterN);
  const verdict = a.lo > b.hi ? 'worse' : a.hi < b.lo ? 'better' : 'ok';
  return { verdict, before: b.p, after: a.p };
}

/**
 * Cumulative histogram as [[le, count], ...] sorted by le (le may be Infinity). Returns the bucket upper bound
 * holding quantile q and the number of observations above it.
 */
export function quantileBucket(buckets, q) {
  const total = buckets.length ? buckets[buckets.length - 1][1] : 0;
  if (total <= 0) return { le: NaN, total: 0 };
  for (const [le, c] of buckets) if (c >= q * total) return { le, total };
  return { le: Infinity, total };
}

/** Observations above `le` in a cumulative histogram (le must be one of its bounds, or above all of them). */
export function countAbove(buckets, le) {
  const total = buckets.length ? buckets[buckets.length - 1][1] : 0;
  let atOrBelow = 0;
  for (const [b, c] of buckets) if (b <= le) atOrBelow = c;
  return total - atOrBelow;
}

/** Quantile comparison by the before quantile's bucket bound (see the header). */
export function compareQuantile(before, after, q, min) {
  const bq = quantileBucket(before, q);
  const at = after.length ? after[after.length - 1][1] : 0;
  if (bq.total < min || at < min)
    return { verdict: 'untested', why: `n ${bq.total}/${at} < ${min}` };
  const aq = quantileBucket(after, q);
  if (!Number.isFinite(bq.le))
    return {
      verdict: 'untested',
      why: 'before quantile in the +Inf bucket',
      beforeLe: bq.le,
      afterLe: aq.le,
    };
  const s = compareShare(countAbove(before, bq.le), bq.total, countAbove(after, bq.le), at, min);
  return { verdict: s.verdict, beforeLe: bq.le, afterLe: aq.le, n: [bq.total, at] };
}

// ---------- Prometheus ----------

async function instant(prom, query, time) {
  const u = new URL('/api/v1/query', prom);
  u.searchParams.set('query', query);
  u.searchParams.set('time', String(time));
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} from Prometheus for ${query}`);
  const j = await r.json();
  if (j.status !== 'success') throw new Error(`Prometheus: ${j.error}`);
  return j.data.result.map((s) => ({ m: s.metric, v: Number(s.value[1]) }));
}

/** Counter values per label set at `time`, over a long lookback so frozen or sparse series still read. */
async function counters(prom, metric, app, host, by, time) {
  const q = `sum by (${by.join(',')}) (last_over_time(${metric}{app="${app}",host="${host}"}[90d]))`;
  return instant(prom, q, time);
}

const key = (m, by) => by.map((l) => m[l] ?? '').join('|');

/** Growth between two instants per label set (absent at the start reads as 0; counter resets are not expected). */
async function growth(prom, metric, app, host, by, start, end) {
  const [e, s] = await Promise.all([
    counters(prom, metric, app, host, by, end),
    start == null ? Promise.resolve([]) : counters(prom, metric, app, host, by, start),
  ]);
  const base = new Map(s.map((x) => [key(x.m, by), x.v]));
  return e.map((x) => ({ m: x.m, v: Math.max(0, x.v - (base.get(key(x.m, by)) ?? 0)) }));
}

const sum = (rows, pred) => rows.filter((r) => pred(r.m)).reduce((a, r) => a + r.v, 0);

function histogram(rows, pred) {
  const by = new Map();
  for (const r of rows) {
    if (!pred(r.m)) continue;
    const le = r.m.le === '+Inf' ? Infinity : Number(r.m.le);
    by.set(le, (by.get(le) ?? 0) + r.v);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]);
}

export async function collect({ prom, host, afterStart, afterEnd, beforeEnd }) {
  const jobsBy = ['platform', 'action', 'route', 'outcome'];
  const durBy = ['platform', 'action', 'route', 'le'];
  const ttfrBy = ['platform', 'cache', 'le'];
  const side = (app, start, end) =>
    Promise.all([
      growth(prom, 'fm_web_jobs_total', app, host, jobsBy, start, end),
      growth(prom, 'fm_web_job_duration_seconds_bucket', app, host, durBy, start, end),
      growth(prom, 'fm_web_time_to_first_result_seconds_bucket', app, host, ttfrBy, start, end),
    ]).then(([jobs, dur, ttfr]) => ({ jobs, dur, ttfr }));
  const [before, after] = await Promise.all([
    side('candidate', null, beforeEnd),
    side('monorepo', afterStart, afterEnd),
  ]);
  return { before, after };
}

/** Pure: rows of the report from collected series. */
export function report({ before, after }, min) {
  const rows = [];
  const scopes = [];
  for (const platform of PLATFORMS)
    for (const action of ACTIONS) {
      scopes.push({ platform, action, route: 'all' });
      for (const route of ['auto', 'cpu', 'webgpu']) scopes.push({ platform, action, route });
    }
  for (const s of scopes) {
    const match = (m) =>
      m.platform === s.platform &&
      m.action === s.action &&
      (s.route === 'all' || m.route === s.route);
    const n = (side) => sum(side.jobs, match);
    const k = (side, outcome) => sum(side.jobs, (m) => match(m) && m.outcome === outcome);
    const bn = n(before),
      an = n(after);
    if (bn === 0 && an === 0) continue;
    const scope = `${s.platform} ${s.action} ${s.route}`;
    for (const outcome of ['failed', 'cancelled'])
      rows.push({
        scope,
        measure: `${outcome} share`,
        n: [bn, an],
        ...compareShare(k(before, outcome), bn, k(after, outcome), an, min),
      });
    const bh = histogram(before.dur, match),
      ah = histogram(after.dur, match);
    rows.push({ scope, measure: 'median duration', ...compareQuantile(bh, ah, 0.5, min) });
    rows.push({ scope, measure: 'p90 duration', ...compareQuantile(bh, ah, 0.9, min) });
  }
  for (const platform of PLATFORMS)
    for (const cache of ['cold', 'warm']) {
      const match = (m) => m.platform === platform && m.cache === cache;
      const bh = histogram(before.ttfr, match),
        ah = histogram(after.ttfr, match);
      if (!bh.length && !ah.length) continue;
      rows.push({
        scope: `${platform} first result ${cache}`,
        measure: 'median',
        ...compareQuantile(bh, ah, 0.5, min),
      });
    }
  return rows;
}

const fmt = (x) =>
  x == null || Number.isNaN(x)
    ? ''
    : typeof x === 'number'
      ? x < 1
        ? (100 * x).toFixed(1) + '%'
        : String(x)
      : String(x);

export function table(rows) {
  const lines = [
    '| verdict | scope | measure | before | after | n before/after | note |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const b = r.before ?? (r.beforeLe != null ? `<= ${r.beforeLe} s` : '');
    const a = r.after ?? (r.afterLe != null ? `<= ${r.afterLe} s` : '');
    lines.push(
      `| ${r.verdict} | ${r.scope} | ${r.measure} | ${fmt(b)} | ${fmt(a)} | ${(r.n ?? []).join('/')} | ${r.why ?? ''} |`,
    );
  }
  return lines.join('\n');
}

function args(argv) {
  const o = {
    prom: 'http://localhost:9090',
    host: 'next',
    afterStart: '2026-10-30T00:00:00Z',
    afterEnd: 'now',
    beforeEnd: 'now',
    min: 20,
    json: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(k in o)) throw new Error(`unknown argument ${argv[i]}`);
    o[k] = k === 'min' ? Number(argv[i + 1]) : argv[i + 1];
  }
  const t = (s) => (s === 'now' ? Date.now() / 1000 : Date.parse(s) / 1000);
  return { ...o, afterStart: t(o.afterStart), afterEnd: t(o.afterEnd), beforeEnd: t(o.beforeEnd) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const o = args(process.argv.slice(2));
  const rows = report(await collect(o), o.min);
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(table(rows));
  console.log(
    `\n${count('worse')} worse, ${count('ok')} ok, ${count('better')} better, ${count('untested')} untested (min ${o.min} per side; host ${o.host}; after from ${new Date(o.afterStart * 1000).toISOString()})`,
  );
  if (o.json) await writeFile(o.json, JSON.stringify({ options: o, rows }, null, 2));
  process.exitCode = count('worse') ? 1 : 0;
}
