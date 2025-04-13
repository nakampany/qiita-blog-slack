const SCRIPT_PROPS       = PropertiesService.getScriptProperties();
const QIITA_TOKEN        = SCRIPT_PROPS.getProperty("QIITA_TOKEN");
const OPENAI_API_KEY     = SCRIPT_PROPS.getProperty("OPENAI_API_KEY");
const SLACK_BOT_TOKEN    = SCRIPT_PROPS.getProperty("SLACK_BOT_TOKEN");
const SLACK_SIGNING_SECRET = SCRIPT_PROPS.getProperty("SLACK_SIGNING_SECRET");


function doPost(e) {
  try {
    const timestamp = e.parameter["X-Slack-Request-Timestamp"] || e.postData["X-Slack-Request-Timestamp"];
    const slackSignature = e.parameter["X-Slack-Signature"] || e.postData["X-Slack-Signature"];
    const rawBody = e.postData.getDataAsString();

    if (!verifySlackSignature(timestamp, slackSignature, rawBody)) {
      return ContentService.createTextOutput("Invalid signature").setResponseCode(401);
    }

    const payload = JSON.parse(rawBody);

    // チャレンジ応答
    if (payload.type === "url_verification") {
      return ContentService.createTextOutput(payload.challenge);
    }

    const eventTs = payload.event?.ts;
    const cache = CacheService.getScriptCache();
    const cached = cache.get(eventTs);
    if (cached) {
      Logger.log("Duplicate event: " + eventTs);
      return ContentService.createTextOutput("Duplicate").setResponseCode(200);
    } else {
      cache.put(eventTs, "processed", 300); // 5分間キャッシュ
    }

    const text = payload.event?.text;
    const threadTs = eventTs;
    const channel = payload.event?.channel;

    if (text && /やめる|キャンセル|stop/i.test(text)) {
      postToSlackThread(channel, threadTs, "レビューを中止しました 🛑");
      return ContentService.createTextOutput("Canceled");
    }

    if (!text || !text.includes("https://qiita.com/")) {
      return ContentService.createTextOutput("OK");
    }

    const articleId = extractQiitaId(text);
    if (!articleId) return ContentService.createTextOutput("OK");

    const articleBody = fetchQiitaArticleBody(articleId);
    const review = requestReviewFromGPT(articleBody);
    postToSlackThread(channel, threadTs, review);

    return ContentService.createTextOutput("Review complete");

  } catch (err) {
    Logger.log("doPost error: " + err.toString());
    return ContentService.createTextOutput("Internal Server Error").setResponseCode(500);
  }
}


// Qiita URLから記事IDを抽出
function extractQiitaId(text) {
  const match = text.match(/items\/([a-z0-9]{20})/);
  return match ? match[1] : null;
}

// Qiita記事本文を取得
function fetchQiitaArticleBody(itemId) {
  const response = UrlFetchApp.fetch(`https://qiita.com/api/v2/items/${itemId}`, {
    method: "get",
    headers: { Authorization: `Bearer ${QIITA_TOKEN}` }
  });
  const data = JSON.parse(response.getContentText());
  const rawBody = data.body;

  // Qiita記事リンクを除去（[テキスト](https://qiita.com/xxx/items/xxxxxx)）
  const filteredBody = rawBody.replace(/\[.*?\]\(https:\/\/qiita\.com\/.+?\/items\/[a-z0-9]{20}\)/gi, "");

  return filteredBody;
}

// GPT-4にレビュー依頼
function requestReviewFromGPT(markdownText) {
  const prompt = `
Please proofread the following Japanese text written in Markdown format.
Check carefully for the following issues:

- Typos or misspellings (including incorrect kanji conversions)
- Incorrect or unnatural grammar, especially particles and conjunctions
- Inconsistent sentence endings (e.g., mixing "です・ます" with "だ・である")
- Redundant, unclear, or awkward phrasing
- Any unnatural expressions that hinder readability or clarity
- You can ignore Markdown syntax and hyperlinks (e.g., [text](https://qiita.com/...)).

If any issues are found, list up to 5 corrections in the following format:

【修正前】
【修正後】
【理由】

You can ignore Markdown syntax (such as #, **, etc.) when checking the content.
I want the output to be in Japanese.

---

${markdownText}
  `;

  const payload = {
    model: "gpt-4",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: `${markdownText}` }
    ],
    temperature: 0.2
  };

  const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    payload: JSON.stringify(payload)
  });

  const result = JSON.parse(response.getContentText());
  return result.choices?.[0]?.message?.content || "レビュー結果が取得できませんでした。";
}

// Slackに返信（スレッドで）
function postToSlackThread(channel, threadTs, message) {
  const payload = {
    channel: channel,
    thread_ts: threadTs,
    text: message
  };

  UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
    method: "post",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload)
  });
}
