#!/usr/bin/env node

import http from "node:http";
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

process.umask(0o077);

const host = process.env.WB_GATEWAY_HOST || "127.0.0.1";
const port = Number(process.env.WB_GATEWAY_PORT || 18490);
const backendHost = "127.0.0.1";
const backendPort = Number(process.env.WB_BACKEND_PORT || 18491);
const backendBase = `http://${backendHost}:${backendPort}`;
const cwd = process.env.WB_WORKSPACE || process.cwd();
const maxBodyBytes = Number(process.env.WB_MAX_BODY_BYTES || 2 * 1024 * 1024);
const maxConcurrent = Number(process.env.WB_MAX_CONCURRENT || 60);
const maxQueued = Number(process.env.WB_MAX_QUEUED || 16);
const queueTimeoutMs = Number(process.env.WB_QUEUE_TIMEOUT_MS || 180000);
const maxContextTokens = Number(process.env.WB_MAX_CONTEXT_TOKENS || 1000000);
const dataDir = process.env.WB_DATA_DIR || join(homedir(), ".workbuddy2api");
const tokenFile = process.env.WB_TOKEN_FILE || join(dataDir, "token");
const productConfig = process.env.WB_PRODUCT_CONFIG || join(dataDir, "product-gateway.json");
if (host !== "127.0.0.1") throw new Error("This release supports loopback access only");
const usageFile = process.env.WB_USAGE_FILE || `${dirname(tokenFile || ".")}/usage.jsonl`;
const staticDir = process.env.WB_DASHBOARD_DIR || `${dirname(fileURLToPath(import.meta.url))}/dashboard`;
const cli = process.env.WB_CLI || "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";

if (!tokenFile || !existsSync(tokenFile)) {
  throw new Error("WB_TOKEN_FILE is missing or does not exist");
}
if (!existsSync(cli)) {
  throw new Error(`WorkBuddy CLI not found: ${cli}`);
}

const accessToken = readFileSync(tokenFile, "utf8").trim();
if (accessToken.length < 32) throw new Error("Gateway token is too short");

const usageState = {
  startedAt: null,
  updatedAt: null,
  totals: {
    requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
  },
  byModel: new Map(),
  byClient: new Map(),
  byDay: new Map(),
  recent: [],
};

const usageListeners = new Set();

function localDayKey(timestamp) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

function addUsageToGroup(map, key, labelField, record) {
  const label = key || "unknown";
  const stats = map.get(label) || { [labelField]: label, requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
  stats.requests += 1;
  for (const field of ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "reasoning_tokens"]) {
    stats[field] += Number(record[field] || 0);
  }
  map.set(label, stats);
}

function applyUsageRecord(record) {
  usageState.startedAt ||= record.timestamp;
  usageState.updatedAt = record.timestamp;
  usageState.totals.requests += 1;
  usageState.totals[record.status === "success" ? "successful_requests" : "failed_requests"] += 1;
  for (const field of ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "reasoning_tokens"]) {
    usageState.totals[field] += Number(record[field] || 0);
  }
  addUsageToGroup(usageState.byModel, record.model, "model", record);
  addUsageToGroup(usageState.byClient, record.client, "client", record);
  addUsageToGroup(usageState.byDay, localDayKey(record.timestamp), "date", record);
  usageState.recent.push(record);
  if (usageState.recent.length > 100) usageState.recent.shift();
}

