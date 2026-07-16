# 引き継ぎメモ(HANDOFF)

このファイルは、別のClaude(や別のアカウント・別のPC)が作業を引き継ぐための情報です。
**新しいClaudeへ:** まずこのファイルとリポジトリ全体を読んでから作業してください。

---

## このアプリは何か

Googleドライブの教材(**Googleドキュメント/スライド/PDF/画像**)を読み込み、AIが
**理解度チェック用の4択クイズ**・**暗記用フラッシュカード**・**記述式問題**を自動生成する学習アプリ。

- **サーバー不要の静的Webアプリ**(HTML/CSS/生JS のみ。ビルド工程なし・フレームワークなし)
- ホスティングは **GitHub Pages** を想定(無料)
- AIは **Gemini API(`gemini-2.5-flash`)**。各利用者が **自分の無料APIキー** を使う
- Google Drive読み込みは **OAuth(Google Identity Services)** を使用
- APIキー・学習履歴・復習ボックスは各利用者の **ブラウザ(localStorage)** にのみ保存

## 決定した要件(ユーザーとの合意事項)

これらは相談の上で確定した方針。勝手に変えないこと。

1. **運営者(ユーザー)の費用はゼロにする** → だからClaude APIではなく各自負担のGeminiを採用
2. **他人のPCでもURLを開くだけで動く** → だから静的Webアプリ + GitHub Pages
3. **問題形式**: 理解を深める内容 = **4択クイズ(解説付き)**、記憶系 = **フラッシュカード**、
   説明する練習 = **記述式(模範解答+採点ポイントで自己採点。高3の息子さんの要望で追加)**
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
  `responseSchema` で構造化JSON出力を強制(`QUIZ_SCHEMA` / `CARDS_SCHEMA` / `WRITTEN_SCHEMA`)。
  プロンプトは `buildPrompt()`、リクエストのparts組み立ては `buildParts()`(PDF/画像は `inlineData` 添付)。
  キーは HTTPヘッダ `x-goog-api-key`。
- **学習の目的**(`state.purpose` = `"yoshu"`(予習)/ `"fukushu"`(復習)): 学習モードとは別軸。
  ホーム最上部の入口ボタン(📖予習する/🔁復習する)と生成画面のトグルで選ぶ(`selectPurpose`が
  両画面の `.purpose-btn` の選択を同期。入口ボタンは `choosePurposeFromHome` で教材カードへスクロール)。
  `buildPrompt` に `purpose` を渡し、予習=やさしめ・全体像・基礎、復習=やや難しめ・応用・弱点、という
  指示文(`purposeLine`)を全モード(クイズ/カード/記述式)のプロンプトに挿入する。履歴にも purpose を保存し
  バッジ表示(古い履歴は purpose なし=バッジ非表示)。※予習/復習ボタンは `.mode-btn` の見た目を流用するため、
  モード選択の処理は `.mode-btn[data-mode]` で絞って巻き込まないようにしている。
- **記述式モード**(`state.genMode === "written"`): 問題文+textarea → 「模範解答とくらべる」で
  modelAnswer と keyPoints(採点基準)を表示 → 「書けた/書けなかった」で自己採点。
  結果画面はクイズと共用(`finishWritten`)。再挑戦ボタンは `state.session.kind` で分岐。
- **localStorage キー**(`LS` オブジェクト): `benkyo.geminiKey` / `benkyo.clientId` /
  `benkyo.history`(過去の学習セット最大50件)/ `benkyo.review`(復習ボックス)。
- **復習ボックス**(`benkyo.review` = `{quiz:[], cards:[], written:[]}`):
  - クイズで **不正解 → 追加**、**正解 → 削除**(`answerQuiz` 内)。重複は質問文で判定。
  - カードで **「まだ」→ 追加**、**「覚えた」→ 削除**(`judgeCard` 内)。重複は front で判定。
  - 記述式で **「書けなかった」→ 追加**、**「書けた」→ 削除**(`judgeWritten` 内)。重複は質問文で判定。
  - ホームの「復習ボックス」カードから、苦手な問題だけを横断的に復習できる。

## 動作確認の状況

- ローカル(`python3 -m http.server 8765`)で、設定画面表示・4択の正誤判定と解説・
  フラッシュカードの反転と判定・記述式の出題〜自己採点〜結果表示・
  復習ボックスの追加/削除/ホーム表示を確認済み。
- **予習/復習(学習の目的)**: ホーム入口ボタン⇔生成画面トグルの選択同期、モード変更で目的が消えないこと、
  `buildPrompt` が目的ごとに指示文を切り替えることをブラウザで確認済み(2026-07-16)。
- **実機確認済み**: OAuthログイン・Drive読み込み(スキャンPDF含む)・Gemini生成は
  ユーザーの実アカウントで動作確認済み(2026-07-08)。
- OAuthクライアントIDは発行済みで `config.js` に記入済み。テストユーザー登録も運用中。

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
- スキャンPDF/画像教材は対応済み(`BINARY_MIME_TYPES` 参照)。Driveから `alt=media` で取得し、
  base64化して Gemini に `inlineData` で添付する。上限は `MAX_BINARY_BYTES`(15MB)。
- 学習履歴・復習ボックスは端末ローカル。端末間同期はしていない(要望が出たら要設計)。
