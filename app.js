/* 勉強アプリ — Google Driveの資料からクイズ&フラッシュカードを生成
 * すべてブラウザ内で完結する(サーバーなし)。
 * - Google Identity Services で Drive の読み取りトークンを取得
 * - Gemini API (gemini-2.5-flash) で問題を生成
 * - キー・学習履歴は localStorage に保存
 */

"use strict";

const LS = {
  geminiKey: "benkyo.geminiKey",
  clientId: "benkyo.clientId",
  history: "benkyo.history",
  review: "benkyo.review",
};

const GEMINI_MODEL = "gemini-2.5-flash";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const MAX_SOURCE_CHARS = 60000; // 長すぎる教材は先頭から切り詰める
const MAX_BINARY_BYTES = 15 * 1024 * 1024; // Gemini inlineData の実用上限(base64化で約20MB以内に収める)
const BINARY_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"];

const state = {
  accessToken: null,
  tokenClient: null,
  source: null, // { id, name, text } または { id, name, mimeType, base64 }(スキャンPDF/画像)
  genMode: "quiz",
  genCount: 10,
  session: null, // 進行中のクイズ/カード
};

const $ = (id) => document.getElementById(id);

/* ---------- 画面遷移 ---------- */

const SCREENS = [
  "screen-setup", "screen-home", "screen-generate",
  "screen-quiz", "screen-written", "screen-result", "screen-cards", "screen-cards-done",
];

function show(screenId) {
  for (const id of SCREENS) $(id).hidden = id !== screenId;
  window.scrollTo(0, 0);
}

/* ---------- 設定 ---------- */

function getGeminiKey() { return localStorage.getItem(LS.geminiKey) || ""; }
function getClientId() {
  return localStorage.getItem(LS.clientId) || (window.APP_CONFIG && window.APP_CONFIG.GOOGLE_CLIENT_ID) || "";
}

function openSetup() {
  $("input-gemini-key").value = getGeminiKey();
  $("input-client-id").value = getClientId();
  show("screen-setup");
}

function saveSetup() {
  const key = $("input-gemini-key").value.trim();
  const cid = $("input-client-id").value.trim();
  if (!key) { alert("Gemini APIキーを入力してください"); return; }
  if (!cid) { alert("Google OAuth クライアントIDを入力してください"); return; }
  localStorage.setItem(LS.geminiKey, key);
  localStorage.setItem(LS.clientId, cid);
  state.tokenClient = null; // クライアントID変更に備えて作り直す
  goHome();
}

/* ---------- ホーム / Drive ---------- */

function goHome() {
  renderReview();
  renderHistory();
  $("drive-disconnected").hidden = !!state.accessToken;
  $("drive-connected").hidden = !state.accessToken;
  show("screen-home");
}

function ensureToken() {
  return new Promise((resolve, reject) => {
    if (state.accessToken) { resolve(state.accessToken); return; }
    if (!window.google || !google.accounts) {
      reject(new Error("Googleログイン部品の読み込みに失敗しました。ページを再読み込みしてください。"));
      return;
    }
    if (!state.tokenClient) {
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: getClientId(),
        scope: DRIVE_SCOPE,
        callback: () => {},
      });
    }
    state.tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error("Googleログインがキャンセルされました")); return; }
      state.accessToken = resp.access_token;
      // トークンは約1時間で失効する。少し手前で破棄して再ログインを促す。
      setTimeout(() => { state.accessToken = null; }, (resp.expires_in - 120) * 1000);
      resolve(state.accessToken);
    };
    state.tokenClient.requestAccessToken();
  });
}

