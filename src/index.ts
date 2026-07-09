import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerProjectSupervisor } from "./supervisor.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type RouteId = "daily-coach" | "algo-coach" | "engineer-coach" | "deep-expert";
type SemanticRouteId = Exclude<RouteId, "deep-expert">;

interface Route {
  agentId: RouteId;
  reason: string;
  confidence?: number;
}

interface AgentEntry {
  id?: string;
  model?: string | { primary: string; fallbacks?: string[] };
  workspace?: string;
  agentDir?: string;
}

interface PluginConfig {
  embeddingModel?: string;
  embeddingProvider?: string;
  semanticThreshold?: number;
  semanticMargin?: number;
  classifierModel?: string;
  classifierProvider?: string;
  enableCascade?: boolean;
  contextWindowSize?: number;
  workspaceDir?: string;
  embeddingCacheFile?: string;
}

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  agentId?: RouteId;
  timestamp: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_WORKSPACE = process.env.OPENCLAW_STUDY_WORKSPACE ?? "D:\\learn\\agent-learning";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_SEMANTIC_THRESHOLD = 0.38;
const DEFAULT_SEMANTIC_MARGIN = 0.12;
const DEFAULT_CLASSIFIER_MODEL = "deepseek-v4-flash";
const DEFAULT_PROVIDER = "sorux-chat";
const ESCALATE_SIGNAL = "[ESCALATE_TO_DEEP_EXPERT]";
const SPECIALIST_TIMEOUT_MS = 60_000;
const DEEP_EXPERT_TIMEOUT_MS = 90_000;
const EMBEDDING_TIMEOUT_MS = 8_000;
const CLASSIFIER_TIMEOUT_MS = 10_000;
const ROUTE_TOTAL_TIMEOUT_MS = 15_000;
const DEFAULT_CONTEXT_WINDOW_SIZE = 4;
const CONVERSATION_CACHE_MAX = 100;
const MAX_FALLBACK_RETRIES = 3;
const PROCESSED_IDS_MAX = 500;
const processedMessageIds = new Set<string>();

// ─── Route Descriptions (for semantic embedding) ─────────────────────────────

const ROUTE_DESCRIPTIONS: Record<SemanticRouteId, string> = {
  "daily-coach": [
    "study plan daily plan weekly plan review retrospective check-in schedule progress supervision reminder goal",
    "task list what to learn how to learn stuck no motivation calendar pomodoro timer error notebook knowledge review",
    "learning state timebox blocked learning flow daily coaching planning retro motivation"
  ].join(" "),
  "algo-coach": [
    "algorithm data structure complexity leetcode problem solution two pointers sliding window dynamic programming dp greedy recursion",
    "backtracking binary search graph theory shortest path union find binary indexed tree segment tree stack queue heap hash map",
    "sorting search bfs dfs topological sort proof math competition array linked list binary tree optimize time complexity space complexity",
    "hint brute force edge case practice complexity analysis algorithm tutoring step by step"
  ].join(" "),
  "engineer-coach": [
    "code review debugging error log deployment server interface api sdk authentication authorization environment variable git npm",
    "python typescript javascript java docker project engineering implementation fix troubleshoot security secret key",
    "openclaw codex qqbot agent plugin function calling tool calling rag vector database backend frontend",
    "traceback stack trace deploy config refactor architecture bug fix crash exception performance optimization"
  ].join(" ")
};

// ─── Fast-path: fixed commands (zero-cost, instant) ──────────────────────────

const FAST_PATHS: Array<{ regex: RegExp; route: RouteId; reason: string }> = [
  { regex: /(5\.?5|gpt-?5\.?5|最强模型|最深分析|专家模式|拉满|认真推理|deep\s*expert)/i, route: "deep-expert", reason: "fast:explicit-deep" },
  { regex: /^(你好|hi|hello|hey|在吗|在不在)\s*$/i, route: "daily-coach", reason: "fast:greeting" },
  { regex: /(今日学习|开始学习|安排今天|今天学什么|今日计划|今日任务)/i, route: "daily-coach", reason: "fast:today" },
  { regex: /(复盘|我学完了|今天完成了|总结今天|今日总结)/i, route: "daily-coach", reason: "fast:retro" },
  { regex: /(今日复习|错题复习|复习错题|抽查错题|来个复习|巩固一下)/i, route: "daily-coach", reason: "fast:review-drill" },
  { regex: /(安排本周|周计划|本周计划)/i, route: "daily-coach", reason: "fast:weekly" },
  { regex: /(给我一道算法题|来一道题|出一道题|来道题|练习题)/i, route: "algo-coach", reason: "fast:practice" },
];

// ─── Built-in replies (no agent call needed) ─────────────────────────────────

