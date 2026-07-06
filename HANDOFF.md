# 引き継ぎメモ(HANDOFF)

このファイルは、別のClaude(や別のアカウント・別のPC)が作業を引き継ぐための情報です。
**新しいClaudeへ:** まずこのファイルとリポジトリ全体を読んでから作業してください。

---

## このアプリは何か

Googleドライブの教材(**Googleドキュメント/スライド**)を読み込み、AIが
**理解度チェック用の4択クイズ**と**暗記用フラッシュカード**を自動生成する学習アプリ。

- **サーバー不要の静的Webアプリ**(HTML/CSS/生JS のみ。ビルド工程なし・フレームワークなし)
- ホスティングは **GitHub Pages** を想定(無料)
- AIは **Gemini API(`gemini-2.5-flash`)**。各利用者が **自分の無料APIキー** を使う
- Google Drive読み込みは **OAuth(Google Identity Services)** を使用
- APIキー・学習履歴・復習ボックスは各利用者の **ブラウザ(localStorage)** にのみ保存

## 決定した要件(ユーザーとの合意事項)

これらは相談の上で確定した方針。勝手に変えないこと。

1. **運営者(ユーザー)の費用はゼロにする** → だからClaude APIではなく各自負担のGeminiを採用
2. **他人のPCでもURLを開くだけで動く** → だから静的Webアプリ + GitHub Pages
3. **問題形式**: 理解を深める内容 = **4択クイズ(解説付き)**、記憶系 = **フラッシュカード**
4. **復習機能あり** → 「復習ボックス」を実装(下記)
5. 想定利用者は **自分+友人数人**。だからGoogle OAuthは「テストユーザー登録」で運用(審査不要)

## なぜGeminiか(Claudeではない理由)

ユーザーの要望は「Claude(このアシスタント)を経由せず、運営者が費用負担せずに」動くこと。
Gemini APIは Google AI Studio で無料・クレカ不要でキー発行でき、各利用者が自分のキーを使えば
運営者に課金されない。2026年時点で無料枠は 2.5 Flash が対象(Pro系は2026年4月から有料専用)。

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 全画面のマークアップ(設定/ホーム/生成/クイズ/結果/カード/カード完了) |
| `style.css`  | デザイン |
| `app.js`     | 中核ロジック(Drive読込・Gemini呼び出し・出題・復習・localStorage) |
| `config.js`  | `window.APP_CONFIG.GOOGLE_CLIENT_ID` を設定する場所(秘密情報ではない) |
| `README.md`  | セットアップ手順(管理者用・利用者用) |
| `HANDOFF.md` | このファイル |
| `.claude/launch.json` | ローカル起動設定(`python3 -m http.server 8765`) |

## 主要な実装ポイント(app.js)

- 画面は `SCREENS` 配列 + `show(id)` で切り替える単純なSPA。
- **Drive**: `google.accounts.oauth2.initTokenClient` でアクセストークン取得 → Drive v3 API。
  Googleドキュメント/スライドを `files/{id}/export?mimeType=text/plain` で本文取得。
  長い教材は `MAX_SOURCE_CHARS`(60000字)で先頭を切り詰め。
- **Gemini**: `generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`。
  `responseSchema` で構造化JSON出力を強制(`QUIZ_SCHEMA` / `CARDS_SCHEMA`)。
  プロンプトは `buildPrompt()`。キーは HTTPヘッダ `x-goog-api-key`。
- **localStorage キー**(`LS` オブジェクト): `benkyo.geminiKey` / `benkyo.clientId` /
  `benkyo.history`(過去の学習セット最大50件)/ `benkyo.review`(復習ボックス)。
- **復習ボックス**(`benkyo.review` = `{quiz:[], cards:[]}`):
  - クイズで **不正解 → 追加**、**正解 → 削除**(`answerQuiz` 内)。重複は質問文で判定。
  - カードで **「まだ」→ 追加**、**「覚えた」→ 削除**(`judgeCard` 内)。重複は front で判定。
  - ホームの「復習ボックス」カードから、苦手なクイズ/カードだけを横断的に復習できる。

## 動作確認の状況

- ローカル(`python3 -m http.server 8765`)で、設定画面表示・4択の正誤判定と解説・
  フラッシュカードの反転と判定・復習ボックスの追加/削除/ホーム表示を確認済み。
- **未確認**: 実際のGemini生成とDrive読み込み(ユーザーのAPIキーとOAuthクライアントIDが必要なため)。

---

## 次にやるべきこと(TODO)

いずれもコードよりユーザー側の設定作業。詳細は `README.md` 参照。

1. **Google Cloud で OAuthクライアントID発行** → `config.js` の `GOOGLE_CLIENT_ID` に記入。
   Drive APIを有効化。OAuth同意画面を「外部」で作り、友人のGmailをテストユーザー登録。
   「承認済みのJavaScript生成元」に `http://localhost:8765` と本番URL(`https://<user>.github.io`)を追加。
2. **GitHub Pages で公開**(コードのバックアップも兼ねる)。
3. 友人に「Google AI Studioで無料APIキーを発行して初回設定画面に貼る」ことを伝える。

## 既知の注意点・改善候補

- Gemini無料枠はレート制限あり(2.5 Flashで約15req/分・1日上限)。429は `callGemini` でハンドリング済み。
- 無料枠は送信データがモデル改善に使われる可能性 → 機密資料は非推奨(READMEに明記済み)。
- スキャンPDF/画像教材は現状 未対応(Googleドキュメント/スライドのみ)。必要なら
  Drive API + Gemini の画像/PDF入力で拡張可能。
- 学習履歴・復習ボックスは端末ローカル。端末間同期はしていない(要望が出たら要設計)。
