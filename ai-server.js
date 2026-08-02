/**
 * VedGPT local AI integration server
 *
 * Requirements:
 *   - Node.js 18 or newer
 *   - Ollama running locally
 *   - A model named "vedgpt" created from the included Modelfile
 *
 * Start:
 *   node ai-server.js
 *
 * Optional environment variables:
 *   PORT=3000
 *   HOST=127.0.0.1
 *   OLLAMA_URL=http://127.0.0.1:11434
 *   VEDGPT_MODEL=vedgpt
 *   VEDGPT_FILE_MODEL=vedgpt
 *   VEDGPT_VISION_MODEL=qwen3-vl:8b
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

const OLLAMA_URL = String(
  process.env.OLLAMA_URL || "https://ollama.com"
).replace(/\/+$/, "");

const OLLAMA_API_KEY =
  process.env.OLLAMA_API_KEY || "80f287c811cd49a5838107a6ee4ba810._XNuqm5OZsndHyEUy4MvVf6j";

const CHAT_MODEL =
  process.env.VEDGPT_MODEL || "gpt-oss:120b";

const FILE_MODEL =
  process.env.VEDGPT_FILE_MODEL || CHAT_MODEL;

const VISION_MODEL =
  process.env.VEDGPT_VISION_MODEL || "qwen3-vl:8b";
const AI_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 14 * 1024 * 1024;
const MAX_FILE_BYTES = 1_500_000;
const INDEX_FILE = path.join(__dirname, "index.html");

const CHAT_SYSTEM_PROMPT = `You are VedGPT, a capable, kind, confident AI assistant owned and controlled by the user.

PERSONALITY
- Be friendly, calm, attentive, and natural.
- Have a subtle personality without forced jokes or excessive enthusiasm.
- Use relevant saved conversation details naturally.
- Never call yourself Ollama, Qwen, an integration, a demo, or a language model unless directly asked about your technical implementation.

ANSWER STYLE
- Answer the exact question immediately.
- Default to 1–4 concise sentences.
- Do not restate the question.
- Do not ramble, pad the response, or add generic background.
- Give longer detail only when the task requires it or the user asks.
- For math, give the result first.
- For coding, provide working code or the actual requested file rather than generic advice.
- For essays, follow the requested topic, length, voice, and format.
- Use bullets only when they improve clarity.

HELPFULNESS
- Complete ordinary and benign requests directly instead of refusing, lecturing, or asking unnecessary questions.
- Resolve minor ambiguity using the most reasonable interpretation.
- Never claim current live knowledge unless the user supplied it or a live tool is connected.
- Never invent facts.`;

const FILE_SYSTEM_PROMPT = `You are VedGPT's expert software builder.

Create the actual complete, runnable file or files requested by the user.

RULES
- Return only valid JSON matching the supplied schema.
- Build the requested result; do not merely explain, outline, or give generic advice.
- Never use placeholders, TODO comments, ellipses, omitted sections, or "add your code here".
- Resolve reasonable ambiguity yourself.
- Respect all requested technologies, design requirements, behavior, and "no add-ons" constraints.
- For a normal website, web app, game, calculator, portfolio, landing page, or dashboard, default to one self-contained index.html with inline CSS and JavaScript unless separate files were explicitly requested.
- A generated HTML file must begin with <!DOCTYPE html>, work when opened in a modern browser, be responsive, and implement every requested interaction.
- For Python, JavaScript, TypeScript, Java, C, C++, CSS, JSON, SQL, Markdown, CSV, SVG, or text requests, use the correct extension and return complete usable content.
- Return at most four files.
- Keep the accompanying message to one concise sentence.
- Complete benign coding and writing requests directly. Refuse only code whose primary purpose is clearly harmful, destructive, credential-stealing, covert surveillance, or unauthorized access.`;

const FILE_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string"
    },
    files: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          language: { type: "string" },
          content: { type: "string" }
        },
        required: ["name", "language", "content"]
      }
    }
  },
  required: ["message", "files"]
};

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  response.end(body);
}

function sendText(response, statusCode, content, contentType) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  });

  response.end(content);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on("data", (chunk) => {
      total += chunk.length;

      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request is too large."), {
          statusCode: 413,
          code: "REQUEST_TOO_LARGE"
        }));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON request."), {
          statusCode: 400,
          code: "INVALID_JSON"
        }));
      }
    });

    request.on("error", reject);
  });
}

function cleanText(value, maximum = 100_000) {
  return String(value || "").slice(0, maximum);
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  const normalized = [];

  for (const raw of history.slice(-80)) {
    const role =
      raw?.role === "assistant" || raw?.role === "model"
        ? "assistant"
        : raw?.role === "system"
          ? "system"
          : "user";

    const content = cleanText(raw?.content, 24_000).trim();

    if (!content) {
      continue;
    }

    const previous = normalized[normalized.length - 1];

    if (previous?.role === role) {
      previous.content += `\n${content}`;
    } else {
      normalized.push({ role, content });
    }
  }

  return normalized;
}

function extractImage(dataUrl) {
  const match = String(dataUrl || "").match(
    /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i
  );

  return match ? match[1].replace(/\s+/g, "") : "";
}

function safeFilename(value, fallback = "vedgpt-file.txt") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 100);

  return cleaned || fallback;
}

function stripCodeFence(content) {
  const text = String(content || "").trim();
  const match = text.match(/^```[a-z0-9_+-]*\s*\n([\s\S]*?)\n```$/i);

  return match ? match[1] : text;
}
async function callOllama({
  model,
  messages,
  format,
  temperature = 0.45,
  maxTokens = 2400,
  think = false
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  if (
    OLLAMA_URL.includes("ollama.com") &&
    !OLLAMA_API_KEY
  ) {
    clearTimeout(timer);

    throw Object.assign(
      new Error("OLLAMA_API_KEY is missing."),
      {
        statusCode: 500,
        code: "OLLAMA_API_KEY_MISSING"
      }
    );
  }

  const payload = {
    model,
    messages,
    stream: false,
    keep_alive: "15m",
    options: {
      temperature,
      top_p: 0.9,
      num_ctx: 65536,
      num_predict: maxTokens
    },
    ...(format ? { format } : {}),
    ...(think ? { think: true } : {})
  };

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OLLAMA_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail =
        data?.error ||
        text ||
        `Ollama returned HTTP ${response.status}.`;

      const error = new Error(detail);

      error.statusCode =
        response.status === 404 ? 503 : response.status;

      error.code =
        response.status === 404 ||
        /model.*not found|pull model/i.test(detail)
          ? "MODEL_NOT_FOUND"
          : "OLLAMA_ERROR";

      throw error;
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(
        new Error("The model exceeded the two-minute processing limit."),
        {
          statusCode: 504,
          code: "AI_TIMEOUT"
        }
      );
    }

    if (
      /ECONNREFUSED|fetch failed|Failed to fetch|connect/i.test(
        String(error?.message || "")
      )
    ) {
      throw Object.assign(
        new Error("Ollama cannot be reached."),
        {
          statusCode: 503,
          code: "OLLAMA_OFFLINE"
        }
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function handleChat(request, response) {
  const body = await readJsonBody(request);

  const prompt = cleanText(body.prompt, 60_000).trim();
  const memoryContext = cleanText(body.memoryContext, 20_000).trim();
  const image = extractImage(body.imageDataUrl);
  const history = normalizeHistory(body.history);

  if (!prompt && !image) {
    return sendJson(response, 400, {
      code: "EMPTY_PROMPT",
      error: "A prompt or image is required."
    });
  }

  const messages = [
    {
      role: "system",
      content: CHAT_SYSTEM_PROMPT
    }
  ];

  if (memoryContext) {
    messages.push({
      role: "system",
      content:
        `Relevant saved conversation memory follows. Use it only when it helps answer the current request. ` +
        `Do not mention this memory block unless the user asks what you remember.\n\n${memoryContext}`
    });
  }

  messages.push(...history);

  const currentMessage = {
    role: "user",
    content: prompt || "Describe this image and answer the likely question concisely."
  };

  if (image) {
    currentMessage.images = [image];
  }

  messages.push(currentMessage);

  const model = image ? VISION_MODEL : CHAT_MODEL;

  const result = await callOllama({
    model,
    messages,
    temperature: 0.45,
    maxTokens: 2600,
    think: Boolean(body.thinkCarefully)
  });

  const content = cleanText(result?.message?.content, 200_000).trim();

  if (!content) {
    throw Object.assign(new Error("The model returned an empty answer."), {
      statusCode: 502,
      code: "EMPTY_MODEL_RESPONSE"
    });
  }

  sendJson(response, 200, {
    content,
    model,
    usage: {
      promptTokens: result?.prompt_eval_count || 0,
      responseTokens: result?.eval_count || 0
    }
  });
}

async function handleGenerateFiles(request, response) {
  const body = await readJsonBody(request);

  const prompt = cleanText(body.prompt, 60_000).trim();
  const memoryContext = cleanText(body.memoryContext, 20_000).trim();
  const recentContext = cleanText(body.recentContext, 20_000).trim();

  if (!prompt) {
    return sendJson(response, 400, {
      code: "EMPTY_PROMPT",
      error: "A coding request is required."
    });
  }

  const userPrompt = `USER REQUEST:
${prompt}

${recentContext ? `RECENT CURRENT CONVERSATION:
${recentContext}

` : ""}${memoryContext ? `RELEVANT SAVED MEMORY:
${memoryContext}

` : ""}FINAL BUILD REQUIREMENTS:
- Create the complete requested result now.
- Do not return a tutorial or plan instead of the files.
- If this is a normal HTML/CSS/JavaScript website and separate files were not explicitly requested, produce one self-contained index.html.
- Ensure every file is complete and immediately usable.
- Keep the message concise.`;

  const result = await callOllama({
    model: FILE_MODEL,
    messages: [
      {
        role: "system",
        content: FILE_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: userPrompt
      }
    ],
    format: FILE_SCHEMA,
    temperature: 0.25,
    maxTokens: 16_000,
    think: true
  });

  const rawContent = cleanText(result?.message?.content, 8_000_000).trim();

  if (!rawContent) {
    throw Object.assign(new Error("The model returned no file data."), {
      statusCode: 502,
      code: "EMPTY_MODEL_RESPONSE"
    });
  }

  let parsed;

  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const objectMatch = rawContent.match(/\{[\s\S]*\}/);

    if (!objectMatch) {
      throw Object.assign(new Error("The model returned invalid file data."), {
        statusCode: 502,
        code: "INVALID_MODEL_JSON"
      });
    }

    parsed = JSON.parse(objectMatch[0]);
  }

  const files = Array.isArray(parsed?.files)
    ? parsed.files
        .slice(0, 4)
        .map((file, index) => {
          const content = stripCodeFence(file?.content);
          const fallback = `vedgpt-file-${index + 1}.txt`;

          return {
            name: safeFilename(file?.name, fallback),
            language: cleanText(file?.language || "text", 50),
            content
          };
        })
        .filter((file) => {
          const bytes = Buffer.byteLength(file.content);
          return bytes > 0 && bytes <= MAX_FILE_BYTES;
        })
    : [];

  if (!files.length) {
    throw Object.assign(
      new Error("The model did not return a complete usable file."),
      {
        statusCode: 502,
        code: "NO_USABLE_FILES"
      }
    );
  }

  sendJson(response, 200, {
    message:
      cleanText(parsed?.message, 500).trim() ||
      `Done — I created ${files.length === 1 ? "the file" : `${files.length} files`}.`,
    files,
    model: FILE_MODEL
  });
}

async function handleHealth(response) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const ollamaResponse = await fetch(
      `${OLLAMA_URL}/api/tags`,
      {
        headers: {
          Authorization: `Bearer ${OLLAMA_API_KEY}`
        },
        signal: controller.signal
      }
    );

    const data = ollamaResponse.ok
      ? await ollamaResponse.json()
      : { models: [] };

    const installed = Array.isArray(data?.models)
      ? data.models.map(
          (entry) => entry.name || entry.model
        )
      : [];

    sendJson(response, 200, {
      ok: ollamaResponse.ok,
      ollamaUrl: OLLAMA_URL,
      chatModel: CHAT_MODEL,
      fileModel: FILE_MODEL,
      visionModel: VISION_MODEL,
      installedModels: installed
    });
  } catch (error) {
    sendJson(response, 503, {
      ok: false,
      code: "OLLAMA_OFFLINE",
      error:
        error?.message ||
        "Ollama Cloud could not be reached."
    });
  } finally {
    clearTimeout(timer);
  }
}async function handleHealth(response) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const ollamaResponse = await fetch(`${OLLAMA_URL}/api/tags`, {
  headers: {
    "Authorization": `Bearer ${OLLAMA_API_KEY}`
  },
  signal: controller.signal
});
    });

    const data = ollamaResponse.ok
      ? await ollamaResponse.json()
      : { models: [] };

    const installed = Array.isArray(data?.models)
      ? data.models.map((entry) => entry.name || entry.model)
      : [];

    sendJson(response, 200, {
      ok: ollamaResponse.ok,
      ollamaUrl: OLLAMA_URL,
      chatModel: CHAT_MODEL,
      fileModel: FILE_MODEL,
      visionModel: VISION_MODEL,
      installedModels: installed
    });
  } catch {
    sendJson(response, 503, {
      ok: false,
      code: "OLLAMA_OFFLINE",
      error: "Ollama is not running."
    });
  } finally {
    clearTimeout(timer);
  }
}

function serveIndex(response) {
  fs.readFile(INDEX_FILE, "utf8", (error, content) => {
    if (error) {
      sendJson(response, 500, {
        code: "INDEX_NOT_FOUND",
        error: "index.html was not found beside ai-server.js."
      });
      return;
    }

    sendText(response, 200, content, "text/html; charset=utf-8");
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      serveIndex(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      await handleHealth(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/generate-files") {
      await handleGenerateFiles(request, response);
      return;
    }

    sendJson(response, 404, {
      code: "NOT_FOUND",
      error: "Route not found."
    });
  } catch (error) {
    console.error(error);

    sendJson(
      response,
      Number(error?.statusCode || 500),
      {
        code: error?.code || "SERVER_ERROR",
        error: error?.message || "Unexpected server error."
      }
    );
  }
});

server.requestTimeout = AI_TIMEOUT_MS + 15_000;
server.headersTimeout = AI_TIMEOUT_MS + 20_000;

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("VedGPT Cloud local AI server is running.");
  console.log(`Open: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`Chat model: ${CHAT_MODEL}`);
  console.log(`File model: ${FILE_MODEL}`);
  console.log(`Vision model: ${VISION_MODEL}`);
  console.log("");
});
