"""models-usage-fold — dashboard plugin backend.

The Models page shows one card per row returned by ``/api/analytics/models``. That
endpoint groups the ``sessions`` table by the *raw* ``model`` string, and #23270
appends auxiliary-usage rows keyed per task, so a single provider+model can come
back as several rows. The page strips the vendor prefix for the card title
(``shortModelName``), which makes those rows render identically — "the same
provider×model appears multiple times with split usage".

This plugin merges the rows the UI would render identically:

* it wraps ``hermes_cli.web_routers.analytics._get_models_analytics`` in-process at
  dashboard startup, so the *official* endpoint returns folded rows (the official
  cards stop duplicating without touching shipped code), and
* it serves ``/api/plugins/models-usage-fold/model-usage`` with the folded view plus
  the per-auxiliary-task breakdown that the fold would otherwise hide.

The core endpoint's projection drops the ``aux_task`` label, so the breakdown is read
straight from ``session_model_usage`` (same source, same cutoff) and attached to the
folded groups as labels only — token sums stay exactly as the core computed them.

Nothing under /opt/hermes is written to: the wrap lives in memory and is re-applied on
every dashboard start. The plugin itself lives in $HERMES_HOME/plugins, a persistent
volume, so it survives container recreate / ``hermes update``.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Query

router = APIRouter()
_log = logging.getLogger(__name__)

CORE_MODULE = "hermes_cli.web_routers.analytics"
CORE_FUNC = "_get_models_analytics"

# Counter keys summed across folded rows. Mirrors the core endpoint's row shape.
_SUM_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "reasoning_tokens",
    "estimated_cost",
    "actual_cost",
    "sessions",
    "api_calls",
    "tool_calls",
)
_AUX_SUM_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "reasoning_tokens", "api_calls", "sessions")

_state: Dict[str, Any] = {"status": "not-attempted", "detail": "", "original": None}


# ── fold helpers ─────────────────────────────────────────────────────────────


def _vendor_of(model: str) -> str:
    idx = model.find("/")
    return model[:idx] if idx > 0 else ""


def _short_name(model: str) -> str:
    idx = model.find("/")
    return model[idx + 1:] if idx > 0 else model


def display_key(row: Dict[str, Any]) -> Tuple[str, str]:
    """The key the Models page renders: (provider badge, card title).

    Mirrors ``ModelsPage.tsx``: ``provider = entry.provider || modelVendor(model)``
    and ``title = shortModelName(model)``.
    """
    model = str(row.get("model") or "")
    provider = str(row.get("provider") or row.get("billing_provider") or "") or _vendor_of(model)
    return provider, _short_name(model)


def _has_usage(row: Dict[str, Any]) -> bool:
    return any(
        (row.get(key) or 0) != 0
        for key in ("input_tokens", "output_tokens", "cache_read_tokens", "reasoning_tokens")
    )


def _row_tokens(row: Dict[str, Any]) -> float:
    return float(row.get("input_tokens") or 0) + float(row.get("output_tokens") or 0)


def _attach_aux(grp: Dict[str, Any], task: str, row: Dict[str, Any]) -> None:
    if not task:
        return
    bucket = grp["aux_tasks"].setdefault(task, {})
    for sum_key in _AUX_SUM_KEYS:
        bucket[sum_key] = (bucket.get(sum_key) or 0) + (row.get(sum_key) or 0)


def fold_models(
    models: List[Dict[str, Any]],
    aux_rows: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Merge rows sharing a display key. Returns (folded rows, fold info).

    ``aux_rows`` come from ``session_model_usage`` (per task). Their tokens are already
    part of the payload, so they are used as **labels only** — never added again.
    """
    groups: Dict[Tuple[str, str], Dict[str, Any]] = {}
    order: List[Tuple[str, str]] = []
    absorbed = 0

    for row in models:
        if not isinstance(row, dict):
            continue
        key = display_key(row)
        model = str(row.get("model") or "")
        grp = groups.get(key)
        if grp is None:
            grp = {
                "model": model,
                "provider": key[0],
                # False when the badge came from the model-string vendor prefix fallback
                # (the payload carried no billing provider for this group).
                "provider_reported": bool(str(row.get("provider") or row.get("billing_provider") or "")),
                "capabilities": dict(row.get("capabilities") or {}),
                "last_used_at": row.get("last_used_at") or 0,
                "avg_tokens_per_session": row.get("avg_tokens_per_session") or 0,
                "variants": [model],
                "aux_tasks": {},
            }
            for sum_key in _SUM_KEYS:
                grp[sum_key] = row.get(sum_key) or 0
            groups[key] = grp
            order.append(key)
        else:
            for sum_key in _SUM_KEYS:
                grp[sum_key] = (grp.get(sum_key) or 0) + (row.get(sum_key) or 0)
            grp["last_used_at"] = max(grp.get("last_used_at") or 0, row.get("last_used_at") or 0)
            if model and model not in grp["variants"]:
                grp["variants"].append(model)
            if not grp.get("capabilities") and row.get("capabilities"):
                grp["capabilities"] = dict(row["capabilities"])
            if str(row.get("provider") or row.get("billing_provider") or ""):
                grp["provider_reported"] = True
        # Future-proof: if the core ever surfaces the task label, use it directly.
        _attach_aux(grp, str(row.get("aux_task") or ""), row)

    # Rows with neither an accounting provider nor any usage are session rows created
    # before the first billable call. The core endpoint folds them only when the model
    # has exactly one provider row; absorb them into the largest group of the same model.
    by_short: Dict[str, List[Tuple[str, str]]] = {}
    for key in order:
        by_short.setdefault(key[1], []).append(key)

    for key in list(order):
        if key[0]:
            continue
        grp = groups[key]
        if _has_usage(grp):
            continue
        siblings = [k for k in by_short.get(key[1], []) if k != key and groups[k].get("variants")]
        if not siblings:
            continue
        target_key = max(siblings, key=lambda k: _row_tokens(groups[k]))
        target = groups[target_key]
        target["sessions"] = (target.get("sessions") or 0) + (grp.get("sessions") or 0)
        target["last_used_at"] = max(target.get("last_used_at") or 0, grp.get("last_used_at") or 0)
        target["variants"] = target["variants"] + [v for v in grp["variants"] if v not in target["variants"]]
        groups.pop(key, None)
        order.remove(key)
        absorbed += 1

    # Per-task breakdown: labels for the folded groups (no token arithmetic).
    for aux in aux_rows or []:
        if not isinstance(aux, dict):
            continue
        key = display_key({
            "model": aux.get("model") or "",
            "provider": aux.get("billing_provider") or "",
        })
        grp = groups.get(key)
        if grp is None:
            continue
        _attach_aux(grp, str(aux.get("task") or ""), aux)

    folded: List[Dict[str, Any]] = []
    for key in order:
        grp = groups[key]
        tokens = _row_tokens(grp)
        sessions = grp.get("sessions") or 0
        grp["avg_tokens_per_session"] = tokens / sessions if sessions else 0
        variants = [v for v in grp.get("variants") or [] if v]
        if variants:
            # Canonical id = most-used variant, so "Use as" keeps sending an id the
            # provider accepts (both prefixed and bare ids occur in the DB).
            grp["model"] = max(variants, key=lambda v: _variant_tokens(models, key, v))
        aux_tokens = sum(_row_tokens(t) for t in grp["aux_tasks"].values())
        grp["aux_tokens"] = aux_tokens
        grp["is_aux_only"] = bool(aux_tokens) and aux_tokens >= tokens - 1
        folded.append(grp)

    folded.sort(key=_row_tokens, reverse=True)

    rows_in = len([r for r in models if isinstance(r, dict)])
    info = {
        "raw_rows": rows_in,
        "folded_rows": len(folded),
        "merged_rows": rows_in - len(folded),
        "absorbed_providerless_rows": absorbed,
        "aux_rows": len([r for r in (aux_rows or []) if isinstance(r, dict)]),
        "wrapped": _state.get("status"),
    }
    return folded, info