if (existsSync(usageFile)) {
  for (const line of readFileSync(usageFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { applyUsageRecord(JSON.parse(line)); } catch {}
  }
  chmodSync(usageFile, 0o600);
}

function recordUsage(record) {
  const normalized = { timestamp: new Date().toISOString(), ...record };
  try {
    appendFileSync(usageFile, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(usageFile, 0o600);
    applyUsageRecord(normalized);
    broadcastUsage();
  } catch (error) {
    console.error(`Failed to record usage: ${error.message}`);
  }
}

function usageSummary(limit = 20) {
  const safeLimit = Math.max(0, Math.min(Number(limit) || 20, 100));
  return {
    object: "workbuddy.gateway.usage",
    period: { started_at: usageState.startedAt, updated_at: usageState.updatedAt },
    totals: { ...usageState.totals },
    by_model: [...usageState.byModel.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_client: [...usageState.byClient.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_day: [...usageState.byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30),
    recent: usageState.recent.slice(-safeLimit).reverse(),
  };
}

function broadcastUsage() {
  if (usageListeners.size === 0) return;
  const payload = `event: usage\ndata: ${JSON.stringify(usageSummary(50))}\n\n`;
  for (const response of usageListeners) {
    try { response.write(payload); } catch { usageListeners.delete(response); }
  }
}

function normalizeUsage(raw = {}) {
  const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? raw.inputTokens ?? 0);
  const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? raw.outputTokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(raw.total_tokens ?? raw.totalTokens ?? (prompt + completion)),
    cached_tokens: Number(raw.cached_tokens ?? raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens ?? 0),
    reasoning_tokens: Number(raw.completion_tokens_details?.reasoning_tokens ?? raw.completion_thinking_tokens ?? 0),
  };
}

function sumUsage(byRequest) {
  const total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
  for (const usage of byRequest.values()) {
    for (const field of Object.keys(total)) total[field] += usage[field] || 0;
  }
  return total;
}

let activeRequests = 0;
const waitingRequests = [];
let shuttingDown = false;
let backendPassword = "";
let resolveBackendPassword;
let rejectBackendPassword;
const backendPasswordReady = new Promise((resolve, reject) => {
  resolveBackendPassword = resolve;
  rejectBackendPassword = reject;
});

function removeWaitingRequest(entry) {
  const index = waitingRequests.indexOf(entry);
  if (index >= 0) waitingRequests.splice(index, 1);
}

function settleWaitingRequest(entry, result) {
  clearTimeout(entry.timer);
  entry.res.off("close", entry.onClose);
  entry.resolve(result);
}

function acquireRequestSlot(res) {
  if (activeRequests < maxConcurrent) {
    activeRequests += 1;
    return Promise.resolve({ ok: true });
  }
  if (waitingRequests.length >= maxQueued) return Promise.resolve({ ok: false, reason: "full" });

  return new Promise((resolve) => {
    const entry = { res, resolve, timer: null, onClose: null };
    entry.onClose = () => {
      removeWaitingRequest(entry);
      settleWaitingRequest(entry, { ok: false, reason: "closed" });
    };
    entry.timer = setTimeout(() => {
      removeWaitingRequest(entry);
      settleWaitingRequest(entry, { ok: false, reason: "timeout" });
    }, queueTimeoutMs);
    res.once("close", entry.onClose);
    waitingRequests.push(entry);
  });
}

function releaseRequestSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  while (activeRequests < maxConcurrent && waitingRequests.length > 0) {
    const entry = waitingRequests.shift();
    if (entry.res.destroyed) {
      settleWaitingRequest(entry, { ok: false, reason: "closed" });
      continue;
    }
    activeRequests += 1;
    settleWaitingRequest(entry, { ok: true });
  }
}

const backend = spawn(process.execPath, [cli,
  "--serve",
  "--host", backendHost,
  "--port", String(backendPort),
  "--auth", "password",
  "--no-session-persistence",
  "--permission-mode", "dontAsk",
  "--tools", "",
  "--model", process.env.WB_DEFAULT_MODEL || "auto",
], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1", CODEBUDDY_CREDENTIALS_IN_MEMORY: "1", ACC_PRODUCT_CONFIG_PATH: productConfig, WORKBUDDY_CONFIG_DIR: process.env.WB_CONFIG_DIR || join(homedir(), ".workbuddy"), CODEBUDDY_CONFIG_DIR: process.env.WB_CONFIG_DIR || join(homedir(), ".workbuddy") },
});

