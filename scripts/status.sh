#!/usr/bin/env bash
# Progress + latest evaluations of a training run.   scripts/status.sh [name]
cd "$(dirname "$0")/.."
NAME="${1:-${NAME:-main}}"
RUN="runs/$NAME"
[[ -d "$RUN" ]] || { echo "no run $RUN"; exit 1; }
PID=$(cat "$RUN/train.pid" 2>/dev/null)
if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then echo "run $NAME: RUNNING (PID $PID)"; else echo "run $NAME: not running"; fi
.venv/bin/python - "$RUN" <<'PY'
import csv, json, os, sys
run = sys.argv[1]
rows = list(csv.DictReader(open(os.path.join(run, "train.csv")))) if os.path.exists(os.path.join(run, "train.csv")) else []
if rows:
    r = rows[-1]
    f = lambda k, d=3: (f"{float(r[k]):.{d}f}" if r.get(k) not in (None, "") else "-")
    recent = rows[-20:]
    sps = sum(float(x["sps"]) for x in recent) / len(recent)
    print(f"iter {r['iter']}  steps {int(r['steps']):,}  games {int(r['games']):,}  hours {f('hours',2)}  sps(avg20) {sps:.0f}")
    print(f"entropy {f('entropy')}  kl {f('kl',4)}  clipfrac {f('clipfrac')}  expl_var {f('explained_var')}  v_loss {f('v_loss')}  lr {f('lr',6)}  stale {f('stale',2)}")
    for opp in ("heuristic", "solver", "snap"):
        vals = []
        for n in range(2, 7):
            xs = [float(x[f"durak_{n}p_vs_{opp}"]) for x in recent if x.get(f"durak_{n}p_vs_{opp}") not in (None, "")]
            vals.append(f"{n}p {sum(xs)/len(xs):.3f}" if xs else f"{n}p -")
        print(f"train-time durak rate vs {opp:<9}: " + "  ".join(vals))
ev = os.path.join(run, "eval.jsonl")
if os.path.exists(ev):
    lines = [json.loads(l) for l in open(ev) if l.strip()]
    print(f"\nevals: {len(lines)}  (durak rate of the checkpoint, greedy policy, 1 seat vs field; baseline 1/N)")
    for e in lines[-6:]:
        def row(o):
            parts = []
            for n in range(2, 7):
                k = f"{o}_{n}p_durak"
                if k in e:
                    parts.append(f"{n}p {e[k]:.3f}")
            return "  ".join(parts)
        z = e.get("vs_champion_z")
        print(f"it {e['iter']:>6} [{e['time']}] vs heur: {row('heuristic')} | vs champ z={z if z is None else round(z,2)} promoted={e['promoted']}")
cj = "checkpoints/champion.json"
if os.path.exists(cj):
    c = json.load(open(cj))
    print(f"\nchampion: {c.get('ckpt')} (iter {c.get('iter')}, {c.get('time')})")
PY
echo; tail -n 3 "$RUN/train.log" 2>/dev/null
