# Changelog

## [Unreleased]

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