const HELP_TEXT = [
  "📖 CodeStudy Coach 使用指南",
  "",
  "📌 学习命令：",
  "  今日学习 — 安排今天的学习任务",
  "  复盘 — 总结今天的学习",
  "  今日复习 / 错题复习 — 从错题本抽查一个薄弱点",
  "  安排本周 — 生成本周计划",
  "  给我一道算法题 — 出一道练习题",
  "",
  "💻 直接提问：",
  "  算法题、复杂度分析、数据结构 → 算法教练",
  "  代码审查、调试、报错、部署 → 工程教练",
  "  学习计划、进度、卡住了 → 日常教练",
  "",
  "⚡ 特殊：",
  "  5.5 / 最强模型 / 专家模式 → 深度专家（最难的问题）",
  "  帮助 / help → 显示本指南",
].join("\n");

export function isHelpCommand(content: string): boolean {
  return /^(帮助|help|怎么用|能用什么|有什么功能)\s*$/i.test(content.trim());
}

// ─── Regex fallback (only when API unavailable) ──────────────────────────────

const CODE_SHAPE_RE =
  /(```|^\s*(def|class|function|const|let|var|import|from|public|private|interface|type|package|func)\s|\{[\s\S]*\}|=>|Traceback|Exception|Error:)/m;

const ALGO_RE =
  /(算法|数据结构|复杂度|leetcode|力扣|题解|双指针|滑动窗口|动态规划|dp\b|贪心|递归|回溯|二分|图论|最短路|并查集|树状数组|线段树|栈|队列|堆|哈希|排序|搜索|bfs|dfs|拓扑|证明|数学题|acm|竞赛|数组题|链表题|二叉树)/i;

const ENGINEER_RE =
  /(openclaw|codex|qqbot|api|debug|调试|报错|日志|部署|代码审查|code review|review|bug|异常|git|npm|python|typescript|docker|脚本|函数|类|项目|工程|实现|修复|排查|安全|密钥|token|jwt|环境变量)/i;

const DAILY_RE =
  /(学习计划|今日计划|明日计划|周计划|复盘|总结|打卡|安排|进度|监督|提醒|规划|目标|任务清单|学什么|怎么学|卡住了|没动力|日程|timebox|番茄钟|错题本|错题复习|复习错题|今日复习|抽查|巩固|知识点整理)/i;

// ─── Route Prompts ───────────────────────────────────────────────────────────

const CONCEPT_INTRO_RULES = [
  "The user is rebuilding programming foundations. Do not casually introduce many new terms.",
  "Introduce at most two new concepts in one reply unless the user asks for a broad overview.",
  "When a new concept is necessary, explain it immediately in one short sentence using the format: 新概念：X = ...",
  "If a concept is not needed for the current task, put it in a short 以后再学 note instead of explaining it now.",
  "Do not stack unexplained terms such as RAG, embedding, middleware, decorator, hash map, scope, or runtime without a plain-language explanation.",
  "Prefer one runnable example over several abstract definitions.",
  "When a new concept is likely to recur, add or reuse a concise plain-language entry in concept-glossary.md.",
  "If a previous answer confused the user, untangle the vocabulary before continuing the main task."
].join(" ");

const ROUTE_PROMPTS: Record<RouteId, string> = {
  "daily-coach": [
    "You are Daily Coach in a Chinese programming-learning system.",
    "Help with daily planning, review, motivation, and small finishable learning tasks.",
    "Keep replies concise, concrete, and action-oriented.",
    CONCEPT_INTRO_RULES,
    "When the user asks for review drill, read wrong-notes.md and ask exactly one short question about one weak point. Do not reveal the answer first. After the user answers, check it strictly and update memory if useful.",
    "If USER.md or learning-state.md still has unconfirmed profile fields, ask at most one calibration question after the main answer, prioritizing daily study time, learning direction, or nearest goal.",
    "If the user's question is beyond your scope (hard architecture, deep debugging, algorithm tutoring), append " + ESCALATE_SIGNAL + " at the end of your reply.",
    "After answering, if the user shared progress or completed a task, update today.md and learning-state.md in the workspace.",
    "Do not give empty praise. If the user's self-report is incomplete or vague, point out specifically what is missing and ask them to fill in the gaps.",
    "At the end of each conversation, create or update memory/YYYY-MM-DD.md with a brief note of what was discussed. Read the file first; if it does not exist, create it."
  ].join(" "),
  "algo-coach": [
    "You are Algo Coach in a Chinese programming-learning system.",
    "Tutor algorithms and data structures with hints, complexity analysis, edge cases, and practice steps.",
    "Avoid dumping final code immediately unless the user asks for it or is clearly stuck.",
    CONCEPT_INTRO_RULES,
    "If the problem requires hard architecture decisions or system-level design beyond algorithm scope, append " + ESCALATE_SIGNAL + " at the end of your reply.",
    "When the user makes a recurring mistake or learns a new pattern, update wrong-notes.md in the workspace.",
    "Be a strict tutor: if the user's answer is incomplete, wrong, or only addresses part of your question, you must explicitly point out what is missing or incorrect. Do not say 'correct' or 'well done' when the answer is partial. List the specific points they still need to address and give a hint for each.",
    "At the end of each conversation, create or update memory/YYYY-MM-DD.md with a brief note of what was discussed and any mistakes or insights. Read the file first; if it does not exist, create it."
  ].join(" "),
  "engineer-coach": [
    "You are Engineer Coach in a Chinese programming-learning system.",
    "Handle code review, debugging, APIs, tooling, OpenClaw, Codex, QQBot, deployment, logs, and security.",
    "Prefer symptom, cause, minimal fix, verification command, and prevention note.",
    CONCEPT_INTRO_RULES,
    "If the problem is very hard architecture, repeated failures, or needs the strongest model, append " + ESCALATE_SIGNAL + " at the end of your reply.",
    "When the user learns a new engineering concept or resolves a bug, update learning-state.md in the workspace.",
    "When the user makes a recurring programming mistake or learns a corrected debugging pattern, update wrong-notes.md in the workspace with a concise entry.",
    "Do not let incorrect code pass without comment. If the user's fix is incomplete or has remaining issues, list them explicitly before moving on.",
    "At the end of each conversation, create or update memory/YYYY-MM-DD.md with a brief note of what was discussed. Read the file first; if it does not exist, create it."
  ].join(" "),
  "deep-expert": [
    "You are Deep Expert in a Chinese programming-learning system.",
    "Handle hard architecture, repeated failures, high-stakes decisions, and requests for the strongest/deep/5.5 model.",
    "Reason carefully and give decisive tradeoffs.",
    CONCEPT_INTRO_RULES
  ].join(" ")
};

// ─── Conversation context cache (multi-turn) ─────────────────────────────────

class ConversationCache {
  private cache = new Map<string, ConversationTurn[]>();
  private maxSize: number;
  private windowSize: number;

  constructor(maxSize: number, windowSize: number) {
    this.maxSize = maxSize;
    this.windowSize = windowSize;
  }

  getTurns(conversationId: string): ConversationTurn[] {
    return this.cache.get(conversationId) ?? [];
  }

  addTurn(conversationId: string, turn: ConversationTurn): void {
    const turns = this.cache.get(conversationId) ?? [];
    turns.push(turn);
    if (turns.length > this.windowSize) {
      turns.splice(0, turns.length - this.windowSize);
    }
    this.cache.set(conversationId, turns);
    if (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
  }
}

let conversationCache: ConversationCache | null = null;

function getConversationCache(windowSize?: number): ConversationCache {
  if (!conversationCache) {
    conversationCache = new ConversationCache(CONVERSATION_CACHE_MAX, windowSize ?? DEFAULT_CONTEXT_WINDOW_SIZE);
  }
  return conversationCache;
}

// ─── Fast-path routing (exported for testing) ────────────────────────────────

export function selectRouteFastPath(content: string): Route | null {
  const text = content.trim();
  for (const { regex, route, reason } of FAST_PATHS) {
    if (regex.test(text)) return { agentId: route, reason };
  }
  return null;
}

// ─── Regex fallback routing (exported for testing) ───────────────────────────

export function selectRouteRegex(content: string): Route {
  const text = content.trim();
  if (CODE_SHAPE_RE.test(text)) return { agentId: "engineer-coach", reason: "regex:code-shape" };
  if (ALGO_RE.test(text)) return { agentId: "algo-coach", reason: "regex:algo" };
  if (ENGINEER_RE.test(text)) return { agentId: "engineer-coach", reason: "regex:engineering" };
  if (DAILY_RE.test(text)) return { agentId: "daily-coach", reason: "regex:daily" };
  return { agentId: "daily-coach", reason: "regex:default" };
}

// ─── Embedding utilities ─────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function embed(text: string, baseUrl: string, apiKey: string, model: string): Promise<number[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text })
  }, EMBEDDING_TIMEOUT_MS);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`embeddings API ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json() as { data?: Array<{ embedding?: number[] }> };
  const embedding = data.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error("embeddings API returned no embedding");
  return embedding;
}

