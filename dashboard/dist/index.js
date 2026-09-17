/*
 * models-usage-fold — dashboard slot panel (Models page, "models:top").
 *
 * The backend plugin folds the analytics rows the Models page renders identically
 * (same provider badge + same short model name) and keeps the per-auxiliary-task
 * breakdown. This panel shows that folded view, so duplicates are visible as one
 * row with the main/aux split instead of several identical cards.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !SDK.React || !window.__HERMES_PLUGINS__) return;

  var React = SDK.React;
  var h = React.createElement;
  var C = SDK.components || {};

  var PLUGIN = "models-usage-fold";
  var SLOT = "models:top";
  var VERSION = "v1.1";
  var BASE = "/api/plugins/" + PLUGIN;
  var TOP_N = 15;

  var CSS_ID = "models-usage-fold-css";
  if (!document.getElementById(CSS_ID)) {
    var style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = [
      ".muf-wrap{margin-bottom:12px;border:1px solid var(--border,#2a2a2a);padding:10px 12px}",
      ".muf-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".muf-title{font-size:12px;font-weight:600;letter-spacing:.04em}",
      ".muf-sum{font-size:12px;font-family:ui-monospace,SFMono-Regular,monospace;opacity:.78}",
      ".muf-warn{font-size:11px;color:#f59e0b}",
      ".muf-right{margin-left:auto;display:flex;align-items:center;gap:6px}",
      ".muf-tab{font-size:11px;padding:2px 7px;border:1px solid var(--border,#2a2a2a);background:transparent;color:inherit;cursor:pointer}",
      ".muf-tab.on{border-color:currentColor;font-weight:600}",
      ".muf-rows{margin-top:8px;border-top:1px solid var(--border,#2a2a2a)}",
      ".muf-row{padding:6px 0;border-bottom:1px solid var(--border,#2a2a2a);font-size:12px}",
      ".muf-line{display:flex;align-items:baseline;gap:8px;justify-content:space-between}",
      ".muf-model{font-family:ui-monospace,SFMono-Regular,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".muf-prov{font-size:11px;opacity:.65;white-space:nowrap}",
      ".muf-num{font-family:ui-monospace,SFMono-Regular,monospace;text-align:right;white-space:nowrap}",
      ".muf-sub{font-size:11px;opacity:.6;margin-top:2px;font-family:ui-monospace,SFMono-Regular,monospace}",
      ".muf-note{font-size:11px;opacity:.6;margin-top:6px}",
    ].join("");
    document.head.appendChild(style);
  }

  // ── placement ────────────────────────────────────────────────────────────
  // The Models page only exposes `models:top` / `models:bottom`, so the panel is
  // first mounted at the top of the page and then relocated to sit right under the
  // "Model Settings" card (i.e. directly above the model cards).
  var PANEL_ATTR = "data-muf-panel";
  var panelNode = null;
  var panelHost = null;
  var placeTimer = null;

  function captureNode(el) {
    panelNode = el;
    if (el && !panelHost) panelHost = el.parentElement;
  }

  function rootProps() {
    return { className: "muf-wrap", "data-muf-panel": "1", ref: captureNode };
  }

  function findModelSettingsCard() {
    var nodes = document.querySelectorAll("*");
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (el.childElementCount !== 0) continue;
      var label = (el.textContent || "").trim();
      if (label !== "Model Settings" && label !== "モデル設定") continue;
      var card = el;
      for (var k = 0; k < 8 && card && card.parentElement; k += 1) {
        card = card.parentElement;
        if (/(^|\s)bg-card(\s|$)/.test(card.className || "")) return card;
      }
      return el.parentElement;
    }
    return null;
  }

  function findCardsGrid() {
    var grids = document.querySelectorAll("div");
    for (var i = 0; i < grids.length; i += 1) {
      var grid = grids[i];
      var cls = grid.className || "";
      if (cls.indexOf("grid-cols-2") === -1 && cls.indexOf("grid-cols-3") === -1) continue;
      var spans = grid.querySelectorAll("span");
      for (var j = 0; j < spans.length; j += 1) {
        if (/^#\d+$/.test((spans[j].textContent || "").trim())) return grid;
      }
    }
    return null;
  }

  function placePanel() {
    try {
      var mine = document.querySelectorAll("[" + PANEL_ATTR + "]");
      var node = panelNode;
      if (!node && mine && mine.length) node = mine[mine.length - 1];
      if (!node) return false;

      // React may drop a foreign node; re-attach it to its slot host first.
      if (node.isConnected === false && panelHost && panelHost.isConnected !== false) {
        panelHost.appendChild(node);
      }
      // Drop leftovers from an earlier mount (double panel).
      for (var i = 0; i < (mine ? mine.length : 0); i += 1) {
        if (mine[i] !== node && mine[i].parentElement) mine[i].parentElement.removeChild(mine[i]);
      }

      var before = null;
      var card = findModelSettingsCard();
      if (card && card.parentElement) before = card.nextSibling;
      else {
        var grid = findCardsGrid();
        if (grid && grid.parentElement) before = grid;
      }
      if (!before || !before.parentElement) return false;
      if (before === node || before.previousSibling === node) return true;
      before.parentElement.insertBefore(node, before);
      return true;
    } catch (err) {
      return false;
    }
  }

  function schedulePlacement() {
    if (placeTimer) return;
    placeTimer = setTimeout(function () {
      placeTimer = null;
      placePanel();
    }, 200);
  }

  function useHook(name) {
    if (SDK.hooks && typeof SDK.hooks[name] === "function") return SDK.hooks[name];
    return React[name];
  }
  var useState = useHook("useState");
  var useEffect = useHook("useEffect");

  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }
  function fmtInt(n) {
    return String(Number(n) || 0);
  }
  function total(entry) {
    return (Number(entry.input_tokens) || 0) + (Number(entry.output_tokens) || 0);
  }
  function entryKey(entry, index) {
    return (entry.provider || "") + "::" + (entry.model || "") + "::" + index;
  }
  function auxText(tasks) {
    var keys = Object.keys(tasks || {});
    if (!keys.length) return "";
    return keys
      .sort(function (a, b) { return total(tasks[b]) - total(tasks[a]); })
      .map(function (k) { return k + " " + fmtTokens(total(tasks[k])); })
      .join("  ·  ");
  }

  function getJSON(path) {
    if (typeof SDK.fetchJSON === "function") return SDK.fetchJSON(path);
    return fetch(path, { credentials: "include" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function currentProfile() {
    // Mirror the dashboard's own scoping (ProfileProvider → setManagementProfile →
    // ?profile= on the URL). When the page sends no profile, the backend uses the
    // dashboard process's own profile, so we must not force one either.
    try {
      var q = typeof location !== "undefined" ? location.search || "" : "";
      var urlProfile = new URLSearchParams(q).get("profile");
      if (urlProfile) return Promise.resolve(urlProfile);
    } catch (err) { /* ignore */ }
    if (SDK.api && typeof SDK.api.getActiveProfile === "function") {
      return SDK.api.getActiveProfile()
        .then(function (r) {
          var active = r && r.active;
          var current = r && r.current;
          return active && current && active !== current ? active : null;
        })
        .catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  function Panel() {
    var daysState = useState(30);
    var days = daysState[0];
    var setDays = daysState[1];
    var openState = useState(false);
    var open = openState[0];
    var setOpen = openState[1];
    var dataState = useState({ loading: true, data: null, error: null });
    var view = dataState[0];
    var setView = dataState[1];

    useEffect(function () {
      var cancelled = false;
      setView(function (prev) { return { loading: true, data: prev.data, error: null }; });
      currentProfile()
        .then(function (profile) {
          var url = BASE + "/model-usage?days=" + days + (profile ? "&profile=" + encodeURIComponent(profile) : "");
          return getJSON(url);
        })
        .then(function (payload) {
          if (cancelled) return;
          setView({ loading: false, data: payload, error: payload && payload.error ? payload.error : null });
        })
        .catch(function (err) {
          if (cancelled) return;
          setView({ loading: false, data: null, error: (err && err.message) || String(err) });
        });
      return function () { cancelled = true; };
    }, [days]);

    // Park the panel under the "Model Settings" card (above the model cards) and
    // keep it there while the page re-renders.
    useEffect(function () {
      var alive = true;
      var timers = [0, 300, 900, 2000, 4000].map(function (ms) {
        return setTimeout(function () { if (alive) placePanel(); }, ms);
      });
      var observer = null;
      try {
        if (typeof MutationObserver === "function") {
          observer = new MutationObserver(function () { if (alive) schedulePlacement(); });
          observer.observe(document.body, { childList: true, subtree: true });
        }
      } catch (err) { /* no observer → the timers above still place it */ }
      return function () {
        alive = false;
        timers.forEach(function (t) { clearTimeout(t); });
        if (observer) observer.disconnect();
      };
    }, []);

    var data = view.data;
    var info = (data && data.fold_info) || {};
    var folded = info.folded_rows != null ? info.folded_rows : (data && data.models ? data.models.length : null);
    var raw = info.raw_rows;
    var merged = info.merged_rows;
    var wrapped = data ? data.wrap_status === "wrapped" : null;

    var summary = data && raw != null
      ? raw + "枚 → " + folded + "件" + (merged ? "（重複 " + merged + "）" : "")
      : (view.loading ? "読み込み中…" : "—");

    var head = h("div", { className: "muf-head" },
      h("span", { className: "muf-title" }, "モデル使用量の集約 " + VERSION),
      h("span", { className: "muf-sum" }, summary),
      view.error ? h("span", { className: "muf-warn" }, "取得失敗: " + view.error) : null,
      wrapped === false
        ? h("span", { className: "muf-warn" }, "公式カードの重複解消は無効（" + (data.wrap_detail || data.wrap_status || "unknown") + "）")
        : null,
      h("span", { className: "muf-right" },
        [7, 30, 90].map(function (d) {
          return h("button", {
            key: d,
            type: "button",
            className: "muf-tab" + (d === days ? " on" : ""),
            onClick: function () { setDays(d); },
          }, d + "d");
        }),
        h("button", {
          type: "button",
          className: "muf-tab" + (open ? " on" : ""),
          onClick: function () { setOpen(!open); },
        }, open ? "内訳を隠す" : "内訳を見る")
      )
    );

    if (!open) return h("div", rootProps(), head);

    var models = (data && data.models) || [];
    var rows = models.slice(0, TOP_N).map(function (entry, i) {
      var variants = (entry.variants || []).filter(function (v) { return v !== entry.model; });
      return h("div", { className: "muf-row", key: entryKey(entry, i) },
        h("div", { className: "muf-line" },
          h("span", { className: "muf-prov" },
            (entry.provider || "(provider なし)") + (entry.provider_reported === false && entry.provider ? " (推定)" : "") + " · "),
          h("span", { className: "muf-model" }, entry.model || ""),
          h("span", { className: "muf-num" }, fmtTokens(total(entry)) + " tok · " + fmtInt(entry.sessions) + " sess")
        ),
        auxText(entry.aux_tasks) ? h("div", { className: "muf-sub" }, "aux: " + auxText(entry.aux_tasks)) : null,
        variants.length ? h("div", { className: "muf-sub" }, "同名で合算: " + variants.join(" , ")) : null
      );
    });

    return h("div", rootProps(),
      head,
      h("div", { className: "muf-rows" }, rows),
      h("div", { className: "muf-note" },
        "provider×モデル表示キーで合算。合計 " + fmtTokens((data && data.totals && data.totals.total_input + data.totals.total_output) || 0) + " tok / "
        + models.length + " 件" + (models.length > TOP_N ? "（上位 " + TOP_N + " 件を表示）" : "")
        + (info.absorbed_providerless_rows ? " / 会計情報なし行 " + info.absorbed_providerless_rows + "件を合算" : "")
      )
    );
  }

  // Placement is DOM surgery on the official page, so it gets its own seam and is
  // exercised directly (see tests/test_slot_panel.mjs).
  Panel.__mufPlacePanel = placePanel;
  Panel.__mufFindCard = findModelSettingsCard;
  Panel.__mufFindGrid = findCardsGrid;

  window.__HERMES_PLUGINS__.registerSlot(PLUGIN, SLOT, Panel);
})();