async function driveFetch(path, params) {
  const token = await ensureToken();
  const url = new URL("https://www.googleapis.com/drive/v3/" + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (res.status === 401) { state.accessToken = null; throw new Error("Googleへの接続が切れました。もう一度お試しください。"); }
  if (!res.ok) throw new Error("Google Driveへのアクセスに失敗しました (" + res.status + ")");
  return res;
}

async function connectDrive() {
  if (!getClientId()) { alert("先に設定画面でOAuthクライアントIDを入力してください"); openSetup(); return; }
  try {
    await ensureToken();
    $("drive-disconnected").hidden = true;
    $("drive-connected").hidden = false;
    await listFiles("");
  } catch (e) {
    alert(e.message);
  }
}

async function listFiles(keyword) {
  const ul = $("filelist");
  ul.innerHTML = "<li class='empty'>読み込み中…</li>";
  const mimeConds = ["application/vnd.google-apps.document", "application/vnd.google-apps.presentation", ...BINARY_MIME_TYPES]
    .map((m) => `mimeType='${m}'`).join(" or ");
  let q = `(${mimeConds}) and trashed=false`;
  if (keyword) q += ` and name contains '${keyword.replace(/'/g, "\\'")}'`;
  try {
    const res = await driveFetch("files", {
      q,
      orderBy: "modifiedTime desc",
      pageSize: "30",
      fields: "files(id,name,mimeType,modifiedTime)",
    });
    const data = await res.json();
    renderFileList(data.files || []);
  } catch (e) {
    ul.innerHTML = `<li class='empty'>${escapeHtml(e.message)}</li>`;
  }
}

function renderFileList(files) {
  const ul = $("filelist");
  ul.innerHTML = "";
  if (files.length === 0) {
    ul.innerHTML = "<li class='empty'>ファイルが見つかりませんでした</li>";
    return;
  }
  for (const f of files) {
    const li = document.createElement("li");
    let icon = "📄";
    if (f.mimeType.includes("presentation")) icon = "📊";
    else if (f.mimeType === "application/pdf") icon = "📑";
    else if (f.mimeType.startsWith("image/")) icon = "🖼️";
    const date = new Date(f.modifiedTime).toLocaleDateString("ja-JP");
    li.innerHTML = `<span>${icon}</span><span class="fname"></span><span class="fdate">${date}</span>`;
    li.querySelector(".fname").textContent = f.name;
    li.addEventListener("click", () => pickFile(f));
    ul.appendChild(li);
  }
}

async function pickFile(file) {
  const ul = $("filelist");
  ul.innerHTML = "<li class='empty'>本文を読み込み中…</li>";
  try {
    if (BINARY_MIME_TYPES.includes(file.mimeType)) {
      const res = await driveFetch(`files/${file.id}`, { alt: "media" });
      const blob = await res.blob();
      if (blob.size > MAX_BINARY_BYTES) throw new Error("ファイルサイズが大きすぎます(15MBまで)。");
      const base64 = await blobToBase64(blob);
      state.source = { id: file.id, name: file.name, mimeType: file.mimeType, base64 };
    } else {
      const res = await driveFetch(`files/${file.id}/export`, { mimeType: "text/plain" });
      let text = await res.text();
      if (!text.trim()) throw new Error("このファイルからテキストを取り出せませんでした");
      if (text.length > MAX_SOURCE_CHARS) text = text.slice(0, MAX_SOURCE_CHARS);
      state.source = { id: file.id, name: file.name, text };
    }
    openGenerate();
  } catch (e) {
    alert(e.message);
    listFiles($("input-search").value.trim());
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
    reader.readAsDataURL(blob);
  });
}

/* ---------- 生成オプション ---------- */

function openGenerate() {
  $("gen-source").textContent = "教材: " + state.source.name;
  $("gen-error").hidden = true;
  $("gen-loading").hidden = true;
  $("btn-generate").disabled = false;
  show("screen-generate");
}

function selectMode(mode) {
  state.genMode = mode;
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("selected", b.dataset.mode === mode));
}

function selectCount(count) {
  state.genCount = count;
  document.querySelectorAll(".count-btn").forEach((b) => b.classList.toggle("selected", Number(b.dataset.count) === count));
}

/* ---------- Gemini 呼び出し ---------- */

const QUIZ_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      question: { type: "STRING" },
      choices: { type: "ARRAY", items: { type: "STRING" } },
      answerIndex: { type: "INTEGER" },
      explanation: { type: "STRING" },
    },
    required: ["question", "choices", "answerIndex", "explanation"],
  },
};

const CARDS_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      front: { type: "STRING" },
      back: { type: "STRING" },
    },
    required: ["front", "back"],
  },
};

const WRITTEN_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      question: { type: "STRING" },
      modelAnswer: { type: "STRING" },
      keyPoints: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["question", "modelAnswer", "keyPoints"],
  },
};

