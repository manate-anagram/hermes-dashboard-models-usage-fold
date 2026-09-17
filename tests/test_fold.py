"""Unit tests for models-usage-fold's fold logic against the real session DB.

Run:  HERMES_HOME=/opt/data /opt/hermes/.venv/bin/python3 tests/test_fold.py
"""
from __future__ import annotations

import importlib.util
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

PLUGIN_API = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"
DB_PATH = Path("/opt/data/state.db")

spec = importlib.util.spec_from_file_location("muf_plugin_api", PLUGIN_API)
assert spec and spec.loader
muf = importlib.util.module_from_spec(spec)
sys.modules["muf_plugin_api"] = muf
spec.loader.exec_module(muf)

DAYS = 30
failures = []


def check(label: str, cond: bool, detail: str = "") -> None:
    print(("PASS  " if cond else "FAIL  ") + label + (("  — " + detail) if detail else ""))
    if not cond:
        failures.append(label)


def tok(row) -> float:
    return float(row.get("input_tokens") or 0) + float(row.get("output_tokens") or 0)


# ── real payload from the core endpoint (unwrapped) + aux breakdown ──────────
aux_rows = muf.load_aux_rows(DAYS, None)
raw = muf._core_call(DAYS, None)
raw_models = raw["models"]
folded = muf.fold_response(raw, aux_rows)
folded_models = folded["models"]
info = folded["fold_info"]

print(f"raw rows={info['raw_rows']}  folded rows={info['folded_rows']}  merged={info['merged_rows']} "
      f"absorbed={info['absorbed_providerless_rows']}  aux rows={info['aux_rows']}  wrap={muf._state['status']}")
print("       top rows:", [(r["provider"], r["model"]) for r in folded_models[:5]])

check("fold actually merged rows (raw > folded)", len(raw_models) > len(folded_models),
      f"{len(raw_models)} -> {len(folded_models)}")

# 1) display-key uniqueness == exactly what the user complained about
keys = [muf.display_key(row) for row in folded_models]
dupes = {k: c for k, c in Counter(keys).items() if c > 1}
check("no duplicate (provider, short model) display key after fold", not dupes, str(list(dupes)[:3]))

# 2) usage conservation — nothing lost, nothing double counted
for field in ("input_tokens", "output_tokens", "cache_read_tokens", "reasoning_tokens", "sessions"):
    a = sum(int(r.get(field) or 0) for r in raw_models)
    b = sum(int(r.get(field) or 0) for r in folded_models)
    check(f"{field} conserved", a == b, f"raw={a} folded={b}")

# 3) the folded total must equal sessions-table usage + aux usage (no double count)
con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
cutoff = time.time() - DAYS * 86400
sess_tokens = con.execute(
    "SELECT COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) FROM sessions "
    "WHERE started_at > ? AND model IS NOT NULL AND model != ''", (cutoff,)).fetchone()[0]
fold_tokens = sum(tok(r) for r in folded_models)
aux_tokens = sum(tok(r) for r in aux_rows)
check("folded total == sessions usage + aux usage", abs(fold_tokens - (sess_tokens + aux_tokens)) < 1,
      f"folded={fold_tokens:.0f} sessions={sess_tokens} aux={aux_tokens:.0f}")

# 4) the per-task breakdown survives and stays inside a group of the same key
groups_with_aux = [r for r in folded_models if r.get("aux_tasks")]
check("aux task breakdown attached to folded groups", bool(groups_with_aux),
      f"{len(groups_with_aux)} groups; tasks={sorted(groups_with_aux[0]['aux_tasks'])[:5] if groups_with_aux else []}")
over = [r["model"] for r in folded_models if r.get("aux_tokens", 0) > tok(r) + 1]
check("attached aux tokens never exceed their group (labels only)", not over, str(over[:3]))
by_task_raw = {}
for r in aux_rows:
    by_task_raw[r.get("task")] = by_task_raw.get(r.get("task"), 0) + tok(r)
by_task_fold = {}
for r in folded_models:
    for task, bucket in (r.get("aux_tasks") or {}).items():
        by_task_fold[task] = by_task_fold.get(task, 0) + tok(bucket)
check("per-task totals match the DB breakdown",
      all(abs(by_task_raw.get(t, 0) - v) < 1 for t, v in by_task_fold.items()),
      f"raw={ {k: int(v) for k, v in sorted(by_task_raw.items())} }")
check("every aux task of the window is represented", set(by_task_fold) == set(by_task_raw),
      f"missing={sorted(set(by_task_raw) - set(by_task_fold))}")

# 5) ordering / averages / totals
check("folded rows sorted by tokens desc",
      all(tok(folded_models[i]) >= tok(folded_models[i + 1]) for i in range(len(folded_models) - 1)))
bad_avg = [r["model"] for r in folded_models
           if r.get("sessions") and abs(r["avg_tokens_per_session"] - tok(r) / r["sessions"]) > 1]
check("avg_tokens_per_session recomputed", not bad_avg, str(bad_avg[:3]))
check("totals.distinct_models == folded rows", folded["totals"]["distinct_models"] == len(folded_models),
      f"{folded['totals']['distinct_models']} vs {len(folded_models)}")

# 6) pass-through for unexpected payloads
check("non-dict payload passes through", muf.fold_response("nope") == "nope")
check("payload without models list passes through", muf.fold_response({"models": None}) == {"models": None})

# 7) the wrap is installed on the core module and is idempotent (no double fold)
import hermes_cli.web_routers.analytics as core  # noqa: E402

check("wrap installed on core module", getattr(core._get_models_analytics, "_models_usage_fold_wrapped", False))
wrapped_first = core._get_models_analytics(DAYS, None)
check("wrapped core call returns folded payload", len(wrapped_first["models"]) == len(folded_models),
      f"{len(wrapped_first['models'])} vs {len(folded_models)}")
muf.install_wrap()
muf.install_wrap()
wrapped_again = core._get_models_analytics(DAYS, None)
check("repeated install does not stack wrappers", len(wrapped_again["models"]) == len(folded_models),
      f"{len(wrapped_again['models'])} vs {len(folded_models)}")
check("wrapped payload carries the aux breakdown",
      any(r.get("aux_tasks") for r in wrapped_again["models"]))

# 8) our own endpoint payload (as the slot panel consumes it)
payload = muf._build(DAYS, None)
check("endpoint payload shape", set(["models", "totals", "fold_info", "wrap_status"]).issubset(payload.keys()))
check("endpoint payload carries aux_tasks", any(r.get("aux_tasks") for r in payload["models"]))
check("endpoint wrap_status is wrapped", payload["wrap_status"] == "wrapped", str(payload["wrap_status"]))

print()
if failures:
    print(f"FAILED ({len(failures)}): " + ", ".join(failures))
    sys.exit(1)
print("ALL PASS")
