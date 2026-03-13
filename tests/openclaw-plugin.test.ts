/**
 * Tests for the OpenClaw TypeScript plugin entry point.
 *
 * Tests the register() function and the hooks it registers:
 *   - tool_call:before (routing enforcement)
 *   - tool_call:after (session event capture)
 *   - command:new (session initialization)
 *   - before_prompt_build (routing instruction injection)
 *   - context-mode context engine (compaction management)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock OpenClaw API ────────────────────────────────────

interface MockHookEntry {
  event: string;
  handler: (...args: unknown[]) => unknown;
  meta: { name: string; description: string };
}

interface MockLifecycleEntry {
  event: string;
  handler: (...args: unknown[]) => unknown;
  opts?: { priority?: number };
}

interface MockContextEngine {
  id: string;
  factory: () => {
    info: { id: string; name: string; ownsCompaction: boolean };
    ingest: (data: unknown) => Promise<{ ingested: boolean }>;
    assemble: (ctx: { messages: unknown[] }) => Promise<{ messages: unknown[]; estimatedTokens: number }>;
    compact: () => Promise<{ ok: boolean; compacted: boolean }>;
  };
}

function createMockApi() {
  const hooks: MockHookEntry[] = [];
  const lifecycle: MockLifecycleEntry[] = [];
  const contextEngines: MockContextEngine[] = [];

  return {
    hooks,
    lifecycle,
    contextEngines,
    api: {
      registerHook(
        event: string,
        handler: (...args: unknown[]) => unknown,
        meta: { name: string; description: string },
      ) {
        hooks.push({ event, handler, meta });
      },
      on(
        event: string,
        handler: (...args: unknown[]) => unknown,
        opts?: { priority?: number },
      ) {
        lifecycle.push({ event, handler, opts });
      },
      registerContextEngine(
        id: string,
        factory: () => MockContextEngine["factory"] extends () => infer R ? R : never,
      ) {
        contextEngines.push({ id, factory: factory as MockContextEngine["factory"] });
      },
    },
  };
}

/**
 * Create a plugin instance with a mock API.
 * Returns the mock API state and helper functions.
 */
async function createTestPlugin(tempDir: string) {
  const { default: register } = await import("../src/openclaw-plugin.js");
  const mock = createMockApi();
  await register(mock.api);
  return mock;
}

// ── Tests ─────────────────────────────────────────────────