function buildPrompt(mode, count, focus, source) {
  const focusLine = focus ? `特に「${focus}」に重点を置いてください。\n` : "";
  const sourceBlock = source.base64
    ? `教材「${source.name}」は添付したファイル(スキャン画像/PDF)を参照してください。`
    : `=== 教材「${source.name}」ここから ===\n${source.text}\n=== 教材ここまで ===`;
  if (mode === "quiz") {
    return `あなたは優秀な教師です。以下の教材にもとづいて、内容の理解を深めるための4択問題を${count}問、日本語で作成してください。
${focusLine}条件:
- 単純な用語の暗記ではなく、概念の理解・因果関係・比較・応用を問う問題を中心にすること
- 選択肢は必ず4つで、まぎらわしいが明確に誤りとわかる選択肢を混ぜること
- answerIndex は正解の選択肢の番号(0〜3)
- explanation には「なぜその答えになるのか」と、間違えやすいポイントを2〜3文で書くこと
- 教材に書かれている内容だけを根拠にすること

${sourceBlock}`;
  }
  if (mode === "written") {
    return `あなたは優秀な教師です。以下の教材にもとづいて、記述式問題を${count}問、日本語で作成してください。
${focusLine}条件:
- 「〜を説明せよ」「〜の理由を述べよ」のように、自分の言葉で説明させる問題にすること
- 用語の丸暗記ではなく、因果関係・仕組み・比較など理解の深さを問う問題にすること
- 高校生が2〜4文で答えられる分量にすること
- modelAnswer には模範解答を2〜4文で書くこと
- keyPoints には「答えに必ず入っているべき要点」を2〜4個、採点基準として書くこと
- 教材に書かれている内容だけを根拠にすること

${sourceBlock}`;
  }
  return `あなたは優秀な教師です。以下の教材から、暗記すべき重要事項(用語・定義・人名・年号・公式など)を選び、フラッシュカードを${count}枚、日本語で作成してください。
${focusLine}条件:
- front はシンプルな問いかけまたは用語(例:「〇〇とは?」「△△が起きた年は?」)
- back は答え+一言の補足。長くても3行以内
- 教材の中で特に重要なものから順に選ぶこと
- 教材に書かれている内容だけを根拠にすること

${sourceBlock}`;
}

function buildParts(mode, count, focus, source) {
  const parts = [{ text: buildPrompt(mode, count, focus, source) }];
  if (source.base64) parts.push({ inlineData: { mimeType: source.mimeType, data: source.base64 } });
  return parts;
}

async function callGemini(parts, schema) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getGeminiKey(),
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.7,
        },
      }),
    }
  );
  if (res.status === 429) throw new Error("Gemini無料枠の上限に達しました。1分ほど待つか、明日また試してください。");
  if (res.status === 400 || res.status === 403) throw new Error("Gemini APIキーが正しくない可能性があります。設定画面で確認してください。");
  if (!res.ok) throw new Error("問題の生成に失敗しました (" + res.status + ")");
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("AIから有効な応答が得られませんでした。もう一度お試しください。");
  return JSON.parse(text);
}

async function generate() {
  const focus = $("input-focus").value.trim();
  $("gen-error").hidden = true;
  $("gen-loading").hidden = false;
  $("btn-generate").disabled = true;
  try {
    const parts = buildParts(state.genMode, state.genCount, focus, state.source);
    const schema = state.genMode === "quiz" ? QUIZ_SCHEMA : state.genMode === "written" ? WRITTEN_SCHEMA : CARDS_SCHEMA;
    let items = await callGemini(parts, schema);
    if (!Array.isArray(items) || items.length === 0) throw new Error("問題を生成できませんでした。もう一度お試しください。");
    if (state.genMode === "quiz") {
      items = items.filter((q) => Array.isArray(q.choices) && q.choices.length === 4 && q.answerIndex >= 0 && q.answerIndex <= 3);
      if (items.length === 0) throw new Error("問題の形式が不正でした。もう一度お試しください。");
    }
    if (state.genMode === "written") {
      items = items.filter((q) => q.question && q.modelAnswer && Array.isArray(q.keyPoints));
      if (items.length === 0) throw new Error("問題の形式が不正でした。もう一度お試しください。");
    }
    const entry = saveHistoryEntry({
      type: state.genMode,
      sourceName: state.source.name,
      focus,
      items,
    });
    if (state.genMode === "quiz") startQuiz(entry, entry.items);
    else if (state.genMode === "written") startWritten(entry, entry.items);
    else startCards(entry, entry.items);
  } catch (e) {
    $("gen-error").textContent = e.message;
    $("gen-error").hidden = false;
  } finally {
    $("gen-loading").hidden = true;
    $("btn-generate").disabled = false;
  }
}

