/**
 * models-usage-fold — slot panel test (mock SDK + mock React, no browser).
 *
 * Run:  node tests/test_slot_panel.mjs dashboard/dist/index.js
 *
 * Verifies: slot registration, collapsed summary line, expand → folded rows with the
 * aux breakdown, day switch refetch, profile scoping, and the wrap warning path.
 */
import fs from "node:fs";

const src = fs.readFileSync(process.argv[2], "utf8");

const mkEl = (type, props, ...children) => ({
  __el: true,
  type,
  props: Object.assign({}, props, { children: children.flat(Infinity) }),
});

let state = [];
let idx = 0;
let dirty = false;
let effectDeps = {};
const depsEqual = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
let effects = [];

const React = {
  createElement: mkEl,
  useState(init) {
    const i = idx++;
    const S = state;
    if (!(i in S)) S[i] = init;
    const set = (v) => {
      const next = typeof v === "function" ? v(S[i]) : v;
      if (JSON.stringify(next) !== JSON.stringify(S[i])) { S[i] = next; dirty = true; }
    };
    return [S[i], set];
  },
  useEffect(fn, deps) {
    const i = idx++;
    const prev = effectDeps[i];
    if (!deps || !depsEqual(prev, deps)) { effectDeps[i] = deps; effects.push(fn); }
  },
  useMemo(fn) { idx++; return fn(); },
  useCallback(fn) { idx++; return fn; },
  useRef(v) { idx++; return { current: v }; },
};

const FIXTURE = {
  wrap_status: "wrapped",
  wrap_detail: "wrapped hermes_cli.web_routers.analytics._get_models_analytics",
  period_days: 30,
  totals: { total_input: 425499531, total_output: 18400327, distinct_models: 2 },
  fold_info: { raw_rows: 90, folded_rows: 2, merged_rows: 88, absorbed_providerless_rows: 0, aux_rows: 61, wrapped: "wrapped" },
  models: [
    {
      model: "muse-spark-1.2-contributor", provider: "opencode-go", provider_reported: true,
      input_tokens: 50000000, output_tokens: 3000000, cache_read_tokens: 0, reasoning_tokens: 0,
      sessions: 110, aux_tokens: 3520000, is_aux_only: false,
      variants: ["muse-spark-1.2-contributor", "meta/muse-spark-1.2-contributor"],
      aux_tasks: {
        background_review: { input_tokens: 3300000, output_tokens: 60000, sessions: 17 },
        title_generation: { input_tokens: 40000, output_tokens: 2000, sessions: 23 },
      },
    },
    {
      model: "glm-5.3-flash", provider: "", provider_reported: false,
      input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, reasoning_tokens: 0,
      sessions: 3, aux_tokens: 0, is_aux_only: false, variants: ["glm-5.3-flash"], aux_tasks: {},
    },
  ],
};

const calls = { fetch: [], slots: [], reload: 0, inserts: [] };
let fetchImpl = async () => JSON.parse(JSON.stringify(FIXTURE));

const SDK = {
  sdkVersion: "1.1.0",
  React,
  hooks: {},
  components: {},
  utils: { cn: (...a) => a.filter(Boolean).join(" ") },
  api: { getActiveProfile: async () => ({ active: "default", current: "default" }) },
  fetchJSON: (url) => { calls.fetch.push(url); return fetchImpl(url); },
};

const listeners = [];
// The page's own (sniffed) fetch: the panel learns the active period from it.
const sniffed = [];
const pageFetch = async (url) => {
  sniffed.push(String(url));
  return { ok: true, json: async () => ({}) };
};
const loc = { reload: () => { calls.reload += 1; }, search: "" };
globalThis.window = {
  __HERMES_PLUGIN_SDK__: SDK,
  __HERMES_PLUGINS__: {
    registerSlot: (plugin, slot, comp) => calls.slots.push({ plugin, slot, comp }),
    register: () => {},
  },
  fetch: pageFetch,
  location: loc,
  addEventListener: (t, fn) => listeners.push([t, fn]),
  removeEventListener: () => {},
};
globalThis.location = loc;
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: "", textContent: "", setAttribute() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
};

