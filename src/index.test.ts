import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, {
  selectRouteFastPath,
  selectRouteRegex,
  selectRoute,
  isHelpCommand,
  resetRouteEmbeddingCacheForTests
} from "./index.js";

function testCacheFile(name: string): string {
  return join(tmpdir(), `qq-study-router-${name}-${Date.now()}-${Math.random()}.json`);
}

function testCfg(pluginConfig: Record<string, unknown> = {}) {
  return {
    plugins: {
      "qq-study-router": {
        embeddingModel: "test-embedding-model",
        classifierModel: "test-classifier-model",
        embeddingCacheFile: testCacheFile("embeddings"),
        ...pluginConfig
      }
    },
    models: {
      providers: {
        "sorux-chat": {
          baseUrl: "https://example.test/v1",
          apiKey: "test-key"
        }
      }
    },
    agents: {
      list: [
        { id: "daily-coach", model: "sorux-chat/deepseek-v4-flash", workspace: "D:\\learn\\agent-learning" },
        { id: "algo-coach", model: "sorux-chat/gpt-4o-mini", workspace: "D:\\learn\\agent-learning" },
        { id: "engineer-coach", model: "sorux-codex/gpt-5.4", workspace: "D:\\learn\\agent-learning" },
        { id: "deep-expert", model: "sorux-codex/gpt-5.5", workspace: "D:\\learn\\agent-learning" }
      ]
    }
  };
}

