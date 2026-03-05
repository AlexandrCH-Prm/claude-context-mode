#!/usr/bin/env node
/**
 * VS Code Copilot SessionStart hook for context-mode
 *
 * Session lifecycle management:
 * - "startup"  → Cleanup old sessions, capture instruction file rules
 * - "compact"  → Write events file, inject session knowledge directive
 * - "resume"   → Load previous session events, inject directive
 * - "clear"    → No action needed
 */

import { ROUTING_BLOCK } from "../routing-block.mjs";
import {
  readStdin, getSessionId, getSessionDBPath, getSessionEventsPath,
  getProjectDir, VSCODE_OPTS,
} from "../session-helpers.mjs";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const HOOK_DIR = new URL(".", import.meta.url).pathname;
const PKG_SESSION = join(HOOK_DIR, "..", "..", "build", "session");
const OPTS = VSCODE_OPTS;

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const source = input.source ?? "startup";

  // ── Helper: group events and extract metadata ──
  function groupEvents(events) {
    const grouped = {};
    let lastPrompt = "";
    for (const ev of events) {
      if (ev.category === "prompt") {
        lastPrompt = ev.data;
        continue;
      }
      if (!grouped[ev.category]) grouped[ev.category] = [];
      grouped[ev.category].push(ev);
    }
    const fileNames = new Set();
    for (const ev of (grouped.file || [])) {
      const path = ev.data.includes(" in ") ? ev.data.split(" in ").pop() : ev.data;
      const base = path?.split("/").pop()?.trim();
      if (base && !base.includes("*")) fileNames.add(base);
    }
    return { grouped, lastPrompt, fileNames };
  }

  // ── Write session events as markdown to disk for MCP server auto-indexing ──
  function writeSessionEventsFile(events, stats) {
    const eventsPath = getSessionEventsPath(OPTS);
    const { grouped, lastPrompt, fileNames } = groupEvents(events);

    const lines = [];
    lines.push("# Session Resume");
    lines.push("");
    lines.push(`Events: ${events.length} | Timestamp: ${new Date().toISOString()}`);
    lines.push("");

    if (fileNames.size > 0) {
      lines.push("## Active Files");
      lines.push("");
      for (const name of fileNames) lines.push(`- ${name}`);
      lines.push("");
    }

    if (grouped.rule?.length > 0) {
      lines.push("## Project Rules");
      lines.push("");
      for (const ev of grouped.rule) {
        if (ev.type === "rule_content") {
          const downgraded = ev.data.replace(/^(#{1,3}) /gm, (_, hashes) => "#".repeat(hashes.length + 3) + " ");
          lines.push(downgraded);
          lines.push("");
        } else {
          lines.push(`- ${ev.data}`);
        }
      }
      lines.push("");
    }

    if (grouped.task?.length > 0) {
      lines.push("## Tasks In Progress");
      lines.push("");
      for (const ev of grouped.task) lines.push(`- ${ev.data}`);
      lines.push("");
    }

    if (grouped.decision?.length > 0) {
      lines.push("## User Decisions");
      lines.push("");
      for (const ev of grouped.decision) lines.push(`- ${ev.data}`);
      lines.push("");
    }

    if (grouped.git?.length > 0) {
      lines.push("## Git Operations");
      lines.push("");
      for (const ev of grouped.git) lines.push(`- ${ev.data}`);
      lines.push("");
    }

    if (grouped.env?.length > 0 || grouped.cwd?.length > 0) {
      lines.push("## Environment");
      lines.push("");
      if (grouped.cwd?.length > 0) {
        lines.push(`- cwd: ${grouped.cwd[grouped.cwd.length - 1].data}`);
      }
      for (const ev of (grouped.env || [])) lines.push(`- ${ev.data}`);
      lines.push("");
    }

    if (grouped.error?.length > 0) {
      lines.push("## Errors Encountered");
      lines.push("");
      for (const ev of grouped.error) lines.push(`- ${ev.data}`);
      lines.push("");
    }

    if (grouped.mcp?.length > 0) {
      const toolCounts = {};
      for (const ev of grouped.mcp) {
        const tool = ev.data.split(":")[0].trim();
        toolCounts[tool] = (toolCounts[tool] || 0) + 1;
      }
      lines.push("## MCP Tool Usage");
      lines.push("");
      for (const [tool, count] of Object.entries(toolCounts)) {
        lines.push(`- ${tool}: ${count} calls`);
      }
      lines.push("");
    }

    if (grouped.subagent?.length > 0) {
      lines.push("## Subagent Tasks");
      lines.push("");
      for (const ev of grouped.subagent) lines.push(`- ${ev.data}`);
      lines.push("");
    }

    if (grouped.skill?.length > 0) {
      const uniqueSkills = new Set(grouped.skill.map(e => e.data));
      lines.push("## Active Skills");
      lines.push("");
      lines.push(`- ${[...uniqueSkills].join(", ")}`);
      lines.push("");
    }

    if (grouped.intent?.length > 0) {
      lines.push("## Session Intent");
      lines.push("");
      lines.push(`- ${grouped.intent[grouped.intent.length - 1].data}`);
      lines.push("");
    }

    if (grouped.role?.length > 0) {
      lines.push("## User Role");
      lines.push("");
      lines.push(`- ${grouped.role[grouped.role.length - 1].data}`);
      lines.push("");
    }

    if (grouped.data?.length > 0) {
      lines.push("## Data References");
      lines.push("");
      for (const ev of grouped.data) lines.push(`- ${ev.data}`);
      lines.push("");
    }

    if (lastPrompt) {
      lines.push("## Last User Prompt");
      lines.push("");
      lines.push(lastPrompt);
      lines.push("");
    }

    writeFileSync(eventsPath, lines.join("\n"), "utf-8");
    return { grouped, lastPrompt, fileNames };
  }

  // ── Build compact directive — summary table + search queries only ──
  function buildSessionDirective(source, eventMeta) {
    const { grouped, lastPrompt, fileNames } = eventMeta;
    const isCompact = source === "compact";

    let block = `\n<session_knowledge source="${isCompact ? "compact" : "continue"}" indexed="true">`;

    block += `\n  <status>Session events pre-indexed into context-mode (source: "session-events"). Raw data is searchable — do NOT call index().</status>`;

    const tableRows = [];
    if (fileNames.size > 0) {
      const preview = [...fileNames].slice(0, 5).join(", ");
      tableRows.push(`| Files tracked | ${fileNames.size} | ${preview}${fileNames.size > 5 ? ", ..." : ""} |`);
    }
    if (grouped.rule?.length > 0) {
      const rPaths = grouped.rule.filter(e => e.type !== "rule_content").map(e => e.data.split("/").pop());
      tableRows.push(`| Project rules | ${grouped.rule.length} | ${rPaths.join(", ") || "copilot-instructions.md"} |`);
    }
    if (grouped.decision?.length > 0) {
      const dPreview = grouped.decision.slice(0, 2).map(e => e.data.substring(0, 50)).join("; ");
      tableRows.push(`| Decisions | ${grouped.decision.length} | ${dPreview} |`);
    }
    if (grouped.task?.length > 0) {
      tableRows.push(`| Tasks | ${grouped.task.length} | In progress |`);
    }
    if (grouped.git?.length > 0) {
      const ops = [...new Set(grouped.git.map(e => e.data))].slice(0, 3).join(", ");
      tableRows.push(`| Git state | ${grouped.git.length} | ${ops} |`);
    }
    if (grouped.error?.length > 0) {
      tableRows.push(`| Errors | ${grouped.error.length} | Monitored |`);
    }
    if (lastPrompt) {
      const promptPreview = lastPrompt.length > 60 ? lastPrompt.substring(0, 57) + "..." : lastPrompt;
      tableRows.push(`| Last request | 1 | "${promptPreview}" |`);
    }

    const queries = [];
    if (fileNames.size > 0) queries.push("active files tracked");
    if (grouped.task?.length > 0) queries.push("tasks in progress");
    if (grouped.decision?.length > 0) queries.push("user decisions preferences");
    if (grouped.rule?.length > 0) queries.push("project rules instructions");
    if (grouped.git?.length > 0) queries.push("git operations branch commit");
    if (grouped.error?.length > 0) queries.push("errors encountered");
    if (!queries.length) queries.push("session resume overview");

    block += `\n  <required_tool_call priority="immediate">`;
    block += `\n    You MUST call this tool FIRST, before generating ANY text output:`;
    block += `\n    mcp__plugin_context-mode_context-mode__search(queries: ${JSON.stringify(queries)}, source: "session-events")`;
    block += `\n    This is a blocking requirement. Do not skip this step.`;
    block += `\n  </required_tool_call>`;

    if (tableRows.length > 0) {
      block += `\n  <required_output priority="first_message">`;
      block += `\n    After the search completes, your FIRST text output to the user MUST be exactly this table:`;
      block += `\n    \`\`\``;
      block += `\n    ---`;
      block += `\n    **context-mode** — session ${isCompact ? "restored" : "loaded"}`;
      block += `\n    `;
      block += `\n    | Preserved | Count | Details |`;
      block += `\n    |-----------|------:|---------|`;
      for (const row of tableRows) {
        block += `\n    ${row}`;
      }
      block += `\n    `;
      block += `\n    *${isCompact ? "Context compacted — session knowledge restored." : "Previous session loaded via --continue."}*`;
      block += `\n    ---`;
      block += `\n    \`\`\``;
      block += `\n    Do NOT skip this table. Do NOT paraphrase it. Copy it exactly as shown above.`;
      block += `\n  </required_output>`;
    }

    if (lastPrompt) {
      block += `\n  <last_user_prompt>${lastPrompt}</last_user_prompt>`;
      if (isCompact) {
        block += `\n  <continue_from>After displaying the table, continue working on the request above. Do NOT ask the user to repeat themselves.</continue_from>`;
      }
    }

    block += `\n</session_knowledge>`;
    return block;
  }

  if (source === "compact") {
    const { SessionDB } = await import(join(PKG_SESSION, "db.js"));
    const dbPath = getSessionDBPath(OPTS);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);
    const resume = db.getResume(sessionId);
    const stats = db.getSessionStats(sessionId);
    const events = db.getEvents(sessionId);

    if (resume && !resume.consumed) {
      db.markResumeConsumed(sessionId);
    }

    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, stats);
      additionalContext += buildSessionDirective("compact", eventMeta);
    }

    db.close();
  } else if (source === "resume") {
    const { SessionDB } = await import(join(PKG_SESSION, "db.js"));
    const dbPath = getSessionDBPath(OPTS);
    const db = new SessionDB({ dbPath });

    const recentSession = db.db.prepare(
      `SELECT m.session_id, m.event_count, m.compact_count
       FROM session_meta m
       WHERE m.event_count > 0
       ORDER BY m.started_at DESC LIMIT 1`
    ).get();

    if (recentSession) {
      const prevId = recentSession.session_id;
      const events = db.getEvents(prevId);

      if (events.length > 0) {
        const eventMeta = writeSessionEventsFile(events, db.getSessionStats(prevId));
        additionalContext += buildSessionDirective("resume", eventMeta);
      }
    }

    db.close();
  } else if (source === "startup") {
    const { SessionDB } = await import(join(PKG_SESSION, "db.js"));
    const dbPath = getSessionDBPath(OPTS);
    const db = new SessionDB({ dbPath });
    try { unlinkSync(getSessionEventsPath(OPTS)); } catch { /* no stale file */ }
    db.cleanupOldSessions(0);

    const sessionId = getSessionId(input, OPTS);
    const projectDir = getProjectDir(OPTS);
    const ruleFilePaths = [
      join(projectDir, ".github", "copilot-instructions.md"),
    ];
    for (const p of ruleFilePaths) {
      try {
        const content = readFileSync(p, "utf-8");
        if (content.trim()) {
          db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 });
          db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 });
        }
      } catch { /* file doesn't exist — skip */ }
    }

    db.close();
  }
  // "clear" — no action needed
} catch (err) {
  try {
    const { appendFileSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const { homedir: hd } = await import("node:os");
    appendFileSync(
      pjoin(hd(), ".vscode", "context-mode", "sessionstart-debug.log"),
      `[${new Date().toISOString()}] ${err?.message || err}\n${err?.stack || ""}\n`,
    );
  } catch { /* ignore logging failure */ }
}

const output = `SessionStart:compact hook success: Success\nSessionStart hook additional context: \n${additionalContext}`;
process.stdout.write(output);