// ── run the plugin bundle ────────────────────────────────────────────────────
new Function("window", "document", "fetch", src)(globalThis.window, globalThis.document, async () => { throw new Error("no fetch"); });

const failures = [];
function check(label, cond, detail = "") {
  console.log((cond ? "PASS  " : "FAIL  ") + label + (detail ? "  — " + detail : ""));
  if (!cond) failures.push(label);
}

check("registerSlot called with (plugin, slot, component)",
  calls.slots.length === 1 && calls.slots[0].plugin === "models-usage-fold"
  && calls.slots[0].slot === "models:top" && typeof calls.slots[0].comp === "function",
  JSON.stringify(calls.slots.map((s) => [s.plugin, s.slot, typeof s.comp])));

const Panel = calls.slots[0].comp;

// ── tiny render loop (drains effects until stable) ───────────────────────────
const flush = () => new Promise((r) => setTimeout(r, 0));

async function render() {
  for (let pass = 0; pass < 12; pass += 1) {
    const pending = [];
    idx = 0;
    dirty = false;
    let tree;
    effects = [];
    tree = Panel();
    pending.push(...effects);
    effects = [];
    for (const fn of pending) {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    }
    await flush();
    await flush();
    if (!dirty && effects.length === 0) return tree;
    void tree;
  }
  throw new Error("render loop did not settle");
}
const cleanups = [];

function textOf(node) {
  if (node == null || node === false) return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (node.__el) return textOf(node.props && node.props.children);
  return [];
}
const text = (tree) => textOf(tree).join(" ");

function findByText(node, label) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const c of node) { const hit = findByText(c, label); if (hit) return hit; } return null; }
  if (node.__el) {
    if (node.type === "button" && textOf(node).join(" ").includes(label)) return node;
    return findByText(node.props && node.props.children, label);
  }
  return null;
}

// ── collapsed state ──────────────────────────────────────────────────────────
let tree = await render();
check("collapsed panel shows the version", /モデル使用量の集約 v\d+\.\d+/.test(text(tree)), text(tree).slice(0, 60));
check("collapsed panel shows the fold summary (90枚 → 2件)", text(tree).includes("90枚 → 2件（重複 88）"), text(tree));
check("collapsed panel offers the breakdown toggle", !!findByText(tree, "内訳を見る"));
check("collapsed panel does not render rows", !text(tree).includes("aux:"));
check("collapsed panel hides the wrap warning when wrapped", !text(tree).includes("公式カードの重複解消は無効"));
check("fetch URL mirrors the page scoping (no profile param when the page sends none)",
  calls.fetch[0] === "/api/plugins/models-usage-fold/model-usage?days=30", calls.fetch[0]);

// ── expanded state ───────────────────────────────────────────────────────────
const toggle = findByText(tree, "内訳を見る");
toggle.props.onClick();
tree = await render();
const expanded = text(tree);
check("expanded panel renders the folded rows", expanded.includes("muse-spark-1.2-contributor"));
check("expanded panel shows the aux breakdown", expanded.includes("aux: background_review 3.36M"), expanded.slice(0, 220));
check("expanded panel lists the merged raw variants", expanded.includes("同名で合算: meta/muse-spark-1.2-contributor"));
check("provider-less group is labelled", expanded.includes("(provider なし)"));
check("estimated provider is flagged", expanded.includes("(推定)") === false, "prefix groups only when provider is derived");
check("rows are ordered as delivered (largest first)",
  expanded.indexOf("muse-spark-1.2-contributor") < expanded.indexOf("glm-5.3-flash"));

