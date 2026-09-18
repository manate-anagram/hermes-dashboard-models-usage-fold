# models-usage-fold

Hermes Web Dashboard plugin that **folds the duplicate `provider × model` cards on the
Models page** and shows the per-auxiliary-task breakdown that folding would otherwise
hide.

- 対象: `hermes dashboard` の **Models ページ**
- 実体: `/opt/data/plugins/models-usage-fold`（`$HERMES_HOME/plugins`＝永続ボリューム）
- **`/opt/hermes` を一切書き換えない** → `hermes update` / コンテナ再作成でも消えない（再適用ゼロ）

---

## なぜ必要か（症状と原因）

Models ページは `/api/analytics/models` が返す**行ごとに1枚のカード**を描く。その行は
`sessions` テーブルを **生の `model` 文字列**で `GROUP BY model, billing_provider` したもので、
aux 使用（`session_model_usage`）は #23270 以降 **task 単位の別行**として足される。
一方カードのタイトルは `shortModelName()` でベンダー接頭辞を落とすため、
**「同じ provider×モデルのカードが複数、使用量だけ分かれて並ぶ」** ように見える。

実測（2026-09-17 / 30日窓 / `/opt/data/state.db`）: カード **90枚中 54枚が重複**。

原因は3つ:

1. **model 文字列の表記ゆれ** — `muse-spark-1.2-contributor` と `meta/muse-spark-1.2-contributor` が
   別行（表示は同名になる）
2. **aux 使用が task 単位の別行** — 同じモデルでも `background_review` / `approval` /
   `title_generation` / `compression` / `vision` がそれぞれ別カード
3. **`billing_provider` 空の行** — 本体の fold は「provider 行がちょうど1つ」の時しか畳まないので、
   provider が複数あるモデルでは 0トークンの空行が残る

## 仕組み

```
dashboard/plugin_api.py   … 起動時にコア集計を in-process で wrap（結果だけ後処理）
                             + 自前エンドポイント /api/plugins/models-usage-fold/model-usage
dashboard/dist/index.js   … Models ページの "models:top" に集約ビューを注入
```

- **wrap**: `hermes_cli.web_routers.analytics._get_models_analytics` を結果後処理で包むので、
  **公式 `/api/analytics/models` 自体が畳まれた行を返す**＝公式カードの重複が消える（UI改修ゼロ）。
  fail-soft 設計: 上流が関数名を変えたり削除したら**警告ログを出して素通し**（自前エンドポイントは動き続ける）。
  上流が畳み込みを実装したら自然に no-op になる。
- **合算キー**: `(provider or モデル文字列のvendor接頭辞, 接頭辞を落としたモデル名)`
  = **UIが実際に描いているキー**（`ModelsPage.tsx` の `provider || modelVendor()` + `shortModelName()`）
- **トークンは増減しない**: 合算のみ。`input/output/cache_read/reasoning/sessions` は
  fold 前後で完全一致することをテストで検証している
- **aux 内訳**: コアの返り値は `aux_task` ラベルを落とすため、`session_model_usage` を
  同じ cutoff で読み直して**ラベルとして貼るだけ**（加算しない＝二重計上なし）

## インストール

```bash
# 0) 配置（プラグインディレクトリへ clone。標準パスなら ~/.hermes/plugins/）
git clone git@github.com:manate-anagram/hermes-dashboard-models-usage-fold.git \
  /opt/data/plugins/models-usage-fold

# 1) 有効化（config.yaml の plugins.enabled に載る）
hermes plugins enable models-usage-fold

# 2) ダッシュボードを再起動（プラグイン一覧はプロセス内キャッシュ）
#    s6 サービスは gateway とは別物。gateway 再起動では Web UI は更新されない
/command/s6-svc -r /run/service/dashboard
```

確認:

```bash
curl -s localhost:9119/api/dashboard/plugins | python3 -m json.tool | grep -A4 models-usage-fold
grep "models-usage-fold" /opt/data/logs/agent.log | tail -2      # wrapped ... が出る
```

Models ページ上部に「モデル使用量の集約 v1.0 — 90枚 → 36件（重複 54）」の行が出ればOK。

## 表示

- 既定は**折りたたみ**（1行サマリのみ）。「内訳を見る」で展開
- 展開時: `provider · model · 合計tok · sess`、`aux: <task> <tok>` の内訳、
  `同名で合算: <生のモデルID>`（表記ゆれの相手）
- `7d / 30d / 90d` 切替、取得失敗はパネル内に表示
- `(provider なし)` = そのグループに会計プロバイダが記録されていない行（aux のみ等）
- `(推定)` = バッジがモデル文字列の vendor 接頭辞から作られた（実プロバイダ未記録）

## 既知の制約

- 正規モデルIDは**使用量が最大の variant**を採用する。「Use as」が送るIDを provider が
  受理できる形に保つため（接頭辞あり/なしが DB に混在している）
- provider 未記録のグループ（`(provider なし)` / `(推定)`）は**別カードのまま**残す。
  実在のトークンを推測で他プロバイダに寄せないため（意図的な非合算）
- 公式カードの「main」バッジ判定（`provider` と `model` の完全一致）は、正規IDの選び方に依存する

## テスト

```bash
HERMES_HOME=/opt/data /opt/hermes/.venv/bin/python3 tests/test_fold.py       # 実DBで合算・保存則・aux内訳
node tests/test_slot_panel.mjs dashboard/dist/index.js                       # モックSDKでUI描画・送信URL
```

`test_fold.py` は実 `state.db` を使い、**合算後の重複表示キーがゼロ**・
**トークン総和が fold 前後で一致**・**fold後の合計 = sessions分 + aux分（二重計上なし）**・
**task 別内訳が DB と一致** を検証する。

## ライセンス

MIT
