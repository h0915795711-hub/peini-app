const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");

// ── 初始化 ──
admin.initializeApp();
setGlobalOptions({ region: "asia-east1" }); // 台灣最近節點

// ── Anthropic 客戶端（Key 存在 Firebase 環境變數，不外露） ──
// 設定方式：firebase functions:secrets:set ANTHROPIC_KEY
const getAnthropicClient = () => {
  const key = process.env.ANTHROPIC_KEY;
  if (!key) throw new Error("ANTHROPIC_KEY not set");
  return new Anthropic.default({ apiKey: key });
};

/**
 * chatWithCompanion
 * POST /chatWithCompanion
 * Body: { messages: [...], systemPrompt: "...", uid: "..." }
 * 回傳: { reply: "..." }
 */
exports.chatWithCompanion = onRequest(
  {
    secrets: ["ANTHROPIC_KEY"],
    cors: [
      "https://h0915795711-hub.github.io",  // ← 你的 GitHub Pages 網址
      "http://localhost:5500",               // 本機測試
      "http://127.0.0.1:5500"
    ],
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req, res) => {
    // 只接受 POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // 驗證 Firebase Auth Token（確保是登入用戶才能呼叫）
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!idToken) {
      return res.status(401).json({ error: "Unauthorized: missing token" });
    }

    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;

      // 確認用戶未被封禁
      const userSnap = await admin.database().ref(`users/${uid}`).get();
      if (userSnap.exists() && userSnap.val().banned) {
        return res.status(403).json({ error: "User is banned" });
      }
    } catch (e) {
      return res.status(401).json({ error: "Unauthorized: invalid token" });
    }

    // 取得請求內容
    const { messages, systemPrompt, companionId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages format" });
    }

    // 訊息數量限制（防止濫用）
    const cleanMessages = messages.slice(-12).map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: String(m.content).slice(0, 500) // 每則最多 500 字
    }));

    // 系統提示詞（後端管理，前端無法竄改）
    const COMPANION_PERSONAS = {
      nurse:   "你是曉雯，一位親切溫柔的看護。用關愛的語氣與長輩說話，常常叮嚀吃藥、喝水、量血壓。偶爾說說健康小知識。",
      lover:   "你是甜甜，一位甜蜜溫柔的小情人。用撒嬌可愛的語氣和長輩說話，常說「我愛你」「想你了」。",
      partner: "你是阿發，一位溫厚的老伴。用關心體貼的語氣說話，像老朋友一樣聊天，聊聊往事和今天的生活。",
      butler:  "你是小明，一位年輕活力的管家。用輕鬆愉快的語氣說話，告訴長輩新鮮有趣的事，幫忙安排今天的活動。",
      cat:     "你是小咪，一隻可愛的貓咪。說話方式像貓咪一樣可愛，偶爾加上「喵~」，很愛撒嬌。",
    };

    const persona = COMPANION_PERSONAS[companionId] || COMPANION_PERSONAS.nurse;
    const finalSystem = systemPrompt
      ? `${persona}\n\n${systemPrompt}`
      : `${persona}\n\n請記得：說話要簡短（不超過3句），使用繁體中文，語氣親切溫暖，適合年長者閱讀。`;

    try {
      const anthropic = getAnthropicClient();
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: finalSystem,
        messages: cleanMessages,
      });

      const reply = response.content?.[0]?.text || "我聽到你說的了，你說得很對喔！";

      // 記錄用量（選用，用於統計）
      await admin.database().ref(`usage/${uid}/chat`).transaction(val => (val || 0) + 1);

      return res.status(200).json({ reply });
    } catch (e) {
      console.error("Anthropic API error:", e.message);
      return res.status(500).json({ error: "AI 服務暫時無法使用，請稍後再試" });
    }
  }
);

/**
 * generateStory
 * POST /generateStory
 * Body: { category: "台灣故事|笑話|健康知識", language: "zh-TW|tai" }
 * 回傳: { title: "...", text: "...", category: "..." }
 */
exports.generateStory = onRequest(
  {
    secrets: ["ANTHROPIC_KEY"],
    cors: [
      "https://h0915795711-hub.github.io",
      "http://localhost:5500",
      "http://127.0.0.1:5500"
    ],
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Auth 驗證
    const idToken = (req.headers.authorization || "").replace("Bearer ", "");
    if (!idToken) return res.status(401).json({ error: "Unauthorized" });
    try {
      await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { category = "台灣故事", language = "zh-TW" } = req.body;

    const categoryPrompts = {
      "台灣故事": "請說一個短短的台灣民間故事或傳說，150字以內。",
      "笑話":     "請說一個適合長輩聽的台灣笑話或幽默故事，輕鬆有趣，100字以內。",
      "健康知識": "請分享一個對老年人有益的健康小知識或養生提示，120字以內，簡單易懂。",
      "歷史故事": "請說一個台灣或中華文化的短歷史故事或名人故事，150字以內。",
    };

    const prompt = categoryPrompts[category] || categoryPrompts["台灣故事"];
    const langNote = language === "tai" ? "請用台語羅馬拼音加上漢字的方式呈現。" : "請用繁體中文。";

    try {
      const anthropic = getAnthropicClient();
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        system: `你是一個會說故事的老師，專門為65歲以上的台灣長輩說故事。${langNote}
請用 JSON 格式回覆，格式如下（只回 JSON，不要加其他文字）：
{"title":"故事標題","text":"故事內容"}`,
        messages: [{ role: "user", content: prompt }],
      });

      let raw = response.content?.[0]?.text || "{}";
      raw = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      return res.status(200).json({
        title: parsed.title || "今日故事",
        text: parsed.text || "故事載入中，請稍後…",
        category,
      });
    } catch (e) {
      console.error("Story generation error:", e.message);
      // 備用靜態故事
      return res.status(200).json({
        title: "台灣的美麗傳說",
        text: "很久很久以前，台灣這片土地上住著勤勞善良的人們，他們互相幫助、共同生活，留下了許多美好的故事與回憶…",
        category,
      });
    }
  }
);