/* ---------- 学習履歴 (localStorage) ---------- */

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS.history)) || []; }
  catch { return []; }
}

function saveHistoryEntry(partial) {
  const history = loadHistory();
  const entry = {
    id: "h" + Date.now(),
    createdAt: new Date().toISOString(),
    ...partial,
  };
  history.unshift(entry);
  localStorage.setItem(LS.history, JSON.stringify(history.slice(0, 50)));
  return entry;
}

function updateHistoryEntry(id, patch) {
  const history = loadHistory();
  const i = history.findIndex((h) => h.id === id);
  if (i >= 0) {
    Object.assign(history[i], patch);
    localStorage.setItem(LS.history, JSON.stringify(history));
  }
}

function deleteHistoryEntry(id) {
  localStorage.setItem(LS.history, JSON.stringify(loadHistory().filter((h) => h.id !== id)));
  renderHistory();
}

function renderHistory() {
  const history = loadHistory();
  $("history-card").hidden = history.length === 0;
  const ul = $("historylist");
  ul.innerHTML = "";
  for (const h of history) {
    const li = document.createElement("li");
    const icon = h.type === "quiz" ? "🧠" : h.type === "written" ? "✍️" : "🃏";
    const label = h.type === "quiz" ? "理解度クイズ" : h.type === "written" ? "記述式" : "暗記カード";
    const date = new Date(h.createdAt).toLocaleDateString("ja-JP");
    const scoreText = (h.type === "quiz" || h.type === "written") && h.lastScore != null
      ? ` / 前回 ${h.lastScore}/${h.items.length}問正解` : "";
    li.innerHTML = `<span>${icon}</span>
      <span class="htitle"><span class="ht"></span><small>${label} ${h.items.length}問 · ${date}${scoreText}</small></span>
      <button class="btn hplay">学習する</button>
      <button class="hdelete" title="削除">🗑</button>`;
    li.querySelector(".ht").textContent = h.sourceName + (h.focus ? `(${h.focus})` : "");
    li.querySelector(".hplay").addEventListener("click", () => {
      if (h.type === "quiz") startQuiz(h, h.items);
      else if (h.type === "written") startWritten(h, h.items);
      else startCards(h, h.items);
    });
    li.querySelector(".hdelete").addEventListener("click", () => {
      if (confirm("この学習セットを削除しますか?")) deleteHistoryEntry(h.id);
    });
    ul.appendChild(li);
  }
}

/* ---------- 復習ボックス (localStorage) ----------
 * 間違えた問題・覚えきれなかったカードをセッションをまたいで蓄積する。
 * 正解/暗記できたらボックスから取り除く。
 */

function loadReview() {
  try {
    const r = JSON.parse(localStorage.getItem(LS.review));
    return { quiz: r?.quiz || [], cards: r?.cards || [], written: r?.written || [] };
  } catch { return { quiz: [], cards: [], written: [] }; }
}

function saveReview(r) {
  localStorage.setItem(LS.review, JSON.stringify(r));
}

function addQuizToReview(question, sourceName) {
  const r = loadReview();
  if (!r.quiz.some((q) => q.question === question.question)) {
    r.quiz.push({ ...question, sourceName });
    saveReview(r);
  }
}

function removeQuizFromReview(questionText) {
  const r = loadReview();
  const next = r.quiz.filter((q) => q.question !== questionText);
  if (next.length !== r.quiz.length) { r.quiz = next; saveReview(r); }
}

function addCardToReview(card, sourceName) {
  const r = loadReview();
  if (!r.cards.some((c) => c.front === card.front)) {
    r.cards.push({ front: card.front, back: card.back, sourceName });
    saveReview(r);
  }
}

function removeCardFromReview(front) {
  const r = loadReview();
  const next = r.cards.filter((c) => c.front !== front);
  if (next.length !== r.cards.length) { r.cards = next; saveReview(r); }
}

function addWrittenToReview(question, sourceName) {
  const r = loadReview();
  if (!r.written.some((q) => q.question === question.question)) {
    r.written.push({ ...question, sourceName });
    saveReview(r);
  }
}