describe("OpenClawPlugin", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-test-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* cleanup best effort */ }
  });

  // ── Registration ──────────────────────────────────────

  describe("registration", () => {
    it("registers tool_call:before hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-before"));
      const hookNames = mock.hooks.map((h) => h.event);
      expect(hookNames).toContain("tool_call:before");
    });

    it("registers tool_call:after hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-after"));
      const hookNames = mock.hooks.map((h) => h.event);
      expect(hookNames).toContain("tool_call:after");
    });

    it("registers command:new hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-new"));
      const hookNames = mock.hooks.map((h) => h.event);
      expect(hookNames).toContain("command:new");
    });

    it("registers before_prompt_build lifecycle hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-prompt"));
      const lifecycleEvents = mock.lifecycle.map((l) => l.event);
      expect(lifecycleEvents).toContain("before_prompt_build");
    });

    it("registers context-mode context engine", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-engine"));
      expect(mock.contextEngines).toHaveLength(1);
      expect(mock.contextEngines[0].id).toBe("context-mode");
    });

    it("hooks have proper metadata names", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-meta"));
      for (const hook of mock.hooks) {
        expect(hook.meta.name).toMatch(/^context-mode\./);
        expect(hook.meta.description.length).toBeGreaterThan(0);
      }
    });
  });

  // ── tool_call:before ──────────────────────────────────

  describe("tool_call:before", () => {
    it("modifies curl commands to block them", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-curl"));
      const beforeHook = mock.hooks.find((h) => h.event === "tool_call:before");
      expect(beforeHook).toBeDefined();

      const params = { command: "curl https://example.com/data" };
      const event = { toolName: "Bash", params };

      await beforeHook!.handler(event);

      // Routing replaces the curl command with an informative echo
      expect(params.command).toMatch(/^echo /);
      expect(params.command).toContain("context-mode");
    });

    it("modifies wget commands to block them", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-wget"));
      const beforeHook = mock.hooks.find((h) => h.event === "tool_call:before");

      const params = { command: "wget https://example.com/file" };
      const event = { toolName: "Bash", params };

      await beforeHook!.handler(event);

      expect(params.command).toMatch(/^echo /);
      expect(params.command).toContain("context-mode");
    });

    it("passes through normal tool calls", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-pass"));
      const beforeHook = mock.hooks.find((h) => h.event === "tool_call:before");

      const result = await beforeHook!.handler({
        toolName: "TaskCreate",
        params: { subject: "test task" },
      });

      expect(result).toBeUndefined();
    });

    it("handles empty input gracefully", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-empty"));
      const beforeHook = mock.hooks.find((h) => h.event === "tool_call:before");

      const result = await beforeHook!.handler({});
      expect(result).toBeUndefined();
    });
  });

  // ── tool_call:after ───────────────────────────────────

  describe("tool_call:after", () => {
    it("captures file read events without throwing", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-read"));
      const afterHook = mock.hooks.find((h) => h.event === "tool_call:after");

      await expect(
        afterHook!.handler({
          toolName: "Read",
          params: { file_path: "/test/file.ts" },
          output: "file contents here",
        }),
      ).resolves.toBeUndefined();
    });

    it("captures file write events", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-write"));
      const afterHook = mock.hooks.find((h) => h.event === "tool_call:after");

      await expect(
        afterHook!.handler({
          toolName: "Write",
          params: { file_path: "/test/new-file.ts", content: "code" },
        }),
      ).resolves.toBeUndefined();
    });

    it("captures git events from Bash", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-git"));
      const afterHook = mock.hooks.find((h) => h.event === "tool_call:after");

      await expect(
        afterHook!.handler({
          toolName: "Bash",
          params: { command: "git commit -m 'test'" },
          output: "[main abc1234] test",
        }),
      ).resolves.toBeUndefined();
    });

    it("handles empty input gracefully", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-empty"));
      const afterHook = mock.hooks.find((h) => h.event === "tool_call:after");

      await expect(afterHook!.handler({})).resolves.toBeUndefined();
    });
  });

  // ── command:new ───────────────────────────────────────

  describe("command:new", () => {
    it("runs without throwing", async () => {
      const mock = await createTestPlugin(join(tempDir, "new-run"));
      const newHook = mock.hooks.find((h) => h.event === "command:new");
      expect(newHook).toBeDefined();

      await expect(newHook!.handler()).resolves.toBeUndefined();
    });
  });

  // ── before_prompt_build ───────────────────────────────

  describe("before_prompt_build", () => {
    it("returns appendSystemContext with routing instructions", async () => {
      const mock = await createTestPlugin(join(tempDir, "prompt-build"));
      const promptHook = mock.lifecycle.find(
        (l) => l.event === "before_prompt_build",
      );
      expect(promptHook).toBeDefined();

      const result = promptHook!.handler() as { appendSystemContext: string };
      expect(result).toHaveProperty("appendSystemContext");
      expect(result.appendSystemContext).toContain("context-mode");
    });

    it("has priority 5", async () => {
      const mock = await createTestPlugin(join(tempDir, "prompt-priority"));
      const promptHook = mock.lifecycle.find(
        (l) => l.event === "before_prompt_build",
      );
      expect(promptHook?.opts?.priority).toBe(5);
    });
  });

  // ── Context engine ────────────────────────────────────

  describe("context engine", () => {
    it("creates engine with ownsCompaction: true", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-info"));
      const engine = mock.contextEngines[0].factory();
      expect(engine.info.id).toBe("context-mode");
      expect(engine.info.name).toBe("Context Mode");
      expect(engine.info.ownsCompaction).toBe(true);
    });

    it("ingest returns { ingested: true }", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-ingest"));
      const engine = mock.contextEngines[0].factory();
      const result = await engine.ingest({});
      expect(result).toEqual({ ingested: true });
    });

    it("assemble passes through messages", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-assemble"));
      const engine = mock.contextEngines[0].factory();
      const messages = [{ role: "user", content: "hello" }];
      const result = await engine.assemble({ messages });
      expect(result.messages).toBe(messages);
      expect(result.estimatedTokens).toBe(0);
    });

    it("compact returns { ok: true, compacted: false } when no events", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-compact-empty"));
      const engine = mock.contextEngines[0].factory();
      const result = await engine.compact();
      expect(result).toEqual({ ok: true, compacted: false });
    });
  });

  // ── Integration: before + after + compact ─────────────

  describe("end-to-end flow", () => {
    it("captures events and generates compaction snapshot", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-flow"));
      const beforeHook = mock.hooks.find((h) => h.event === "tool_call:before");
      const afterHook = mock.hooks.find((h) => h.event === "tool_call:after");
      const engine = mock.contextEngines[0].factory();

      // Normal tool call passes through before hook
      await beforeHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
      });

      // After hook captures the event
      await afterHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
        output: "console.log('hello')",
      });

      // Edit event
      await afterHook!.handler({
        toolName: "Edit",
        params: { file_path: "/app/main.ts", old_string: "{}", new_string: "{ foo: 1 }" },
      });

      // Git event
      await afterHook!.handler({
        toolName: "Bash",
        params: { command: "git status" },
        output: "On branch main",
      });

      // Compacting generates snapshot
      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
    });

    it("blocked tool command is replaced before execution", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-block"));
      const beforeHook = mock.hooks.find((h) => h.event === "tool_call:before");

      const params = { command: "curl https://evil.com" };
      const event = { toolName: "Bash", params };

      // Before hook replaces the command
      await beforeHook!.handler(event);
      expect(params.command).toContain("context-mode");
    });
  });
});