let backendOutputBuffer = "";
backend.stdout.on("data", (chunk) => {
  backendOutputBuffer += chunk.toString("utf8").replaceAll(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const match = backendOutputBuffer.match(/Password\s+([A-Za-z0-9_-]{16,})/);
  if (match && !backendPassword) {
    backendPassword = match[1];
    resolveBackendPassword(backendPassword);
    backendOutputBuffer = backendOutputBuffer.replaceAll(backendPassword, "[REDACTED]");
  }
  const lines = backendOutputBuffer.split("\n");
  backendOutputBuffer = lines.pop() || "";
  for (const line of lines) {
    if (line.trim() && !line.includes("password=")) console.log(`[workbuddy] ${line}`);
  }
});
backend.stderr.on("data", (chunk) => {
  const line = chunk.toString("utf8");
  if (!line.includes("password=")) process.stderr.write(`[workbuddy] ${line}`);
});

backend.on("exit", (code, signal) => {
  if (!backendPassword) rejectBackendPassword(new Error("WorkBuddy backend exited before providing its password"));
  if (!shuttingDown) {
    console.error(`WorkBuddy backend exited (code=${code}, signal=${signal})`);
    process.exit(code || 1);
  }
});

function backendHeaders(extra = {}) {
  if (!backendPassword) throw new Error("WorkBuddy backend authentication is not ready");
  return { "x-codebuddy-request": "1", "authorization": `Bearer ${backendPassword}`, ...extra };
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") && safeEqual(header.slice(7), accessToken);
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function serveDashboardAsset(res, pathname) {
  const assets = {
    "/dashboard": ["index.html", "text/html; charset=utf-8"],
    "/dashboard/": ["index.html", "text/html; charset=utf-8"],
    "/dashboard/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/dashboard/app.js": ["app.js", "text/javascript; charset=utf-8"],
  };
  const asset = assets[pathname];
  if (!asset) return false;
  const file = `${staticDir}/${asset[0]}`;
  if (!existsSync(file)) {
    json(res, 503, { error: { message: "Dashboard assets are unavailable", type: "api_error" } });
    return true;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": asset[1],
    "content-length": body.length,
    "cache-control": asset[0] === "index.html" ? "no-store" : "public, max-age=300",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(body);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

async function waitForBackend() {
  await Promise.race([
    backendPasswordReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for WorkBuddy backend password")), 15000)),
  ]);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (backend.exitCode !== null) throw new Error("WorkBuddy backend stopped during startup");
    try {
      const response = await fetch(`${backendBase}/api/v1/health`, {
        headers: backendHeaders(),
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for WorkBuddy backend");
}

async function acpConnect() {
  const response = await fetch(`${backendBase}/api/v1/acp/connect`, {
    method: "POST",
    headers: backendHeaders(),
  });
  if (!response.ok) throw new Error(`ACP connect failed: ${response.status}`);
  return response.json();
}

async function parseSse(response, onEvent) {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`ACP request failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try { await onEvent(JSON.parse(data)); } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }
}

async function acpRpc(connectionId, payload, onEvent = async () => {}) {
  let result;
  let rpcError;
  const response = await fetch(`${backendBase}/api/v1/acp`, {
    method: "POST",
    headers: backendHeaders({
      "acp-connection-id": connectionId,
      "content-type": "application/json",
      "accept": "text/event-stream, application/json",
    }),
    body: JSON.stringify(payload),
  });
  await parseSse(response, async (event) => {
    if (event.id === payload.id && event.error) rpcError = event.error;
    if (event.id === payload.id && event.result !== undefined) result = event.result;
    await onEvent(event);
  });
  if (rpcError) {
    const error = new Error(`${rpcError.message}: ${rpcError.data?.details || ""}`.trim());
    if (/authentication required|authentication failed/i.test(error.message)) {
      error.status = 401;
      error.message = "WorkBuddy backend authentication expired or unavailable; restore WorkBuddy CLI authentication";
    }
    throw error;
  }
  return result;
}

async function acpDisconnect(connectionId) {
  try {
    await fetch(`${backendBase}/api/v1/acp`, {
      method: "DELETE",
      headers: backendHeaders({ "acp-connection-id": connectionId }),
    });
  } catch {}
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .join("\n");
}

function messageToPrompt(message) {
  const role = String(message.role || "user").toUpperCase();
  const parts = [];
  const content = textFromContent(message.content);
  if (content) parts.push(content);
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    parts.push(`TOOL_CALLS:\n${JSON.stringify(message.tool_calls)}`);
  }
  if (message.role === "tool") {
    const toolLabel = message.name || message.tool_call_id || "tool";
    return `TOOL RESULT (${toolLabel}):\n${parts.join("\n")}`;
  }
  return `${role}:\n${parts.join("\n")}`;
}

function messagesToPrompt(messages) {
  return messages.map(messageToPrompt).join("\n\n");
}

function estimateTokens(text) {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 2.6 + nonAscii * 1.2);
}

function truncateToTokenBudget(text, budget, label = "content") {
  if (budget <= 0) return `[${label} omitted by gateway]`;
  const estimated = estimateTokens(text);
  if (estimated <= budget) return text;
  const marker = `\n[${label} truncated by gateway to fit model context]\n`;
  const ratio = Math.max(0.01, budget / estimated);
  const targetChars = Math.max(200, Math.floor(text.length * ratio) - marker.length);
  const headLength = Math.floor(targetChars * 0.35);
  const tailLength = Math.max(0, targetChars - headLength);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function compactSchema(value) {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  const skipped = new Set(["description", "title", "examples", "example", "default", "$comment", "deprecated", "readOnly", "writeOnly"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !skipped.has(key)).map(([key, child]) => [key, compactSchema(child)]));
}

function normalizeRequestedTools(body) {
  if (Array.isArray(body.tools)) return body.tools.filter((tool) => tool?.type === "function" && tool.function?.name);
  if (Array.isArray(body.functions)) return body.functions.filter((fn) => fn?.name).map((fn) => ({ type: "function", function: fn }));
  return [];
}

function toolInstruction(tools, choice) {
  if (!tools.length || choice === "none") return "";
  const compactTools = tools.map((tool) => ({
    name: tool.function.name,
    description: String(tool.function.description || "").slice(0, 240),
    parameters: compactSchema(tool.function.parameters || { type: "object", properties: {} }),
  }));
  let choiceRule = "Choose a tool only when it is needed.";
  const forcedName = choice?.function?.name || (typeof choice === "object" ? choice.name : null);
  if (forcedName) choiceRule = `You must call the function named ${forcedName}.`;
  if (choice === "required") choiceRule = "You must call at least one function.";
  return [
    "You are producing a function-call decision for an external agent.",
    "These are external function descriptions, not WorkBuddy tools. Do NOT execute them and do NOT check whether they exist in your internal tool list.",
    "Your only job is to serialize the function invocation for the external agent, which will execute it later.",
    "The external application provides the following functions:",
    JSON.stringify(compactTools),
    choiceRule,
    "When a function is selected, output ONLY one JSON object with this exact shape:",
    '{"tool_calls":[{"name":"function_name","arguments":{}}]}',
    "Multiple calls may be included in tool_calls. Do not use Markdown fences.",
    "Never say that a listed external function is unavailable; selecting it as JSON data is always allowed.",
    "If no function is needed, answer normally and do not output the tool_calls object.",
  ].join("\n");
}

function buildBoundedPrompt(messages, functionGuide, maxInputTokens) {
  const advertisedLimit = Number(maxInputTokens || 128000);
  const budget = Math.max(12000, Math.min(maxContextTokens, advertisedLimit - 32000));
  const guideBudget = Math.floor(budget * 0.4);
  let guide = functionGuide ? truncateToTokenBudget(functionGuide, guideBudget, "external tool definitions") : "";
  let remaining = budget - estimateTokens(guide) - 500;
  const rendered = messages.map((message, index) => ({ index, role: message.role, text: messageToPrompt(message) }));
  const selected = new Map();
  let trimmed = guide !== functionGuide;

  const systemMessages = rendered.filter((item) => item.role === "system" || item.role === "developer");
  const systemBudget = Math.max(1000, Math.floor(remaining * 0.3));
  let systemRemaining = systemBudget;
  for (const item of systemMessages) {
    if (systemRemaining <= 0) { trimmed = true; continue; }
    const itemTokens = estimateTokens(item.text);
    const text = itemTokens <= systemRemaining ? item.text : truncateToTokenBudget(item.text, systemRemaining, "system message");
    selected.set(item.index, text);
    systemRemaining -= estimateTokens(text);
    remaining -= estimateTokens(text);
    if (text !== item.text) trimmed = true;
  }

  const conversation = rendered.filter((item) => item.role !== "system" && item.role !== "developer");
  for (let position = conversation.length - 1; position >= 0; position -= 1) {
    const item = conversation[position];
    if (remaining <= 500) { trimmed = true; continue; }
    const itemTokens = estimateTokens(item.text);
    if (itemTokens <= remaining) {
      selected.set(item.index, item.text);
      remaining -= itemTokens;
    } else {
      selected.set(item.index, truncateToTokenBudget(item.text, remaining, "older message"));
      remaining = 0;
      trimmed = true;
    }
  }

  const keptMessages = [...selected.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text);
  const omittedMessages = Math.max(0, rendered.length - selected.size);
  const omissionNote = trimmed ? `[Gateway context management: ${omittedMessages} older message(s) omitted or truncated to fit the ${advertisedLimit}-token model window.]` : "";
  const sections = [guide, omissionNote, keptMessages.length ? `Conversation:\n${keptMessages.join("\n\n")}` : ""].filter(Boolean);
  let text = sections.join("\n\n");
  if (estimateTokens(text) > budget) {
    text = truncateToTokenBudget(text, budget, "request context");
    trimmed = true;
  }
  return { text, budget, estimatedTokens: estimateTokens(text), trimmed, omittedMessages };
}

function extractJsonObject(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}

function parseToolCalls(text, tools) {
  if (!tools.length) return [];
  const allowed = new Set(tools.map((tool) => tool.function.name));
  const parsed = extractJsonObject(text);
  const candidates = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : parsed?.name ? [parsed] : [];
  return candidates.flatMap((call) => {
    const fn = call.function || call;
    if (!fn?.name || !allowed.has(fn.name)) return [];
    let args = fn.arguments ?? {};
    if (typeof args !== "string") args = JSON.stringify(args);
    return [{
      id: call.id || `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      type: "function",
      function: { name: fn.name, arguments: args },
    }];
  });
}

async function newAcpSession(model) {
  const { connectionId } = await acpConnect();
  await acpRpc(connectionId, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientInfo: { name: "workbuddy-openai-gateway", version: "1.0.0" }, clientCapabilities: {} },
  });
  const session = await acpRpc(connectionId, {
    jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] },
  });
  const selectedModel = model && model !== "auto" ? model : session.models?.currentModelId || "auto";
  const selectedModelInfo = session.models?.availableModels?.find((candidate) => candidate.modelId === selectedModel);
  if (selectedModel !== session.models?.currentModelId) {
    await acpRpc(connectionId, {
      jsonrpc: "2.0", id: 3, method: "session/set_model",
      params: { sessionId: session.sessionId, modelId: selectedModel },
    });
  }
  return { connectionId, session, selectedModel, maxInputTokens: selectedModelInfo?._meta?.maxInputTokens || 128000 };
}