function removeWrittenFromReview(questionText) {
  const r = loadReview();
  const next = r.written.filter((q) => q.question !== questionText);
  if (next.length !== r.written.length) { r.written = next; saveReview(r); }
}

function renderReview() {
  const r = loadReview();
  const has = r.quiz.length > 0 || r.cards.length > 0 || r.written.length > 0;
  $("review-card").hidden = !has;
  const qBtn = $("btn-review-quiz");
  const cBtn = $("btn-review-cards");
  const wBtn = $("btn-review-written");
  qBtn.hidden = r.quiz.length === 0;
  cBtn.hidden = r.cards.length === 0;
  wBtn.hidden = r.written.length === 0;
  qBtn.textContent = `🧠 苦手なクイズを復習(${r.quiz.length}問)`;
  cBtn.textContent = `🃏 苦手なカードを復習(${r.cards.length}枚)`;
  wBtn.textContent = `✍️ 苦手な記述式を復習(${r.written.length}問)`;
}

function startReviewQuiz() {
  const items = loadReview().quiz;
  if (items.length === 0) return;
  startQuiz({ id: "review", sourceName: "復習ボックス", items }, items);
}

function startReviewCards() {
  const items = loadReview().cards;
  if (items.length === 0) return;
  startCards({ id: "review", sourceName: "復習ボックス", items }, items);
}

function startReviewWritten() {
  const items = loadReview().written;
  if (items.length === 0) return;
  startWritten({ id: "review", sourceName: "復習ボックス", items }, items);
}

function clearReview() {
  if (!confirm("復習ボックスを空にしますか?")) return;
  saveReview({ quiz: [], cards: [], written: [] });
  renderReview();
}

/* ---------- 4択クイズ ---------- */

function startQuiz(entry, items) {
  state.session = { kind: "quiz", entry, items, index: 0, wrong: [], correct: 0 };
  show("screen-quiz");
  renderQuizQuestion();
}

function renderQuizQuestion() {
  const s = state.session;
  const q = s.items[s.index];
  $("quiz-progress").style.width = (s.index / s.items.length) * 100 + "%";
  $("quiz-counter").textContent = `${s.index + 1} / ${s.items.length} 問`;
  $("quiz-question").textContent = q.question;
  $("quiz-explain").hidden = true;

  const wrap = $("quiz-answers");
  wrap.innerHTML = "";
  const marks = ["A", "B", "C", "D"];
  q.choices.forEach((choice, i) => {
    const btn = document.createElement("button");
    btn.className = "answer-btn";
    btn.innerHTML = `<span class="mark">${marks[i]}</span>`;
    btn.appendChild(document.createTextNode(choice));
    btn.addEventListener("click", () => answerQuiz(i));
    wrap.appendChild(btn);
  });
}

function answerQuiz(picked) {
  const s = state.session;
  const q = s.items[s.index];
  const buttons = $("quiz-answers").querySelectorAll(".answer-btn");
  buttons.forEach((b, i) => {
    b.disabled = true;
    if (i === q.answerIndex) b.classList.add("correct");
    else if (i === picked) b.classList.add("wrong");
  });
  if (picked === q.answerIndex) {
    s.correct++;
    removeQuizFromReview(q.question); // 正解 → 復習ボックスから外す
  } else {
    s.wrong.push(q);
    addQuizToReview(q, s.entry.sourceName); // 不正解 → 復習ボックスに追加
  }
  $("quiz-explain-text").textContent = (picked === q.answerIndex ? "⭕ 正解! " : "❌ 不正解。") + q.explanation;
  $("quiz-explain").hidden = false;
}

function nextQuiz() {
  const s = state.session;
  s.index++;
  if (s.index < s.items.length) renderQuizQuestion();
  else finishQuiz();
}

