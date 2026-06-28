import {
  DEFAULT_MODEL,
  MODELS,
  PROMPT_1,
  PROMPT_2,
  PROMPT_3
} from "./config.js";

// ====== 模块级缓存：O(1) 查找，避免每次请求遍历 MODELS 数组 ======

/** modelId → { id, label, persona } */
const modelMap = new Map(MODELS.map((m) => [m.id, m]));

/** persona → prompt 的映射，O(1) 获取内置人设 */
const promptByPersona = new Map([
  [1, PROMPT_1],
  [2, PROMPT_2],
  [3, PROMPT_3],
]);

/** /config.js 响应内容 —— 仅在部署时生成一次，之后每次请求直接复用 */
const CONFIG_JS_BODY = (() => {
  const models = MODELS.map((m) => ({ id: m.id, label: m.label }));
  return `window.APP_MODELS = ${JSON.stringify(models, null, 2)};
window.APP_DEFAULT_MODEL = ${JSON.stringify(DEFAULT_MODEL)};
`;
})();

// ====== 工具函数 ======

function resp(body, contentType = "text/plain; charset=utf-8", status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, ...extraHeaders }
  });
}

function isAllowedModel(modelId) {
  return modelMap.has(modelId);
}

function builtinPromptForModel(modelId) {
  const meta = modelMap.get(modelId);
  const persona = meta?.persona ?? 1;
  return promptByPersona.get(persona) ?? PROMPT_1;
}

// ====== 请求处理 ======

const UPSTREAM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const UPSTREAM_TIMEOUT_MS = 120_000; // 2 分钟超时

async function handleChat(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return resp("Bad JSON", "text/plain; charset=utf-8", 400);
  }

  const requestedModel = payload?.model;
  const model = isAllowedModel(requestedModel) ? requestedModel : DEFAULT_MODEL;

  const useBuiltinPersona = payload?.use_builtin_persona !== false;
  const customSystemPrompt =
    typeof payload?.custom_system_prompt === "string"
      ? payload.custom_system_prompt.trim()
      : "";

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];

  // 上游消息组装
  const upstreamMessages = [];
  if (useBuiltinPersona) {
    upstreamMessages.push({ role: "system", content: builtinPromptForModel(model) });
  } else if (customSystemPrompt) {
    upstreamMessages.push({ role: "system", content: customSystemPrompt });
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    upstreamMessages.push({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : ""
    });
  }

  if (!env.NVIDIA_API_KEY) {
    return resp(
      "Missing NVIDIA_API_KEY (please set it with wrangler secret).",
      "text/plain; charset=utf-8",
      500
    );
  }

  // 上游请求（带超时保护）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages: upstreamMessages
      }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      return resp("Upstream request timed out", "text/plain; charset=utf-8", 504);
    }
    return resp(`Upstream connection failed: ${err.message}`, "text/plain; charset=utf-8", 502);
  }
  clearTimeout(timeoutId);

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => "");
    return resp(
      `Upstream error ${upstream.status}: ${errorText}`,
      "text/plain; charset=utf-8",
      502
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    }
  });
}

// ====== 入口 ======

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "GET" && url.pathname === "/config.js") {
      return resp(CONFIG_JS_BODY, "text/javascript; charset=utf-8");
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      return handleChat(request, env);
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return resp(
      "Static assets binding 'ASSETS' is missing. Please configure [assets] in wrangler.toml.",
      "text/plain; charset=utf-8",
      500
    );
  }
};