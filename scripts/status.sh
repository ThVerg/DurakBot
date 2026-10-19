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
    if r.get("bel_loss") not in (None, "", "0.0"):
        print(f"belief: CE {f('bel_loss')} nats/card, gain over count prior {f('bel_gain')}, top-1 acc {f('bel_acc')}  solved_frac {f('solved_frac')}  draw_frac {f('draw_frac')}")
    for opp in ("heuristic", "solver", "snap"):
        vals = []
        for n in range(2, 7):
            xs = [float(x[f"durak_{n}p_vs_{opp}"]) for x in recent if x.get(f"durak_{n}p_vs_{opp}") not in (None, "")]
            vals.append(f"{n}p {sum(xs)/len(xs):.3f}" if xs else f"{n}p -")
        print(f"train-time durak rate vs {opp:<9}: " + "  ".join(vals))
ev = os.path.join(run, "eval.jsonl")
if os.path.exists(ev):
    lines = [json.loads(l) for l in open(ev) if l.strip()]
    print(f"\nevals: {len(lines)}. Regression dashboard: durak rate per N of each checkpoint (baseline 1/N:"
          " .500 .333 .250 .200 .167); lower is better")
    v2 = [e for e in lines if (e.get("suite_version") or 0) >= 2]
    old = [e for e in lines if (e.get("suite_version") or 0) < 2]
    for e in old[-3:]:
        z = e.get("vs_champion_z")
        row = "  ".join(f"{n}p {e[f'heuristic_{n}p_durak']:.3f}" for n in range(2, 7) if f"heuristic_{n}p_durak" in e)
        print(f"  [suite v1] it {e['iter']:>5} vs heuristic(policy only): {row} | champ z={z if z is None else round(z,2)} promoted={e['promoted']}")
    if v2:
        names = ["heuristic", "solver"] + sorted({k.rsplit('_', 2)[0] for e in v2 for k in e if k.startswith("anchor:") and k.endswith("p_durak")}) + ["champ"]
        for name in names:
            print(f"  vs {name}:")
            for e in v2[-6:]:
                vals = "  ".join(f"{e[f'{name}_{n}p_durak']:.3f}" if f"{name}_{n}p_durak" in e else "  -  " for n in range(2, 7))
                extra = ""
                if name == "champ":
                    z = e.get("vs_champion_z")
                    extra = f"  h2h z={z if z is None else round(z, 2)}"
                    if "fixed_z1" in e:
                        z2 = e.get("fixed_z2")
                        extra += f" paired fixed_z1={e['fixed_z1']:.2f} z2={'-' if z2 is None else round(z2, 2)}"
                    extra += f" promoted={e.get('promoted')} {e.get('decision', e.get('rejected', ''))}"
                print(f"    it {e['iter']:>5} [{e['time'][5:16]}]  {vals}{extra}")
lg = os.path.join(run, "league.json")
if os.path.exists(lg):
    L = json.load(open(lg)).get("snapshots", {})
    hard = sorted(((e["durak"] + 2) / (e["base"] + 2), k) for k, e in L.items())
    print(f"\nleague: {len(L)} members; hardest (durak/baseline): " + ", ".join(f"{k} {h:.2f}" for h, k in hard[-4:][::-1]))
cs = "checkpoints/champion_stats.json"
if os.path.exists(cs):
    st = json.load(open(cs))
    print(f"\nchampion running estimate (it {st.get('iter')}, {st.get('gates')} gates):")
    for opp in ("heuristic", "solver"):
        per = st.get("results", {}).get(opp, {})
        if per:
            print(f"  vs {opp:<9} " + "  ".join(f"{n}p {d / g:.3f} ({g})" for n, (d, g) in sorted(per.items()) if g))
cj = "checkpoints/champion.json"
if os.path.exists(cj):
    c = json.load(open(cj))
    print(f"\nchampion: {c.get('ckpt')} (iter {c.get('iter')}, {c.get('time')})")
PY
echo; tail -n 3 "$RUN/train.log" 2>/dev/null