async function listModels() {
  const state = await newAcpSession("auto");
  try {
    return state.session.models?.availableModels || [];
  } finally {
    await acpDisconnect(state.connectionId);
  }
}

async function previewContext(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    const error = new Error("messages must be a non-empty array");
    error.status = 400;
    throw error;
  }
  const requestedTools = normalizeRequestedTools(body);
  const toolsEnabled = requestedTools.length > 0 && body.tool_choice !== "none" && body.function_call !== "none";
  const state = await newAcpSession(body.model || "auto");
  try {
    const guide = toolsEnabled ? toolInstruction(requestedTools, body.tool_choice || body.function_call) : "";
    const plan = buildBoundedPrompt(body.messages, guide, state.maxInputTokens);
    return {
      model: state.selectedModel,
      max_input_tokens: state.maxInputTokens,
      context_budget: plan.budget,
      estimated_prompt_tokens: plan.estimatedTokens,
      context_trimmed: plan.trimmed,
      messages_omitted: plan.omittedMessages,
    };
  } finally {
    await acpDisconnect(state.connectionId);
  }
}

async function chatCompletions(req, res, body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(res, 400, { error: { message: "messages must be a non-empty array", type: "invalid_request_error" } });
  }
  const requestedTools = normalizeRequestedTools(body);
  const toolsEnabled = requestedTools.length > 0 && body.tool_choice !== "none" && body.function_call !== "none";

  const state = await newAcpSession(body.model || "auto");
  const completionId = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const startedAt = Date.now();
  const usageByRequest = new Map();
  const clientName = String(req.headers["x-client-name"] || body.user || "unknown").replaceAll(/[^A-Za-z0-9_.:@ -]/g, "_").slice(0, 80);
  let output = "";
  let ended = false;
  let usageRecorded = false;
  const functionGuide = toolsEnabled ? toolInstruction(requestedTools, body.tool_choice || body.function_call) : "";
  const contextPlan = buildBoundedPrompt(body.messages, functionGuide, state.maxInputTokens);
  const contextHeaders = {
    "x-workbuddy-context-trimmed": contextPlan.trimmed ? "1" : "0",
    "x-workbuddy-estimated-prompt-tokens": String(contextPlan.estimatedTokens),
    "x-workbuddy-context-budget": String(contextPlan.budget),
    "x-workbuddy-messages-omitted": String(contextPlan.omittedMessages),
  };

  if (body.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
      ...contextHeaders,
    });
    res.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created, model: state.selectedModel, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
  }

  try {
    const promptResult = await acpRpc(state.connectionId, {
      jsonrpc: "2.0", id: 4, method: "session/prompt",
      params: { sessionId: state.session.sessionId, prompt: [{ type: "text", text: contextPlan.text }] },
    }, async (event) => {
      const update = event.method === "session/update" ? event.params?.update : null;
      if (update?.sessionUpdate === "usage_update" && update._meta?.usage) {
        const providerRequestId = String(update._meta["codebuddy.ai/requestId"] || "request");
        usageByRequest.set(providerRequestId, normalizeUsage(update._meta.usage));
      }
      if (update?.sessionUpdate === "agent_message_chunk") {
        const chunk = update.content?.text || "";
        output += chunk;
        if (body.stream && chunk && !toolsEnabled) {
          res.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created, model: state.selectedModel, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
        }
      }
      if (update?.sessionUpdate === "session_end") {
        ended = true;
        if (update.stopReason && !["end_turn", "cancelled"].includes(update.stopReason)) {
          throw new Error(update.errorMessage || `WorkBuddy stopped: ${update.stopReason}`);
        }
      }
    });

    if (!ended && promptResult?.stopReason) {
      ended = true;
      if (!["end_turn", "cancelled"].includes(promptResult.stopReason)) {
        throw new Error(promptResult.errorMessage || `WorkBuddy stopped: ${promptResult.stopReason}`);
      }
    }
    if (!ended) throw new Error("WorkBuddy response ended without a completion status");
    const toolCalls = toolsEnabled ? parseToolCalls(output, requestedTools) : [];
    const finishReason = toolCalls.length ? "tool_calls" : "stop";
    const usage = sumUsage(usageByRequest);
    recordUsage({
      request_id: completionId,
      client: clientName,
      model: state.selectedModel,
      status: "success",
      stream: body.stream === true,
      duration_ms: Date.now() - startedAt,
      context_trimmed: contextPlan.trimmed,
      estimated_prompt_tokens: contextPlan.estimatedTokens,
      context_budget: contextPlan.budget,
      messages_omitted: contextPlan.omittedMessages,
      ...usage,
    });
    usageRecorded = true;
    if (body.stream) {
      if (toolsEnabled) {
        if (toolCalls.length) {
          for (let index = 0; index < toolCalls.length; index += 1) {
            const call = toolCalls[index];
            res.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created, model: state.selectedModel, choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: "function", function: call.function }] }, finish_reason: null }] })}\n\n`);
          }
        } else if (output) {
          res.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created, model: state.selectedModel, choices: [{ index: 0, delta: { content: output }, finish_reason: null }] })}\n\n`);
        }
      }
      const finalChunk = { id: completionId, object: "chat.completion.chunk", created, model: state.selectedModel, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
      if (body.stream_options?.include_usage) finalChunk.usage = usage;
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      json(res, 200, {
        id: completionId,
        object: "chat.completion",
        created,
        model: state.selectedModel,
        choices: [{
          index: 0,
          message: toolCalls.length ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: output },
          finish_reason: finishReason,
        }],
        usage,
      }, contextHeaders);
    }
  } catch (error) {
    if (!usageRecorded) {
      recordUsage({
        request_id: completionId,
        client: clientName,
        model: state.selectedModel,
        status: "error",
        stream: body.stream === true,
        duration_ms: Date.now() - startedAt,
        context_trimmed: contextPlan.trimmed,
        estimated_prompt_tokens: contextPlan.estimatedTokens,
        context_budget: contextPlan.budget,
        messages_omitted: contextPlan.omittedMessages,
        ...sumUsage(usageByRequest),
      });
    }
    throw error;
  } finally {
    await acpDisconnect(state.connectionId);
  }
}