// ── period follows the page's own selector ──────────────────────────────────
check("panel renders no period buttons of its own", !findByText(tree, "7d") && !findByText(tree, "90d"));
check("window.fetch was wrapped (sniffer installed)", typeof window.fetch === "function" && window.fetch !== pageFetch);
const beforeDays = calls.fetch.length;
await window.fetch("/api/analytics/models?days=7&profile=default"); // the official page's own call
tree = await render();
check("page's 7d request makes the panel refetch with 7d",
  calls.fetch.length > beforeDays && calls.fetch[calls.fetch.length - 1].includes("days=7"),
  calls.fetch[calls.fetch.length - 1]);
check("header shows the synced period", text(tree).includes("期間 7d"), text(tree).slice(0, 140));
check("sniffer is transparent (the page's fetch still ran)", sniffed.includes("/api/analytics/models?days=7&profile=default"));

// ── ?profile= on the URL wins (mirrors ProfileProvider) ─────────────────────
loc.search = "?profile=roleplay";
Panel.__mufNotifyDays(90);
tree = await render();
check("?profile= from the URL is forwarded",
  calls.fetch[calls.fetch.length - 1].includes("days=90") && calls.fetch[calls.fetch.length - 1].includes("profile=roleplay"),
  calls.fetch[calls.fetch.length - 1]);
loc.search = "";

// ── wrap warning path ────────────────────────────────────────────────────────
const broken = JSON.parse(JSON.stringify(FIXTURE));
broken.wrap_status = "core-function-missing";
broken.wrap_detail = "hermes_cli.web_routers.analytics._get_models_analytics not found";
fetchImpl = async () => broken;
Panel.__mufNotifyDays(30);
tree = await render();
check("unwrapped core shows the warning", text(tree).includes("公式カードの重複解消は無効"), text(tree).slice(0, 200));

// ── error path ───────────────────────────────────────────────────────────────
fetchImpl = async () => { throw new Error("HTTP 500"); };
Panel.__mufNotifyDays(90);
tree = await render();
check("fetch failure surfaces in the panel", text(tree).includes("取得失敗: HTTP 500"), text(tree).slice(0, 200));

// ── placement: below "Model Settings", directly above the cards grid ─────────
// The Models page only has models:top / models:bottom, so the panel is mounted at
// the top and then moved. Exercise the mover against a fake copy of the page DOM.
function makeEl(tag, className) {
  const el = {
    tagName: tag,
    className: className || "",
    childNodes: [],
    textContent: "",
    parentElement: null,
    isConnected: true,
    style: {},
    get childElementCount() { return this.childNodes.length; },
    setAttribute() {},
    appendChild(child) {
      if (child.parentElement && child.parentElement !== this) child.parentElement.removeChild(child);
      child.parentElement = this;
      this.childNodes.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentElement && child.parentElement !== this) child.parentElement.removeChild(child);
      child.parentElement = this;
      const i = this.childNodes.indexOf(ref);
      if (i < 0) this.childNodes.push(child); else this.childNodes.splice(i, 0, child);
      calls.inserts.push(child === panelEl ? "panel" : "other");
      return child;
    },
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) this.childNodes.splice(i, 1);
      child.parentElement = null;
      return child;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => n.childNodes.forEach((c) => {
        const hit = sel === "*" || c.tagName === sel;
        if (hit) out.push(c);
        walk(c);
      });
      walk(this);
      return out;
    },
    get nextSibling() {
      if (!this.parentElement) return null;
      const i = this.parentElement.childNodes.indexOf(this);
      return i < 0 ? null : this.parentElement.childNodes[i + 1] || null;
    },
    get lastChild() {
      return this.childNodes[this.childNodes.length - 1] || null;
    },
    get previousSibling() {
      if (!this.parentElement) return null;
      const i = this.parentElement.childNodes.indexOf(this);
      return i <= 0 ? null : this.parentElement.childNodes[i - 1] || null;
    },
  };
  return el;
}