def _variant_tokens(models: List[Dict[str, Any]], key: Tuple[str, str], variant: str) -> float:
    """Token total of one raw variant within a display group (canonical-model pick)."""
    return sum(
        _row_tokens(r)
        for r in models
        if isinstance(r, dict) and str(r.get("model") or "") == variant and display_key(r) == key
    )


def fold_response(resp: Any, aux_rows: Optional[List[Dict[str, Any]]] = None) -> Any:
    """Fold a ``/api/analytics/models`` payload. Non-conforming payloads pass through."""
    if not isinstance(resp, dict):
        return resp
    models = resp.get("models")
    if not isinstance(models, list):
        return resp
    folded, info = fold_models(models, aux_rows)
    out = dict(resp)
    out["models"] = folded
    totals = dict(resp.get("totals") or {})
    if "distinct_models" in totals:
        totals["distinct_models"] = len(folded)
    out["totals"] = totals
    out["fold_info"] = info
    return out


def load_aux_rows(days: int, profile: Optional[str]) -> List[Dict[str, Any]]:
    """Per-(task, model, provider) auxiliary usage — the source #23270 appends from."""
    try:
        from hermes_cli.web_server_profiles import _aux_usage_rows
        from hermes_cli.web_server_sessions import _open_session_db_for_profile
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("models-usage-fold: aux helpers unavailable: %s", exc)
        return []
    db = None
    try:
        db = _open_session_db_for_profile(profile, read_only=True)
        return _aux_usage_rows(db, time.time() - (days * 86400))
    except Exception as exc:
        _log.warning("models-usage-fold: aux breakdown unavailable: %s", exc)
        return []
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass


# ── in-process wrap of the core aggregation ──────────────────────────────────


def _load_core() -> Optional[Tuple[Any, Any]]:
    try:
        module = importlib.import_module(CORE_MODULE)
    except Exception as exc:  # pragma: no cover - defensive
        _state.update(status="core-module-import-failed", detail=str(exc))
        _log.warning("models-usage-fold: cannot import %s: %s", CORE_MODULE, exc)
        return None
    func = getattr(module, CORE_FUNC, None)
    if func is None:
        _state.update(status="core-function-missing", detail=f"{CORE_MODULE}.{CORE_FUNC} not found")
        _log.warning("models-usage-fold: %s.%s not found — official cards stay unfolded", CORE_MODULE, CORE_FUNC)
        return None
    return module, func


def install_wrap() -> str:
    """Wrap the core aggregation so the official endpoint returns folded rows.

    Fail-soft by design: if upstream renames or removes the target, the plugin keeps
    its own endpoint working and only the official cards stay unfolded.
    """
    if _state.get("status") == "wrapped":
        return "wrapped"
    loaded = _load_core()
    if loaded is None:
        return str(_state.get("status"))
    module, func = loaded

    if getattr(func, "_models_usage_fold_wrapped", False):
        _state.update(
            status="wrapped",
            detail="wrapper already installed",
            original=getattr(func, "_models_usage_fold_original", func),
        )
        return "wrapped"

    _state["original"] = func

    def _wrapper(days: int = 30, profile: Optional[str] = None, _fn: Any = func) -> Any:
        try:
            aux_rows = load_aux_rows(days, profile)
        except Exception:  # pragma: no cover - defensive
            aux_rows = []
        return fold_response(_fn(days, profile), aux_rows)

    _wrapper._models_usage_fold_wrapped = True  # type: ignore[attr-defined]
    _wrapper._models_usage_fold_original = func  # type: ignore[attr-defined]
    _wrapper.__doc__ = "models-usage-fold wrapper around the core models analytics"
    setattr(module, CORE_FUNC, _wrapper)
    _state.update(status="wrapped", detail=f"wrapped {CORE_MODULE}.{CORE_FUNC}")
    _log.info("models-usage-fold: wrapped %s.%s", CORE_MODULE, CORE_FUNC)
    return "wrapped"


def _core_call(days: int, profile: Optional[str]) -> Any:
    """Call the *unwrapped* core aggregation (each consumer folds exactly once)."""
    install_wrap()
    original = _state.get("original")
    if original is None:
        loaded = _load_core()
        if loaded is None:
            raise RuntimeError(f"core aggregation unavailable: {_state.get('detail')}")
        _state["original"] = loaded[1]
        original = loaded[1]
    return original(days, profile)


def _build(days: int, profile: Optional[str]) -> Dict[str, Any]:
    wrapped = install_wrap()
    try:
        resp = _core_call(days, profile)
    except Exception as exc:
        _log.warning("models-usage-fold: core aggregation failed: %s", exc)
        return {
            "error": str(exc),
            "models": [],
            "totals": {},
            "fold_info": {},
            "period_days": days,
            "wrap_status": wrapped,
            "wrap_detail": _state.get("detail") or "",
        }
    folded = fold_response(resp, load_aux_rows(days, profile))
    return {
        "models": folded.get("models", []),
        "totals": folded.get("totals", {}),
        "fold_info": folded.get("fold_info", {}),
        "period_days": folded.get("period_days", days),
        "wrap_status": wrapped,
        "wrap_detail": _state.get("detail") or "",
    }


# ── routes ───────────────────────────────────────────────────────────────────


@router.get("/model-usage")
async def model_usage(days: int = Query(30, ge=1, le=365), profile: Optional[str] = None):
    """Folded per-model usage + per-auxiliary-task breakdown (off the event loop)."""
    return await asyncio.to_thread(_build, days, profile)


@router.get("/status")
async def status():
    """Wrap state — lets the UI show whether the official cards are folded too."""
    install_wrap()
    return {
        "wrap_status": _state.get("status"),
        "wrap_detail": _state.get("detail") or "",
        "core_module": CORE_MODULE,
        "core_function": CORE_FUNC,
    }


# Install at import time: the dashboard mounts this file at startup, before requests.
install_wrap()