function finishQuiz() {
  const s = state.session;
  const total = s.items.length;
  // 全問通しのときだけスコアを履歴に記録する(間違いだけ再挑戦は除く)
  if (s.items === s.entry.items) updateHistoryEntry(s.entry.id, { lastScore: s.correct });

  $("result-title").textContent = s.correct === total ? "🎉 全問正解!" : "おつかれさま!";
  $("result-score").textContent = `${s.correct} / ${total}`;
  const rate = s.correct / total;
  $("result-comment").textContent =
    rate === 1 ? "この範囲はバッチリ理解できています。" :
    rate >= 0.7 ? "よく理解できています。間違えた問題を確認して仕上げましょう。" :
    rate >= 0.4 ? "基礎はできています。解説を読んでもう一度挑戦しましょう。" :
    "まずは教材を読み直してから再挑戦するのがおすすめです。";

  const hasWrong = s.wrong.length > 0;
  $("result-wrong-wrap").hidden = !hasWrong;
  $("btn-retry-wrong").hidden = !hasWrong;
  if (hasWrong) {
    const ul = $("result-wronglist");
    ul.innerHTML = "";
    for (const q of s.wrong) {
      const li = document.createElement("li");
      li.innerHTML = `<div class="wq"></div><div class="wa"></div><div class="we"></div>`;
      li.querySelector(".wq").textContent = q.question;
      li.querySelector(".wa").textContent = "答え: " + q.choices[q.answerIndex];
      li.querySelector(".we").textContent = q.explanation;
      ul.appendChild(li);
    }
  }
  show("screen-result");
}

/* ---------- 記述式問題 ---------- */

function startWritten(entry, items) {
  state.session = { kind: "written", entry, items, index: 0, wrong: [], correct: 0 };
  show("screen-written");
  renderWrittenQuestion();
}

function renderWrittenQuestion() {
  const s = state.session;
  const q = s.items[s.index];
  $("written-progress").style.width = (s.index / s.items.length) * 100 + "%";
  $("written-counter").textContent = `${s.index + 1} / ${s.items.length} 問`;
  $("written-question").textContent = q.question;
  $("written-answer").value = "";
  $("written-answer").disabled = false;
  $("written-model").hidden = true;
  $("btn-written-reveal").hidden = false;
}

function revealWritten() {
  const s = state.session;
  const q = s.items[s.index];
  $("written-answer").disabled = true;
  $("written-model-text").textContent = q.modelAnswer;
  const ul = $("written-keypoints");
  ul.innerHTML = "";
  for (const p of q.keyPoints || []) {
    const li = document.createElement("li");
    li.textContent = p;
    ul.appendChild(li);
  }
  $("written-model").hidden = false;
  $("btn-written-reveal").hidden = true;
}

function judgeWritten(ok) {
  const s = state.session;
  const q = s.items[s.index];
  if (ok) {
    s.correct++;
    removeWrittenFromReview(q.question); // 書けた → 復習ボックスから外す
  } else {
    s.wrong.push(q);
    addWrittenToReview(q, s.entry.sourceName); // 書けなかった → 復習ボックスに追加
  }
  s.index++;
  if (s.index < s.items.length) renderWrittenQuestion();
  else finishWritten();
}

function finishWritten() {
  const s = state.session;
  const total = s.items.length;
  if (s.items === s.entry.items) updateHistoryEntry(s.entry.id, { lastScore: s.correct });

  $("result-title").textContent = s.correct === total ? "🎉 全問書けました!" : "おつかれさま!";
  $("result-score").textContent = `${s.correct} / ${total}`;
  const rate = s.correct / total;
  $("result-comment").textContent =
    rate === 1 ? "この範囲は自分の言葉で説明できています。" :
    rate >= 0.7 ? "よく書けています。書けなかった問題の模範解答を音読して仕上げましょう。" :
    rate >= 0.4 ? "基礎はできています。採点ポイントを意識してもう一度書いてみましょう。" :
    "まずは模範解答を読んで、要点を整理してから再挑戦するのがおすすめです。";

  const hasWrong = s.wrong.length > 0;
  $("result-wrong-wrap").hidden = !hasWrong;
  $("btn-retry-wrong").hidden = !hasWrong;
  if (hasWrong) {
    const ul = $("result-wronglist");
    ul.innerHTML = "";
    for (const q of s.wrong) {
      const li = document.createElement("li");
      li.innerHTML = `<div class="wq"></div><div class="wa"></div><div class="we"></div>`;
      li.querySelector(".wq").textContent = q.question;
      li.querySelector(".wa").textContent = "模範解答: " + q.modelAnswer;
      li.querySelector(".we").textContent = "採点ポイント: " + (q.keyPoints || []).join(" / ");
      ul.appendChild(li);
    }
  }
  show("screen-result");
}

/* ---------- フラッシュカード ---------- */