function mockRoutingFetch(chatRoute = "engineer-coach") {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL, options?: RequestInit) => {
    const urlText = String(url);
    calls.push(urlText);
    const body = JSON.parse(String(options?.body ?? "{}")) as { input?: string };

    if (urlText.endsWith("/embeddings")) {
      const input = body.input ?? "";
      let embedding: number[];
      if (input.includes("study plan daily plan")) embedding = [1, 0, 0];
      else if (input.includes("algorithm data structure")) embedding = [0, 1, 0];
      else if (input.includes("code review debugging")) embedding = [0, 0, 1];
      else if (input.includes("优化时间复杂度")) embedding = [0, 1, 0];
      else if (input.includes("这个东西怎么办")) embedding = [1, 0.99, 0];
      else embedding = [0, 0, 1];
      return new Response(JSON.stringify({ data: [{ embedding }] }), { status: 200 });
    }

    return new Response(JSON.stringify({
      choices: [{ message: { content: `ROUTE: ${chatRoute}` } }]
    }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {
  resetRouteEmbeddingCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetRouteEmbeddingCacheForTests();
});

describe("qq-study-router fast-path", () => {
  it("routes explicit deep-expert requests via strong signals", () => {
    expect(selectRouteFastPath("用5.5深度分析这个架构")?.agentId).toBe("deep-expert");
    expect(selectRouteFastPath("最强模型来一下")?.agentId).toBe("deep-expert");
    expect(selectRouteFastPath("专家模式")?.agentId).toBe("deep-expert");
    expect(selectRouteFastPath("gpt-5.5 分析")?.agentId).toBe("deep-expert");
  });

  it("does NOT route DFS/复杂度 to deep-expert (regression)", () => {
    expect(selectRouteFastPath("帮我分析下这道 DFS 题的复杂度")).toBeNull();
  });

  it("does NOT route 深度优先搜索 to deep-expert (regression)", () => {
    expect(selectRouteFastPath("深度优先搜索怎么实现")).toBeNull();
  });

  it("routes greetings to daily-coach", () => {
    expect(selectRouteFastPath("你好")?.agentId).toBe("daily-coach");
    expect(selectRouteFastPath("hi")?.agentId).toBe("daily-coach");
  });

  it("routes 今日学习 to daily-coach", () => {
    expect(selectRouteFastPath("今日学习")?.agentId).toBe("daily-coach");
    expect(selectRouteFastPath("开始学习")?.agentId).toBe("daily-coach");
  });

  it("routes 复盘 to daily-coach", () => {
    expect(selectRouteFastPath("复盘今天")?.agentId).toBe("daily-coach");
    expect(selectRouteFastPath("我学完了")?.agentId).toBe("daily-coach");
  });

  it("routes review drill requests to daily-coach", () => {
    expect(selectRouteFastPath("今日复习")?.agentId).toBe("daily-coach");
    expect(selectRouteFastPath("错题复习")?.agentId).toBe("daily-coach");
    expect(selectRouteFastPath("抽查错题")?.reason).toBe("fast:review-drill");
  });

  it("routes algorithm practice requests to algo-coach", () => {
    expect(selectRouteFastPath("给我一道算法题")?.agentId).toBe("algo-coach");
    expect(selectRouteFastPath("来一道题")?.agentId).toBe("algo-coach");
  });

  it("returns null for non-matching content", () => {
    expect(selectRouteFastPath("这道题怎么优化时间复杂度")).toBeNull();
  });
});

describe("qq-study-router built-in commands", () => {
  it("detects help commands", () => {
    expect(isHelpCommand("帮助")).toBe(true);
    expect(isHelpCommand("help")).toBe(true);
    expect(isHelpCommand("怎么用")).toBe(true);
    expect(isHelpCommand("有什么功能")).toBe(true);
  });

  it("does not trigger help on normal messages", () => {
    expect(isHelpCommand("帮我分析这道题")).toBe(false);
    expect(isHelpCommand("帮我看看代码")).toBe(false);
  });
});

describe("qq-study-router regex fallback", () => {
  it("routes code snippets to engineer-coach", () => {
    expect(selectRouteRegex("def add(a, b): return a - b").agentId).toBe("engineer-coach");
    expect(selectRouteRegex("```python\nprint('hi')\n```").agentId).toBe("engineer-coach");
    expect(selectRouteRegex("Traceback (most recent call last):").agentId).toBe("engineer-coach");
  });

  it("routes algorithm keywords to algo-coach", () => {
    expect(selectRouteRegex("这道 LeetCode 动态规划题怎么想").agentId).toBe("algo-coach");
    expect(selectRouteRegex("哈希表怎么用").agentId).toBe("algo-coach");
  });

  it("routes DFS + 复杂度 to algo-coach, not deep-expert (regression)", () => {
    expect(selectRouteRegex("帮我分析下这道 DFS 题的复杂度").agentId).toBe("algo-coach");
  });

  it("routes python + 哈希 to algo-coach, not engineer-coach (regression)", () => {
    expect(selectRouteRegex("用 python 写两数之和的哈希表解法").agentId).toBe("algo-coach");
  });

  it("routes engineering messages to engineer-coach", () => {
    expect(selectRouteRegex("OpenClaw 认证失败怎么排查").agentId).toBe("engineer-coach");
    expect(selectRouteRegex("我的 python 项目报错了").agentId).toBe("engineer-coach");
    expect(selectRouteRegex("git push 失败").agentId).toBe("engineer-coach");
  });

  it("routes daily messages to daily-coach", () => {
    expect(selectRouteRegex("今天我应该学什么").agentId).toBe("daily-coach");
    expect(selectRouteRegex("安排一下进度").agentId).toBe("daily-coach");
  });

  it("defaults to daily-coach for unrecognized content", () => {
    expect(selectRouteRegex("随便聊聊天").agentId).toBe("daily-coach");
  });
});

describe("qq-study-router selectRoute (no API config → regex fallback)", () => {
  it("routes algorithm messages to algo-coach", async () => {
    const route = await selectRoute("这道 LeetCode 动态规划题怎么想");
    expect(route.agentId).toBe("algo-coach");
  });

  it("routes explicit deep requests via fast-path", async () => {
    const route = await selectRoute("用5.5分析这个架构");
    expect(route.agentId).toBe("deep-expert");
  });

  it("routes engineering messages via regex fallback", async () => {
    const route = await selectRoute("OpenClaw 认证失败怎么排查");
    expect(route.agentId).toBe("engineer-coach");
  });

  it("does NOT route DFS/复杂度 to deep-expert (regression)", async () => {
    const route = await selectRoute("帮我分析下这道 DFS 题的复杂度");
    expect(route.agentId).toBe("algo-coach");
  });

  it("routes python + 哈希 to algo-coach (regression)", async () => {
    const route = await selectRoute("用 python 写两数之和的哈希表解法");
    expect(route.agentId).toBe("algo-coach");
  });

  it("routes empty content to daily-coach", async () => {
    const route = await selectRoute("");
    expect(route.agentId).toBe("daily-coach");
  });
});

describe("qq-study-router semantic routing", () => {
  it("uses confident semantic scores without calling the classifier", async () => {
    const { calls } = mockRoutingFetch();

    const route = await selectRoute("这道题怎么优化时间复杂度", testCfg());

    expect(route.agentId).toBe("algo-coach");
    expect(route.reason).toContain("semantic");
    expect(calls.some((url) => url.endsWith("/chat/completions"))).toBe(false);
  });

  it("falls through to the LLM classifier when semantic margin is low", async () => {
    const { calls } = mockRoutingFetch("engineer-coach");

    const route = await selectRoute("这个东西怎么办", testCfg());

    expect(route.agentId).toBe("engineer-coach");
    expect(route.reason).toBe("llm-classifier");
    expect(calls.some((url) => url.endsWith("/chat/completions"))).toBe(true);
  });
});

describe("qq-study-router cascade escalation", () => {
  it("routes escalation signals to deep-expert and hides the internal marker", async () => {
    const originalChatKey = process.env.SORUX_CHAT_API_KEY;
    const originalCodexKey = process.env.SORUX_CODEX_API_KEY;
    delete process.env.SORUX_CHAT_API_KEY;
    delete process.env.SORUX_CODEX_API_KEY;
    let beforeDispatch: ((event: any, ctx: any) => Promise<any>) | undefined;
    const cfg = {
      ...testCfg({}),
      plugins: { "qq-study-router": { enableCascade: true } },
      models: { providers: {} }
    };
    const runEmbeddedAgent = vi.fn(async (params: { agentId: string }) => {
      if (params.agentId === "engineer-coach") {
        return { payloads: [{ text: `先给一个初步判断\n\n[ESCALATE_TO_DEEP_EXPERT]` }] };
      }
      return { payloads: [{ text: "深度专家结论" }] };
    });
    const api: any = {
      runtime: {
        config: { current: () => cfg },
        agent: { runEmbeddedAgent }
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      on: vi.fn((name: string, handler: (event: any, ctx: any) => Promise<any>) => {
        if (name === "before_dispatch") beforeDispatch = handler;
      })
    };

    plugin.register(api);
    const result = await beforeDispatch?.(
      { channel: "qqbot", content: "我的 python 项目报错了", senderId: "u1", messageId: "m1" },
      { channelId: "qqbot", conversationId: "group-1" }
    );

    expect(result).toEqual({ handled: true, text: "深度专家结论" });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgent.mock.calls[0][0].agentId).toBe("engineer-coach");
    expect(runEmbeddedAgent.mock.calls[1][0].agentId).toBe("deep-expert");
    expect(result.text).not.toContain("[ESCALATE_TO_DEEP_EXPERT]");
    process.env.SORUX_CHAT_API_KEY = originalChatKey;
    process.env.SORUX_CODEX_API_KEY = originalCodexKey;
  });
});
