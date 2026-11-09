# Changeover statistics: snapshots and the real-visitor check

The stats Worker (`services/stats`) counts anonymous product events from the candidate (`app="candidate"`) and the
monorepo build (`app="monorepo"`). Prometheus on triton scrapes it (`ops/grafana/prometheus-job.yml`). The labels are
a closed vocabulary (app, host, platform, route, action, outcome, cache, visit, kind, method, phase, le). They carry
no identifier, address or free text, so the snapshots are kept in Git.

## Snapshots

`snapshots/fm-web-<date>.jsonl.gz` holds every `fm_web_*` series as change points: each series' first sample,
every sample whose value changed, and its last sample. Counters hold their value between changes, so nothing is lost.
The 9 November 2026 snapshot covers 24 Oct to 9 Nov: 649 series, 8.4 M raw samples kept as 15,338 points (38 KB).
It is the only copy of the candidate's real-visitor baseline (about six days: 132 jobs, 61 visits) outside the Worker
and triton.

```sh
# take one (on triton, beside Prometheus; stdlib Python)
scp ops/stats/snapshot.py triton:/tmp/ && ssh triton 'python3 /tmp/snapshot.py dump --out /tmp/fm-web-$(date +%F).jsonl.gz'
scp triton:/tmp/fm-web-$(date +%F).jsonl.gz ops/stats/snapshots/
# sanity totals, or rebuild a Prometheus TSDB from it
python3 ops/stats/snapshot.py totals ops/stats/snapshots/fm-web-2026-11-09.jsonl.gz
python3 ops/stats/snapshot.py restore ops/stats/snapshots/fm-web-2026-11-09.jsonl.gz --step 300 > fm-web.om
promtool tsdb create-blocks-from openmetrics fm-web.om ./data   # proven 9 Nov: 649 series back
```

## Real-visitor not-worse check (fm-js8i)

`field-not-worse.mjs` compares two windows per platform class, action and route: failure and cancel share, and median
and p90 job duration, plus time to first result. It uses count tests (Wilson intervals), and a row with fewer than
`--min` jobs on either side is `untested`. It reads a live Prometheus or a snapshot, with identical results.

```sh
ssh -f -N -L 19090:localhost:9090 triton
npm run stats:field -- --prom http://localhost:19090 --after-start 2026-10-28T00:00:00Z          # candidate vs monorepo
npm run stats:field -- --snapshot ops/stats/snapshots/fm-web-2026-11-09.jsonl.gz \
  --before-app monorepo --before-start 2026-10-28T00:00:00Z --before-end 2026-11-02T00:00:00Z \
  --after-start 2026-11-02T00:00:00Z --after-end 2026-11-09T00:00:00Z                             # week over week
```

Exit status 1 means at least one row is `worse`. The data is aggregate, so a flag is a reason to reproduce on the
device lab, not proof: a change in which devices visit moves the numbers as much as a code change.
