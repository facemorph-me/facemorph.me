// The "no worse than the candidate" report for the cutover decision (fm-6rcm; fm-4gw7 reads it): one named artifact,
// one verdict per platform class, joined from the evidence qualify.yml already produces on that artifact:
//   --timing  timing-verdict.json from the paired timing gate (scripts/verify/not-worse/median-check.mjs; eris Chrome)
//   --lab     summary.json from tools/device-lab/lab.py matrix runs (the six cells; the phone pairs against the
//             pinned control). Repeatable.
//   --hosted  JSON { "<cell id>": { verdict, reason } } for hosted iOS Simulator / Android emulator cells. Optional.
//   --identity next-site-identity.json of the artifact (commit and digest).
// The verdict rule is scripts/verify/not-worse.mjs releaseVerdict: a class is claimed only when every listed cell of
// it passed; required local cells (eris, the P30 Pro) block when they did not pass; an explicitly unavailable hosted
// cell is untested and does not block; a physical iPhone is optional evidence and never inferred from the Simulator.
//   node scripts/verify/release-report.mjs --identity id.json --timing t.json --lab a.json --lab b.json [--json out]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { releaseVerdict } from './not-worse.mjs';

/** Every cell the report requires, by platform class. `local` cells are required evidence. */
export const LISTED = [
  {
    id: 'timing-eris-chrome-cpu',
    class: 'desktop Chrome',
    local: true,
    what: 'paired timing vs control (face, morph, photo)',
  },
  { id: 'eris-cpu', class: 'desktop Chrome', local: true, what: 'live journeys, CPU' },
  { id: 'eris-webgpu', class: 'desktop Chrome', local: true, what: 'live journeys, WebGPU' },
  { id: 'eris-firefox-cpu', class: 'desktop Firefox', local: true, what: 'live journeys, CPU' },
  {
    id: 'eris-firefox-webgpu',
    class: 'desktop Firefox',
    local: true,
    what: 'live journeys, WebGPU',
  },
  {
    id: 'phone-cpu',
    class: 'Android (P30 Pro)',
    local: true,
    what: 'live journeys, CPU; cold face judged by the pairs',
  },
  {
    id: 'phone-webgpu',
    class: 'Android (P30 Pro)',
    local: true,
    what: 'live journeys, WebGPU; cold face judged by the pairs',
  },
  { id: 'ios-simulator', class: 'iOS (Simulator)', local: false, what: 'hosted, best effort' },
  {
    id: 'android-emulator',
    class: 'Android (emulator)',
    local: false,
    what: 'hosted, best effort',
  },
  {
    id: 'iphone-physical',
    class: 'iOS (physical iPhone)',
    local: false,
    what: 'optional evidence',
  },
];

/** Pure: the timing gate's verdict file as one cell result. `more` (pairs still wanted) is inconclusive. */
export function timingCell(t) {
  if (!t) return null;
  const failed = [];
  for (const [segment, s] of Object.entries(t.segments ?? {}))
    for (const r of s.rows ?? [])
      if (r.timed !== false && r.ok === false)
        failed.push(`${segment} ${r.measure} ${r.ratio.toFixed(2)}x`);
  const verdict =
    t.verdict === 'pass' ? 'passed' : t.verdict === 'more' ? 'inconclusive' : 'failed';
  return {
    verdict,
    reason:
      verdict === 'passed'
        ? Object.keys(t.segments ?? {}).join(', ') + ' within the rule'
        : failed.join('; ') || t.verdict,
    digest: t.digests?.build,
  };
}

/**
 * Pure: lab summary.json documents to cell results. A cell appearing in several documents (the single pass, then the
 * phone pairs against the pinned control) takes the worst verdict among them: lab.py already moves the single pass's
 * cold-face budget breaches to the pairs (budgetDeferredToPairs), so nothing is judged twice. lab.py's `untested`
 * stays untested; any other non-ok is failed. Each result keeps the commit its artifact was built from.
 */
const RANK = { failed: 0, untested: 1, inconclusive: 2, passed: 3 };
export function labCells(docs) {
  const out = {};
  for (const doc of docs)
    for (const c of doc.cells ?? []) {
      const errors = c.evidenceErrors ?? [];
      const verdict = c.ok ? 'passed' : c.status === 'untested' ? 'untested' : 'failed';
      const route = c.runs?.flatMap((r) => [r.cold?.route, r.warm?.route]).find(Boolean);
      const reason =
        verdict === 'passed'
          ? `${(c.journeys ?? []).join(', ')}${c.controlComparison ? ' vs control' : ''}; route ${route ?? 'unrecorded'}`
          : errors.join('; ') || c.status;
      const commit = c.artifact?.source?.commit ?? null;
      const prev = out[c.cell];
      if (!prev) out[c.cell] = { verdict, reason, commit };
      else
        out[c.cell] = {
          verdict: RANK[verdict] < RANK[prev.verdict] ? verdict : prev.verdict,
          reason: `${prev.reason} | ${reason}`,
          commit: prev.commit === commit ? commit : `${prev.commit} / ${commit}`,
        };
    }
  return out;
}

/**
 * Pure: the whole report. A lab cell measured on another commit's artifact than the identity's is untested: rows
 * from different artifacts are never merged into one verdict.
 */
export function buildReport({ identity, timing, labs = [], hosted = {} }) {
  const commit = identity?.deploySource?.commit ?? null;
  const results = {};
  for (const [id, r] of Object.entries(labCells(labs)))
    results[id] =
      commit && r.commit !== commit
        ? {
            verdict: 'untested',
            reason: `measured on ${r.commit ?? 'an unbound artifact'}, not ${commit}`,
          }
        : r;
  Object.assign(results, hosted);
  const t = timingCell(timing);
  if (t) results['timing-eris-chrome-cpu'] = t;
  const v = releaseVerdict({ listed: LISTED, results });
  return {
    commit,
    sourceTreeSha256: identity?.deploySource?.sourceTreeSha256 ?? null,
    timingBuildDigest: t?.digest ?? null,
    ...v,
  };
}

export function markdown(r) {
  const lines = [
    `## No worse than the candidate: ${r.commit ?? 'unknown commit'}`,
    '',
    `Source tree \`${r.sourceTreeSha256 ?? 'unknown'}\`; timed artifact \`${r.timingBuildDigest ?? 'none'}\`. Handover: **${r.handover}**${r.blockers.length ? ` (${r.blockers.length} blocking)` : ''}.`,
    '',
    '| Class | Verdict |',
    '|---|---|',
    ...Object.entries(r.classes).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| Cell | Class | Required | Verdict | Evidence |',
    '|---|---|---|---|---|',
    ...r.cells.map(
      (c) =>
        `| ${c.id} | ${c.class} | ${c.local ? 'yes' : 'no'} | ${c.verdict} | ${String(
          c.reason ?? '',
        )
          .replace(/\|/g, '/')
          .slice(0, 200)} |`,
    ),
  ];
  return lines.join('\n');
}

function main(argv) {
  const o = { labs: [], hosted: {} };
  let json = null;
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    const read = () => JSON.parse(readFileSync(v, 'utf8'));
    if (k === '--identity') o.identity = read();
    else if (k === '--timing') o.timing = read();
    else if (k === '--lab') o.labs.push(read());
    else if (k === '--hosted') o.hosted = read();
    else if (k === '--json') json = v;
    else throw new Error(`unknown argument ${k}`);
  }
  const r = buildReport(o);
  console.log(markdown(r));
  if (json) writeFileSync(json, JSON.stringify(r, null, 2));
  return r.handover === 'allowed' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = main(process.argv.slice(2));
