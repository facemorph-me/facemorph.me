#!/usr/bin/env python3
"""Lossless snapshot of the anonymous changeover statistics (fm-js8i): every fm_web_* series on the triton
Prometheus, as change points, so the candidate's few days of real-visitor data outlive the stats Worker
(services/stats, retired by fm-q465) and any Prometheus loss.

The series are aggregate counters and histogram buckets labelled only by app, host, platform, route, action, outcome,
cache, visit, kind, method and le: no identifier, address or free text exists in them (usage-stats.ts closed
vocabulary). A counter is constant between changes, so keeping each series' first sample, every sample whose value
differs from the previous one, and its last sample loses nothing; `restore` writes OpenMetrics at any step for
`promtool tsdb create-blocks-from openmetrics`.

  python3 snapshot.py dump [--prom http://localhost:9090] [--start 2026-10-24] [--out fm-web-<date>.jsonl.gz]
  python3 snapshot.py restore <snapshot.jsonl.gz> [--step 60] > fm-web.om
  python3 snapshot.py totals <snapshot.jsonl.gz>    # per app: last value sums of jobs and visits (a sanity check)

Stdlib only: it runs on triton, beside Prometheus, which has no Node.
"""
import argparse
import datetime as dt
import gzip
import json
import sys
import urllib.parse
import urllib.request

SCHEMA = 'facemorph.stats-snapshot/1'
CHUNK_S = 86400  # one query per series per day keeps each response small


def get(prom, path, params):
    url = f"{prom}{path}?{urllib.parse.urlencode(params, doseq=True)}"
    with urllib.request.urlopen(url, timeout=120) as r:
        body = json.load(r)
    if body.get('status') != 'success':
        raise SystemExit(f"Prometheus: {body.get('error')}")
    return body['data']


def selector(labels):
    name = labels['__name__']
    rest = ','.join(f'{k}="{v}"' for k, v in sorted(labels.items()) if k != '__name__')
    return f'{name}{{{rest}}}'


def change_points(samples):
    """[[t, "v"], ...] in time order -> first, every value change, last. Pure."""
    out = []
    for t, v in samples:
        if not out or out[-1][1] != v:
            out.append([t, v])
        last = [t, v]
    if samples and out[-1] != last:
        out.append(last)
    return out


def dump(a):
    start = int(dt.datetime.fromisoformat(a.start).replace(tzinfo=dt.timezone.utc).timestamp())
    end = int(dt.datetime.now(dt.timezone.utc).timestamp())
    series = get(a.prom, '/api/v1/series', {'match[]': '{__name__=~"fm_web_.*"}', 'start': start, 'end': end})
    out = a.out or f"fm-web-{dt.date.today().isoformat()}.jsonl.gz"
    kept = raw = 0
    with gzip.open(out, 'wt', encoding='utf-8') as f:
        f.write(json.dumps({'schema': SCHEMA, 'prom': a.prom, 'start': start, 'end': end, 'series': len(series),
                            'taken': dt.datetime.now(dt.timezone.utc).isoformat()}) + '\n')
        for labels in sorted(series, key=lambda s: json.dumps(s, sort_keys=True)):
            labels = {k: v for k, v in labels.items() if k not in ('instance', 'job')}
            samples = []
            for t0 in range(start, end, CHUNK_S):
                t1 = min(end, t0 + CHUNK_S)
                d = get(a.prom, '/api/v1/query', {'query': f'{selector(labels)}[{t1 - t0}s]', 'time': t1})
                for r in d['result']:
                    samples.extend(r['values'])
            samples.sort(key=lambda x: x[0])
            dedup = []
            for s in samples:  # chunk edges can repeat a sample
                if not dedup or s[0] > dedup[-1][0]:
                    dedup.append(s)
            pts = change_points(dedup)
            raw += len(dedup)
            kept += len(pts)
            f.write(json.dumps({'labels': labels, 'points': pts}, separators=(',', ':')) + '\n')
    print(json.dumps({'out': out, 'series': len(series), 'rawSamples': raw, 'keptPoints': kept}))


def read(path):
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        head = json.loads(f.readline())
        if head.get('schema') != SCHEMA:
            raise SystemExit(f'unknown snapshot schema {head.get("schema")}')
        return head, [json.loads(line) for line in f]


def kind(name):
    return 'histogram' if name.endswith(('_bucket', '_sum', '_count')) and not name.endswith('_total') else 'counter'


def restore(a):
    head, rows = read(a.snapshot)
    by_family = {}
    for r in rows:
        name = r['labels']['__name__']
        family = name.rsplit('_', 1)[0] if kind(name) == 'histogram' else (name[:-len('_total')] if name.endswith('_total') else name)
        by_family.setdefault(family, []).append(r)
    w = sys.stdout.write
    for family, rs in sorted(by_family.items()):
        w(f"# TYPE {family} {kind(rs[0]['labels']['__name__'])}\n")
        for r in rs:
            sel = selector(r['labels'])
            pts = r['points']
            for i, (t, v) in enumerate(pts):
                t_next = pts[i + 1][0] if i + 1 < len(pts) else t + a.step / 2
                ts = t
                while ts < t_next:  # a counter holds its value until the next change point
                    w(f"{sel} {v} {ts:.3f}\n")
                    ts += a.step
    w('# EOF\n')


def totals(a):
    head, rows = read(a.snapshot)
    agg = {}
    for r in rows:
        name, app = r['labels']['__name__'], r['labels'].get('app', '')
        if name in ('fm_web_jobs_total', 'fm_web_visits_total'):
            agg.setdefault(app, {}).setdefault(name, 0.0)
            agg[app][name] += float(r['points'][-1][1])
    print(json.dumps({'taken': head['taken'], 'series': head['series'], 'totals': agg}, indent=1))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('dump')
    d.add_argument('--prom', default='http://localhost:9090')
    d.add_argument('--start', default='2026-10-24')
    d.add_argument('--out')
    r = sub.add_parser('restore')
    r.add_argument('snapshot')
    r.add_argument('--step', type=float, default=60.0)
    t = sub.add_parser('totals')
    t.add_argument('snapshot')
    a = p.parse_args()
    {'dump': dump, 'restore': restore, 'totals': totals}[a.cmd](a)


if __name__ == '__main__':
    main()