async function proxyAcp(req, res, url) {
  const suffix = url.pathname.slice("/acp".length);
  const target = `${backendBase}/api/v1/acp${suffix}${url.search}`;
  const headers = { ...req.headers, ...backendHeaders(), host: `${backendHost}:${backendPort}` };
  delete headers["content-length"];
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
    duplex: "half",
  });
  const responseHeaders = Object.fromEntries(upstream.headers.entries());
  delete responseHeaders["content-encoding"];
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === "GET" && serveDashboardAsset(res, url.pathname)) return;
  if (req.method === "GET" && url.pathname === "/dashboard/api/usage") {
    return json(res, 200, usageSummary(url.searchParams.get("limit") || 50));
  }
  if (req.method === "GET" && url.pathname === "/dashboard/api/health") {
    return json(res, 200, { status: "ok", service: "workbuddy-gateway" });
  }
  if (req.method === "GET" && url.pathname === "/dashboard/api/agents") {
    let authenticated = false;
    try {
      const response = await fetch(`${backendBase}/api/v1/auth/account/status`, {
        headers: backendHeaders(), signal: AbortSignal.timeout(1500),
      });
      const status = await response.json();
      authenticated = response.ok && status.data?.authenticated === true;
    } catch {}
    return json(res, 200, { workbuddy: true, authenticated, activeRequests, queuedRequests: waitingRequests.length });
  }
  if (req.method === "GET" && url.pathname === "/dashboard/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    usageListeners.add(res);
    res.write(`event: usage\ndata: ${JSON.stringify(usageSummary(50))}\n\n`);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      usageListeners.delete(res);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    try {
      const upstream = await fetch(`${backendBase}/api/v1/health`, { headers: backendHeaders(), signal: AbortSignal.timeout(1500) });
      return json(res, upstream.ok ? 200 : 503, { status: upstream.ok ? "ok" : "backend_error", activeRequests, queuedRequests: waitingRequests.length });
    } catch {
      return json(res, 503, { status: "backend_unavailable", activeRequests, queuedRequests: waitingRequests.length });
    }
  }
  if (!authorized(req)) return json(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } }, { "www-authenticate": "Bearer" });
  if ((req.method === "GET" && url.pathname === "/v1/backend-auth/status") ||
      (req.method === "POST" && url.pathname === "/v1/backend-auth/login")) {
    const login = req.method === "POST";
    try {
      const response = await fetch(`${backendBase}/api/v1/auth/account/${login ? "login" : "status"}`, {
        method: login ? "POST" : "GET", headers: backendHeaders({"content-type":"application/json"}),
        ...(login ? {body: JSON.stringify({})} : {}), signal: AbortSignal.timeout(20000)
      });
      return json(res,response.status,await response.json());
    } catch {return json(res,502,{error:{message:"Backend account service unavailable"}});}
  }
  const slot = await acquireRequestSlot(res);
  if (!slot.ok) {
    if (slot.reason === "closed" || res.destroyed) return;
    const message = slot.reason === "timeout" ? "Gateway queue timed out" : "Gateway queue is full";
    return json(res, 429, { error: { message, type: "rate_limit_error" } }, { "retry-after": "5" });
  }
  try {
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const models = await listModels();
      return json(res, 200, { object: "list", data: models.map((model) => ({ id: model.modelId, object: "model", created: 0, owned_by: "workbuddy" })) });
    }
    if (req.method === "GET" && url.pathname === "/v1/usage") {
      return json(res, 200, usageSummary(url.searchParams.get("limit")));
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return await chatCompletions(req, res, await readJson(req));
    }
    if (req.method === "POST" && url.pathname === "/v1/context/preview") {
      return json(res, 200, await previewContext(await readJson(req)));
    }
    if (url.pathname === "/acp" || url.pathname.startsWith("/acp/")) {
      return await proxyAcp(req, res, url);
    }
    return json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  } catch (error) {
    console.error(error?.stack || error);
    if (!res.headersSent) json(res, error.status || 502, { error: { message: error.message || "Gateway error", type: "api_error" } });
    else if (!res.writableEnded) res.end();
  } finally {
    releaseRequestSlot();
  }
});

await waitForBackend();
server.listen(port, host, () => console.log(`WorkBuddy gateway listening on http://${host}:${port}`));

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  server.close(() => process.exit(0));
  backend.kill("SIGTERM");
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