function startCards(entry, items) {
  state.session = {
    entry,
    deck: items.slice(), // このラウンドで出すカード
    index: 0,
    remembered: 0,
    total: items.length,
    rounds: 1,
    flipped: false,
  };
  show("screen-cards");
  renderCard();
}

function renderCard() {
  const s = state.session;
  const card = s.deck[s.index];
  $("cards-counter").textContent = `のこり ${s.deck.length - s.index} 枚(覚えた ${s.remembered} / ${s.total})`;
  $("flashcard").classList.remove("flipped");
  s.flipped = false;
  $("cards-judge").hidden = true;
  $("card-front").textContent = card.front;
  $("card-back").textContent = card.back;
}

function flipCard() {
  const s = state.session;
  s.flipped = !s.flipped;
  $("flashcard").classList.toggle("flipped", s.flipped);
  if (s.flipped) $("cards-judge").hidden = false;
}

function judgeCard(remembered) {
  const s = state.session;
  const card = s.deck[s.index];
  if (remembered) {
    s.remembered++;
    removeCardFromReview(card.front); // 覚えた → 復習ボックスから外す
  } else {
    s.deck.push(card); // まだ → このラウンドの最後にもう一度出す
    addCardToReview(card, s.entry.sourceName); // 復習ボックスに追加
  }
  s.index++;
  if (s.index < s.deck.length) renderCard();
  else finishCards();
}

function finishCards() {
  const s = state.session;
  $("cards-done-detail").textContent = `${s.total}枚のカードをすべて「覚えた」にしました。時間をおいてもう一周すると記憶が定着します。`;
  show("screen-cards-done");
}

/* ---------- 初期化 ---------- */

function init() {
  $("btn-settings").addEventListener("click", openSetup);
  $("logo").addEventListener("click", () => { if (getGeminiKey()) goHome(); });
  $("btn-save-setup").addEventListener("click", saveSetup);

  $("btn-connect-drive").addEventListener("click", connectDrive);
  $("btn-search").addEventListener("click", () => listFiles($("input-search").value.trim()));
  $("input-search").addEventListener("keydown", (e) => { if (e.key === "Enter") listFiles(e.target.value.trim()); });

  document.querySelectorAll(".mode-btn").forEach((b) => b.addEventListener("click", () => selectMode(b.dataset.mode)));
  document.querySelectorAll(".count-btn").forEach((b) => b.addEventListener("click", () => selectCount(Number(b.dataset.count))));
  $("btn-generate").addEventListener("click", generate);
  $("btn-gen-back").addEventListener("click", goHome);

  $("btn-review-quiz").addEventListener("click", startReviewQuiz);
  $("btn-review-cards").addEventListener("click", startReviewCards);
  $("btn-review-written").addEventListener("click", startReviewWritten);
  $("btn-review-clear").addEventListener("click", clearReview);

  $("btn-quiz-next").addEventListener("click", nextQuiz);
  $("btn-quiz-quit").addEventListener("click", () => { if (confirm("中断してホームに戻りますか?")) goHome(); });
  $("btn-retry-wrong").addEventListener("click", () => {
    const s = state.session;
    (s.kind === "written" ? startWritten : startQuiz)(s.entry, s.wrong);
  });
  $("btn-retry-all").addEventListener("click", () => {
    const s = state.session;
    (s.kind === "written" ? startWritten : startQuiz)(s.entry, s.entry.items);
  });
  $("btn-result-home").addEventListener("click", goHome);

  $("btn-written-reveal").addEventListener("click", revealWritten);
  $("btn-written-yes").addEventListener("click", () => judgeWritten(true));
  $("btn-written-no").addEventListener("click", () => judgeWritten(false));
  $("btn-written-quit").addEventListener("click", () => { if (confirm("中断してホームに戻りますか?")) goHome(); });

  $("flashcard").addEventListener("click", flipCard);
  $("btn-card-yes").addEventListener("click", () => judgeCard(true));
  $("btn-card-no").addEventListener("click", () => judgeCard(false));
  $("btn-cards-quit").addEventListener("click", () => { if (confirm("中断してホームに戻りますか?")) goHome(); });
  $("btn-cards-again").addEventListener("click", () => startCards(state.session.entry, state.session.entry.items));
  $("btn-cards-home").addEventListener("click", goHome);

  if (!getGeminiKey() || !getClientId()) openSetup();
  else goHome();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

init();