let routeEmbeddingCache: Map<SemanticRouteId, number[]> | null = null;
let routeEmbeddingCacheModel: string | null = null;
let routeEmbeddingCacheFile: string | null = null;

function loadEmbeddingCacheFromFile(cacheFile: string, expectedModel: string): Map<SemanticRouteId, number[]> | null {
  try {
    if (!existsSync(cacheFile)) return null;
    const data = JSON.parse(readFileSync(cacheFile, "utf-8"));
    if (!data || !data.model || !data.embeddings) return null;
    if (data.model !== expectedModel) return null;
    const cache = new Map<SemanticRouteId, number[]>();
    for (const [id, emb] of Object.entries(data.embeddings)) {
      if (Array.isArray(emb)) cache.set(id as SemanticRouteId, emb as number[]);
    }
    if (cache.size === 3) return cache;
    return null;
  } catch {
    return null;
  }
}

function saveEmbeddingCacheToFile(cacheFile: string, model: string, cache: Map<SemanticRouteId, number[]>): void {
  try {
    const dir = dirname(cacheFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const embeddings: Record<string, number[]> = {};
    for (const [id, emb] of cache) embeddings[id] = emb;
    writeFileSync(cacheFile, JSON.stringify({ model, embeddings, savedAt: new Date().toISOString() }, null, 2));
  } catch {
    // Non-critical: cache is best-effort
  }
}

function getWorkspaceDir(cfg: any, pluginCfg?: PluginConfig): string {
  return pluginCfg?.workspaceDir ?? cfg?.workspaceDir ?? cfg?.workspace?.dir ?? DEFAULT_WORKSPACE;
}

function getEmbeddingCacheFile(cfg: any, pluginCfg?: PluginConfig): string {
  return pluginCfg?.embeddingCacheFile ?? join(getWorkspaceDir(cfg, pluginCfg), ".route-embeddings.json");
}

export function resetRouteEmbeddingCacheForTests(): void {
  routeEmbeddingCache = null;
  routeEmbeddingCacheModel = null;
  routeEmbeddingCacheFile = null;
}

async function getRouteEmbeddings(
  baseUrl: string,
  apiKey: string,
  model: string,
  cacheFile: string
): Promise<Map<SemanticRouteId, number[]>> {
  if (routeEmbeddingCache && routeEmbeddingCacheModel === model && routeEmbeddingCacheFile === cacheFile) {
    return routeEmbeddingCache;
  }

  const fileCache = loadEmbeddingCacheFromFile(cacheFile, model);
  if (fileCache) {
    routeEmbeddingCache = fileCache;
    routeEmbeddingCacheModel = model;
    routeEmbeddingCacheFile = cacheFile;
    return fileCache;
  }

  const entries = Object.entries(ROUTE_DESCRIPTIONS) as Array<[SemanticRouteId, string]>;
  const cache = new Map<SemanticRouteId, number[]>();
  const results = await Promise.all(
    entries.map(async ([id, description]) => {
      const embedding = await embed(description, baseUrl, apiKey, model);
      return [id, embedding] as const;
    })
  );
  for (const [id, embedding] of results) {
    cache.set(id, embedding);
  }
  routeEmbeddingCache = cache;
  routeEmbeddingCacheModel = model;
  routeEmbeddingCacheFile = cacheFile;
  saveEmbeddingCacheToFile(cacheFile, model, cache);
  return cache;
}

// ─── LLM classifier ──────────────────────────────────────────────────────────

async function llmClassify(
  content: string,
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<Route> {
  const systemPrompt = "You are a message router. Output ONLY the route ID on the last line. Format: ROUTE: <id>. Options: daily-coach, algo-coach, engineer-coach. Do not explain.";

  const userPrompt = [
    "将用户消息分到最合适的专家。在最后一行输出 ROUTE: <id>。",
    "选项：",
    "- daily-coach：学习计划、复盘、打卡、进度、监督",
    "- algo-coach：算法题、数据结构、复杂度、LeetCode",
    "- engineer-coach：代码审查、调试、报错、部署、API",
    "",
    "用户消息：",
    content
  ].join("\n");

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_tokens: 150,
      temperature: 0
    })
  }, CLASSIFIER_TIMEOUT_MS);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`classifier API ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  const match = text.match(/(?:ROUTE:|分类到|路由到|应分类到|选择)\s*(daily-coach|algo-coach|engineer-coach)/i)
    ?? text.match(/(daily-coach|algo-coach|engineer-coach)/i);
  if (!match) throw new Error(`classifier returned unrecognized: ${text.slice(0, 100)}`);
  return { agentId: match[1].toLowerCase() as SemanticRouteId, reason: "llm-classifier", confidence: 0.7 };
}

// ─── Config helpers ──────────────────────────────────────────────────────────

function currentConfig(api: any): any {
  return api.runtime?.config?.current?.() ?? api.config ?? {};
}

function getPluginConfig(cfg: any): PluginConfig {
  return (cfg.plugins?.["qq-study-router"] ?? cfg.pluginConfig?.["qq-study-router"] ?? {}) as PluginConfig;
}

function getEnvVar(name: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    return process.env[name];
  }
  return undefined;
}

function getProviderCredentials(cfg: any, providerId: string): { baseUrl?: string; apiKey?: string } {
  const providers = cfg.models?.providers ?? cfg.providers ?? cfg.provider ?? {};
  const provider = providers[providerId];
  if (provider && typeof provider === "object") {
    const baseUrl = provider.baseUrl ?? provider.base_url ?? provider.baseURL;
    let apiKey = provider.apiKey ?? provider.api_key ?? provider.key;
    if (apiKey && typeof apiKey === "object" && apiKey.id) {
      apiKey = getEnvVar(apiKey.id);
    }
    if (baseUrl && apiKey) return { baseUrl, apiKey };
  }
  if (providerId === "sorux-chat") {
    return {
      baseUrl: "https://ai.soruxgpt.com/v1",
      apiKey: getEnvVar("SORUX_CHAT_API_KEY") ?? getEnvVar("OPENAI_API_KEY")
    };
  }
  if (providerId === "sorux-codex") {
    return {
      baseUrl: "https://app.soruxgpt.com/api/codex",
      apiKey: getEnvVar("SORUX_CODEX_API_KEY")
    };
  }
  return {};
}

function findAgent(cfg: any, agentId: RouteId): AgentEntry {
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const found = list.find((entry: AgentEntry) => entry?.id === agentId);
  if (!found) throw new Error(`agent not found: ${agentId}`);
  return found;
}

// ─── Semantic routing (embedding + LLM classifier) ───────────────────────────

async function selectRouteSemantic(
  content: string,
  cfg: any,
  pluginCfg: PluginConfig
): Promise<Route> {
  const providerId = pluginCfg.embeddingProvider ?? DEFAULT_PROVIDER;
  const { baseUrl, apiKey } = getProviderCredentials(cfg, providerId);
  if (!baseUrl || !apiKey) throw new Error("no provider credentials for semantic routing");

  const embeddingModel = pluginCfg.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const threshold = pluginCfg.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  const margin = pluginCfg.semanticMargin ?? DEFAULT_SEMANTIC_MARGIN;

  const embeddings = await getRouteEmbeddings(
    baseUrl,
    apiKey,
    embeddingModel,
    getEmbeddingCacheFile(cfg, pluginCfg)
  );
  const queryEmb = await embed(content, baseUrl, apiKey, embeddingModel);

  const scored = Array.from(embeddings.entries()).map(([id, emb]) => ({
    agentId: id,
    score: cosineSimilarity(queryEmb, emb)
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (best.score >= threshold && (second ? best.score - second.score >= margin : true)) {
    return { agentId: best.agentId, reason: `semantic(${best.score.toFixed(3)},margin=${(best.score - (second?.score ?? 0)).toFixed(3)})`, confidence: best.score };
  }

  const clsProviderId = pluginCfg.classifierProvider ?? DEFAULT_PROVIDER;
  const { baseUrl: clsBaseUrl, apiKey: clsApiKey } = getProviderCredentials(cfg, clsProviderId);
  if (!clsBaseUrl || !clsApiKey) throw new Error("no provider credentials for classifier");

  const classifierModel = pluginCfg.classifierModel ?? DEFAULT_CLASSIFIER_MODEL;
  try {
    return await llmClassify(content, clsBaseUrl, clsApiKey, classifierModel);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (best.score > 0.1) {
      return { agentId: best.agentId, reason: `semantic-fallback(${best.score.toFixed(3)},classifier_failed)`, confidence: best.score };
    }
    throw new Error(`classifier failed and semantic score too low: ${errMsg.slice(0, 80)}`);
  }
}

// ─── Main route selection (exported, async) ──────────────────────────────────

export async function selectRoute(
  content: string,
  cfg?: any,
  pluginCfg?: PluginConfig,
  logger?: { info?: (msg: string) => void; error?: (msg: string) => void; warn?: (msg: string) => void }
): Promise<Route> {
  const text = content.trim();
  if (!text) return { agentId: "daily-coach", reason: "empty" };

  const fast = selectRouteFastPath(text);
  if (fast) return fast;

  if (cfg) {
    const routeStartTime = Date.now();
    try {
      const pc = pluginCfg ?? getPluginConfig(cfg);
      const routePromise = selectRouteSemantic(text, cfg, pc);
      const timeoutPromise = new Promise<Route>((_, reject) =>
        setTimeout(() => reject(new Error("route total timeout")), ROUTE_TOTAL_TIMEOUT_MS)
      );
      return await Promise.race([routePromise, timeoutPromise]);
    } catch (e) {
      const elapsed = Date.now() - routeStartTime;
      const errMsg = e instanceof Error ? e.message : String(e);
      logger?.warn?.(`qq-study-router: semantic routing failed in ${elapsed}ms, falling back to regex: ${errMsg.slice(0, 100)}`);
      // Fall through to regex
    }
  }

  return selectRouteRegex(text);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitModel(modelRef: string | undefined): { provider?: string; model?: string } {
  if (!modelRef) return {};
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) return { model: modelRef };
  return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function buildConversationId(event: any, ctx: any, channelId: string): string {
  const chatId = firstString(
    ctx?.conversationId,
    ctx?.chatId,
    event?.chatId,
    event?.groupId,
    event?.guildId,
    event?.channelId,
    event?.senderId,
    ctx?.senderId
  ) ?? "default";
  return [channelId, chatId].join(":");
}

function buildMessageDedupeKey(event: any, ctx: any, channelId: string): string {
  const messageId = firstString(event?.messageId, event?.id);
  if (!messageId) return "";
  const chatId = firstString(ctx?.chatId, ctx?.conversationId, event?.chatId, event?.groupId, event?.guildId) ?? "default";
  const senderId = firstString(event?.senderId, ctx?.senderId) ?? "unknown";
  return [channelId, chatId, senderId, messageId].join(":");
}

function collectText(payloads: unknown): string {
  if (!Array.isArray(payloads)) return "";
  const texts: string[] = [];
  const reasoningTexts: string[] = [];
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    const record = payload as { text?: unknown; isReasoning?: unknown; isError?: unknown };
    if (record.isError || typeof record.text !== "string") continue;
    const trimmed = record.text.trim();
    if (!trimmed) continue;
    if (record.isReasoning) {
      reasoningTexts.push(trimmed);
    } else {
      texts.push(trimmed);
    }
  }
  const result = texts.join("\n\n").trim();
  if (result) return result;
  return reasoningTexts.join("\n\n").trim();
}

function formatContextTurns(turns: ConversationTurn[]): string {
  if (turns.length === 0) return "";
  const lines = ["Recent conversation context (for continuity):"];
  for (const turn of turns) {
    const role = turn.role === "user" ? "User" : `${turn.agentId ?? "Assistant"}`;
    const preview = turn.content.length > 200 ? turn.content.slice(0, 200) + "..." : turn.content;
    lines.push(`[${role}] ${preview}`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildPrompt(route: Route, content: string, contextTurns: ConversationTurn[]): string {
  const ctxStr = formatContextTurns(contextTurns);
  return [
    ROUTE_PROMPTS[route.agentId],
    "",
    `Routing reason: ${route.reason}.`,
    "Answer the user's QQ message directly in Simplified Chinese.",
    "Do not mention internal routing, run ids, JSON payloads, or model metadata unless the user asks for diagnostics.",
    ctxStr ? "" : null,
    ctxStr || null,
    "",
    "User message:",
    content
  ].filter(l => l !== null).join("\n");
}

function buildCascadePrompt(content: string, specialistText: string, contextTurns: ConversationTurn[]): string {
  const ctxStr = formatContextTurns(contextTurns);
  return [
    ROUTE_PROMPTS["deep-expert"],
    "",
    "A specialist agent attempted this question but escalated it for deeper analysis.",
    "Specialist's partial answer:",
    specialistText,
    ctxStr ? "" : null,
    ctxStr || null,
    "",
    "Original user message:",
    content,
    "",
    "Provide a deeper, more thorough analysis. Answer the user directly in Simplified Chinese.",
    "Do not mention internal routing, run ids, JSON payloads, or model metadata."
  ].filter(l => l !== null).join("\n");
}

// ─── Agent run with fallback retry ───────────────────────────────────────────

function isRetryableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /403|429|503|quota|额度|budget|rate.?limit|no.?available|unavailable|insufficient|empty text|aborted|timeout|timed.?out|ECONNRESET|fetch failed|500|502/i.test(msg);
}

function getAgentModelRef(agent: AgentEntry): string | undefined {
  if (!agent.model) return undefined;
  if (typeof agent.model === "string") return agent.model;
  if (typeof agent.model === "object" && agent.model.primary) return agent.model.primary;
  return undefined;
}

function getAgentFallbackModels(cfg: any, agentId: RouteId): string[] {
  const agent = findAgent(cfg, agentId);
  const fallbacks: string[] = [];
  const primary = getAgentModelRef(agent);
  if (primary) fallbacks.push(primary);

  const agentModel = (agent as any).model;
  if (agentModel && typeof agentModel === "object" && Array.isArray(agentModel.fallbacks)) {
    for (const f of agentModel.fallbacks) {
      if (typeof f === "string" && !fallbacks.includes(f)) fallbacks.push(f);
    }
  }
  const agentFallbacks = (agent as any).fallbacks;
  if (Array.isArray(agentFallbacks)) {
    for (const f of agentFallbacks) {
      if (typeof f === "string" && !fallbacks.includes(f)) fallbacks.push(f);
    }
  }
  const defaultFallbacks = cfg.agents?.defaults?.model?.fallbacks;
  if (Array.isArray(defaultFallbacks)) {
    for (const f of defaultFallbacks) {
      if (typeof f === "string" && !fallbacks.includes(f)) fallbacks.push(f);
    }
  }
  return fallbacks;
}

async function runAgentWithFallback(
  api: any,
  cfg: any,
  params: {
    agentId: RouteId;
    sessionId: string;
    sessionKey: string;
    conversation: string;
    event: any;
    ctx: any;
    prompt: string;
    extraSystemPrompt: string;
    timeoutMs: number;
    workspaceDir: string;
    agentDir?: string;
  }
): Promise<{ text: string; modelUsed: string }> {
  const modelChain = getAgentFallbackModels(cfg, params.agentId);
  const maxRetries = Math.min(modelChain.length, MAX_FALLBACK_RETRIES);
  let lastError: unknown = null;

  for (let i = 0; i < maxRetries; i++) {
    const modelRef = modelChain[i];
    const { provider, model } = splitModel(modelRef);
    const isPrimary = i === 0;

    try {
      const result = await api.runtime.agent.runEmbeddedAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionTarget: { agentId: params.agentId, sessionId: params.sessionId, sessionKey: params.sessionKey },
        agentId: params.agentId,
        messageChannel: "qqbot",
        chatType: params.event?.isGroup ? "group" : "direct",
        agentAccountId: params.ctx?.accountId,
        trigger: "user",
        senderId: params.event?.senderId ?? params.ctx?.senderId ?? null,
        currentChannelId: "qqbot",
        chatId: params.conversation,
        workspaceDir: params.workspaceDir,
        cwd: params.workspaceDir,
        agentDir: params.agentDir,
        config: cfg,
        prompt: params.prompt,
        currentInboundContext: { text: params.prompt },
        timeoutMs: params.timeoutMs,
        runTimeoutOverrideMs: params.timeoutMs,
        runId: `qq-study-router-${params.agentId}-${randomUUID()}`,
        provider,
        model,
        extraSystemPrompt: params.extraSystemPrompt,
        disableMessageTool: true,
        suppressLiveStreamOutput: true
      });

      const text = collectText(result?.payloads);
      if (!text) throw new Error("routed agent returned empty text");

      if (!isPrimary) {
        api.logger?.info?.(`qq-study-router: fallback to ${modelRef} succeeded`);
      }
      return { text, modelUsed: modelRef };
    } catch (error) {
      lastError = error;
      const errorMsg = error instanceof Error ? error.message : String(error);
      api.logger?.error?.(
        `qq-study-router: ${params.agentId} with ${modelRef} failed: ${errorMsg.slice(0, 150)}`
      );
      if (!isRetryableError(error) || i === maxRetries - 1) break;
      api.logger?.info?.(`qq-study-router: retrying ${params.agentId} with fallback ${modelChain[i + 1]}`);
    }
  }

  throw lastError ?? new Error("all fallbacks exhausted");
}

// ─── Plugin Entry ────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "qq-study-router",
  name: "QQ Study Router",
  description: "Route QQBot messages to learning specialist agents using semantic embedding, LLM classification, cascade escalation, and multi-turn context.",
  register(api: any) {
    registerProjectSupervisor(api);

    const cfg = currentConfig(api);
    const pluginCfg = getPluginConfig(cfg);
    const enableCascade = pluginCfg.enableCascade !== false;
    const cache = getConversationCache(pluginCfg.contextWindowSize);

    const required: RouteId[] = ["daily-coach", "algo-coach", "engineer-coach", "deep-expert"];
    for (const id of required) {
      try {
        findAgent(cfg, id);
      } catch {
        api.logger?.error?.(
          `qq-study-router: agent "${id}" not found in config — routing to this agent will fail`
        );
      }
    }

    api.logger?.info?.("qq-study-router: registered (semantic + cascade + context routing v0.3.0)");

    api.on("before_dispatch", async (event: any, ctx: any) => {
      const channelId = String(ctx?.channelId ?? event?.channel ?? "");
      if (channelId !== "qqbot") return;

      const content = String(event?.content ?? event?.body ?? "").trim();
      if (!content) return;

      // Message dedup: skip if we've seen this exact message recently
      const dedupeKey = buildMessageDedupeKey(event, ctx, channelId);
      if (dedupeKey) {
        if (processedMessageIds.has(dedupeKey)) {
          api.logger?.info?.(`qq-study-router: dedup skip (key=${hashId(dedupeKey).slice(0, 16)})`);
          return;
        }
        processedMessageIds.add(dedupeKey);
        if (processedMessageIds.size > PROCESSED_IDS_MAX) {
          const oldest = processedMessageIds.values().next().value;
          if (oldest) processedMessageIds.delete(oldest);
        }
      }

      // Built-in help command (no agent call needed)
      if (isHelpCommand(content)) {
        api.logger?.info?.("qq-study-router: help command -> built-in reply");
        return { handled: true, text: HELP_TEXT };
      }

      const conversation = buildConversationId(event, ctx, channelId);
      const routeStartTime = Date.now();
      const route = await selectRoute(content, cfg, pluginCfg, api.logger);
      const routeTimeMs = Date.now() - routeStartTime;

      const agent = findAgent(cfg, route.agentId);
      const sessionId = `qq-study-${route.agentId}-${hashId(conversation)}`;
      const sessionKey = `qq-study-router:${route.agentId}:${hashId(conversation)}`;
      const timeoutMs = route.agentId === "deep-expert" ? DEEP_EXPERT_TIMEOUT_MS : SPECIALIST_TIMEOUT_MS;

      api.logger?.info?.(
        `qq-study-router: ${route.reason} -> ${route.agentId} (${getAgentModelRef(agent) ?? "default"}) | route=${routeTimeMs}ms | conv=${hashId(conversation).slice(0, 8)}`
      );

      const contextTurns = cache.getTurns(conversation);

      try {
        const agentStartTime = Date.now();
        const { text, modelUsed } = await runAgentWithFallback(api, cfg, {
          agentId: route.agentId,
          sessionId,
          sessionKey,
          conversation,
          event,
          ctx,
          prompt: buildPrompt(route, content, contextTurns),
          extraSystemPrompt: ROUTE_PROMPTS[route.agentId],
          timeoutMs,
          workspaceDir: agent.workspace ?? getWorkspaceDir(cfg, pluginCfg),
          agentDir: agent.agentDir,
        });

        const agentTimeMs = Date.now() - agentStartTime;
        api.logger?.info?.(
          `qq-study-router: ${route.agentId} completed | model=${modelUsed} | agent=${agentTimeMs}ms | total=${routeTimeMs + agentTimeMs}ms | reply=${text.length}chars`
        );

        // Cascade: check for escalation signal from specialist
        if (enableCascade && text.includes(ESCALATE_SIGNAL) && route.agentId !== "deep-expert") {
          const specialistText = text.replace(ESCALATE_SIGNAL, "").trim();
          api.logger?.info?.("qq-study-router: cascade escalate -> deep-expert");

          try {
            const deepAgent = findAgent(cfg, "deep-expert");
            const deepSessionId = `qq-study-deep-expert-${hashId(conversation)}`;
            const deepSessionKey = `qq-study-router:deep-expert:${hashId(conversation)}`;

            const deepStartTime = Date.now();
            const { text: deepText, modelUsed: deepModel } = await runAgentWithFallback(api, cfg, {
              agentId: "deep-expert",
              sessionId: deepSessionId,
              sessionKey: deepSessionKey,
              conversation,
              event,
              ctx,
              prompt: buildCascadePrompt(content, specialistText, contextTurns),
              extraSystemPrompt: ROUTE_PROMPTS["deep-expert"],
              timeoutMs: DEEP_EXPERT_TIMEOUT_MS,
              workspaceDir: deepAgent.workspace ?? getWorkspaceDir(cfg, pluginCfg),
              agentDir: deepAgent.agentDir,
            });

            const deepTimeMs = Date.now() - deepStartTime;
            api.logger?.info?.(
              `qq-study-router: deep-expert cascade completed | model=${deepModel} | deep=${deepTimeMs}ms | total=${routeTimeMs + agentTimeMs + deepTimeMs}ms`
            );

            cache.addTurn(conversation, { role: "user", content, timestamp: Date.now() });
            cache.addTurn(conversation, { role: "assistant", content: deepText || specialistText, agentId: "deep-expert", timestamp: Date.now() });

            if (deepText) return { handled: true, text: deepText };
          } catch (deepError) {
            api.logger?.error?.(
              `qq-study-router: deep-expert cascade failed: ${
                deepError instanceof Error ? deepError.message : String(deepError)
              }`
            );
          }
          cache.addTurn(conversation, { role: "user", content, timestamp: Date.now() });
          cache.addTurn(conversation, { role: "assistant", content: specialistText, agentId: route.agentId, timestamp: Date.now() });
          return { handled: true, text: specialistText };
        }

        // Cache the conversation turn for multi-turn context
        cache.addTurn(conversation, { role: "user", content, timestamp: Date.now() });
        cache.addTurn(conversation, { role: "assistant", content: text, agentId: route.agentId, timestamp: Date.now() });

        return { handled: true, text };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isTimeout = /timeout|abort|timed?\s*out/i.test(errorMsg);
        api.logger?.error?.(
          `qq-study-router: route to ${route.agentId} failed: ${errorMsg}`
        );
        const replyText = isTimeout
          ? "这个问题有点难，我需要更多时间来思考。请稍等一下再问一次，或者把问题拆小一点试试。"
          : `抱歉，处理你的消息时出了点问题（${route.agentId} 暂时不可用）。请稍后再试，或者重新描述你的问题。`;
        return { handled: true, text: replyText };
      }
    });
  }
});