const container = makeEl("div", "space-y-4 max-w-none");
const settingsCard = makeEl("div", "min-w-0 max-w-full overflow-hidden bg-card border border-border");
const settingsHeaderWrap = makeEl("div", "flex items-center gap-2");
const settingsHeader = makeEl("span", "text-display text-xs");
settingsHeader.textContent = "Model Settings";
settingsCard.appendChild(settingsHeaderWrap);
settingsHeaderWrap.appendChild(settingsHeader);
const cardsGrid = makeEl("div", "grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3");
const firstCard = makeEl("div", "bg-card");
const rankSpan = makeEl("span", "text-xs font-mono");
rankSpan.textContent = "#1";
firstCard.appendChild(rankSpan);
cardsGrid.appendChild(firstCard);
container.appendChild(makeEl("div", "flex items-center justify-between"));
container.appendChild(settingsCard);
container.appendChild(cardsGrid);

const slotHost = makeEl("div", "muf-slot-host");
const panelEl = makeEl("div", "muf-wrap");
panelEl.style.visibility = "hidden"; // rootProps hides it until it is placed
slotHost.appendChild(panelEl);

globalThis.document.querySelectorAll = (sel) => (sel === "[data-muf-panel]" ? [panelEl] : container.querySelectorAll(sel));
globalThis.document.body = container;

check("placement anchor resolves to the Model Settings card", Panel.__mufFindCard() === settingsCard,
  String(Panel.__mufFindCard() === settingsCard));
check("cards grid is found via the #1 rank span", Panel.__mufFindGrid() === cardsGrid,
  String(Panel.__mufFindGrid() === cardsGrid));
check("panel is moved out of the slot host", Panel.__mufPlacePanel() === true);
check("panel sits directly under Model Settings / above the cards",
  container.childNodes.indexOf(panelEl) === container.childNodes.indexOf(cardsGrid) - 1,
  "index " + container.childNodes.indexOf(panelEl) + " of cards " + container.childNodes.indexOf(cardsGrid));
check("panel is no longer inside the slot host", slotHost.childNodes.indexOf(panelEl) === -1);
check("panel is revealed once it is placed", panelEl.style.visibility === "visible", panelEl.style.visibility);
check("placing twice is a no-op", Panel.__mufPlacePanel() === true && calls.inserts.length === 1,
  "inserts=" + JSON.stringify(calls.inserts));

// fallback: no "Model Settings" text (localised UI) → still lands above the cards
settingsHeader.textContent = "モデル設定アルファ";
check("falls back to the cards grid when the anchor text is unknown",
  Panel.__mufPlacePanel() === true && container.childNodes.indexOf(panelEl) === container.childNodes.indexOf(cardsGrid) - 1);

// empty state: cards grid gone → right after the Model Settings card
settingsHeader.textContent = "Model Settings";
container.removeChild(cardsGrid);
slotHost.appendChild(panelEl); // send it back to the slot so it has to be re-placed
check("empty state places it right below the Model Settings card",
  Panel.__mufPlacePanel() === true
  && container.childNodes.indexOf(panelEl) === container.childNodes.indexOf(settingsCard) + 1,
  "panel=" + container.childNodes.indexOf(panelEl) + " card=" + container.childNodes.indexOf(settingsCard));
container.appendChild(cardsGrid);
check("cards coming back moves it above the grid again",
  Panel.__mufPlacePanel() === true && container.childNodes.indexOf(panelEl) === container.childNodes.indexOf(cardsGrid) - 1);

// fallback: no sniffed request → read the page's period buttons (active = class odd one out)
const btn7 = makeEl("button", "muf-tab");
btn7.textContent = "7d";
const btn30 = makeEl("button", "muf-tab");
btn30.textContent = "30d";
const btn90 = makeEl("button", "muf-tab on");
btn90.textContent = "90d";
const btnHost = makeEl("div", "flex");
btnHost.appendChild(btn7);
btnHost.appendChild(btn30);
btnHost.appendChild(btn90);
container.appendChild(btnHost);
check("reads the active period from the page's own buttons", Panel.__mufDetectDays() === 90, String(Panel.__mufDetectDays()));

cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

console.log();
if (failures.length) {
  console.log(`FAILED (${failures.length}): ` + failures.join(", "));
  process.exit(1);
}
console.log("ALL PASS");
