# Changelog

## [Unreleased]

## [1.5.0] - 2026-09-17

- 「期間 7d · 上部の選択に追従」のラベルを削除（追従は動作のまま、表示は不要）
- 開閉ボタンを「内訳」に変更し、**Model Settings カードの Configure と同じデザイン**に
  - SDK の `Button` を `size:"sm"` / `outlined` / `className:"shrink-0 self-start text-xs uppercase sm:self-center"`
    で使う（公式 Configure と同一props）。SDK に Button が無い時はプレーンbuttonにフォールバック

## [1.4.0] - 2026-09-17

- 期間（7d/30d/90d）を上部の期間指定に自動追従（パネル独自のボタンは廃止）
  - ページ自身の `/api/analytics/models?days=N` 呼び出しを `window.fetch` ラップで観測し、
    その N で自分のデータを取り直す（透過的＝ページの通信はそのまま）
  - 観測できなかった場合のみ、上部の期間ボタン（7d/30d/90d）を読んで判定（アクティブは
    クラス列が他2つと異なるもの）
  - ヘッダは「期間 30d · 上部の選択に追従」の表示に変更（操作は上部に一本化）

## [1.3.0] - 2026-09-17

- 配置アンカーを「モデルカード群の直前」に変更（＝MODEL SETTINGS カードの直下）
  - 以前は "Model Settings" の文字列と Card のクラス名（bg-card）に依存していたため、
    見出しが別文言/別構造だと挿入位置がずれる余地があった
  - 現在は `#1` のランク span から cards grid を特定し、その直前に挿入するのを第一手段に
  - カードが無い空状態のみ "Model Settings" カード直後（カードが最下段なら親の末尾へ append）にフォールバック

## [1.2.0] - 2026-09-17

- 表示位置が不安定だった問題を修正（最上部 / "Models per bot" / 目的位置を行き来していた）
  - 原因: 常時 MutationObserver + 何度も再配置していたため、React の再描画と競合していた
    （React は管理下の子リストに挿入する際「次のReact子要素」を目印に使うため、
    割り込んだ外野ノードの前後で位置がずれる）
  - 対策: 常時監視をやめ、マウント直後の数回（0/0.3/0.9/2/3.5秒）＋データ取得ごとに1回だけ整地
  - 配置が決まるまで `visibility:hidden`（最上部に一瞬出るのを防止）、1.5秒でフォールバック表示

## [1.1.0] - 2026-09-17

- パネルの表示位置を「MODEL SETTINGS カードの直下・モデルカード群の直前」に移動
  - Models ページのスロットは `models:top` / `models:bottom` の2つだけなので、
    いったん top にマウントしてから DOM 上で relocation する方式
  - アンカーは "Model Settings" ヘッダ（見つからなければ `#1` のランク span から cards grid を特定）
  - MutationObserver（200ms デバウンス）＋リトライタイマーで再配置。二重マウント時は古いノードを除去
- パネルの profile 指定を公式ページと同じ挙動に（`?profile=` があるときだけ送る）
- wrapper に fold 件数のログを追加（`folded 90 -> 36 rows`）

## [1.0.0] - 2026-09-17

初版。

- Models ページの重複カード（同一 provider×モデルの使用量が分裂）を解消
  - `hermes_cli.web_routers.analytics._get_models_analytics` を in-process で wrap（fail-soft）
  - 合算キーは UI の表示キー `(provider or modelVendor, shortModelName)`
  - トークン/セッション数は合算のみ（保存則をテストで検証）
- aux 使用を task 別の内訳として表示（`session_model_usage` を再読してラベル付けのみ）
- `models:top` に折りたたみ式パネル（既定は1行サマリ、7d/30d/90d 切替）
- 自前エンドポイント `/api/plugins/models-usage-fold/model-usage` と `/status`
- テスト: 実DBでの合算検証（`tests/test_fold.py`）＋ モックSDKでのUI描画検証（`tests/test_slot_panel.mjs`）
