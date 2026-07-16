# 勉強アプリ

**作業を始める前に必ず [HANDOFF.md](HANDOFF.md) を読むこと。**
アプリの仕組み・確定済みの要件(勝手に変えない)・ファイル構成がすべて書いてある。

## 要点
- 静的Webアプリ(HTML/CSS/生JSのみ。ビルドなし・フレームワークなし)
- 公開先: https://miraikuworkskuma.github.io/benkyo-app (GitHub Pages)
- AIは利用者自身のGemini APIキー(gemini-3.5-flash)。運営者の費用ゼロが絶対条件
- `FIREシミュレーター.html` と `家計管理・ライフプラン.html` は別プロジェクトの原本。
  それぞれ fire-simulator / kakei-lifeplan リポジトリに公開されている(編集したら公開側にも反映する)

## 変更したら
1. ローカルで動作確認(`python3 -m http.server 8765` でプレビュー)
2. HANDOFF.md を最新に更新
3. コミットして GitHub にプッシュ(GitHub Pages に自動反映)
