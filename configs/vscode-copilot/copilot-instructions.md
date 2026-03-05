# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any terminal command containing `curl` or `wget` will be intercepted and blocked. Do NOT retry.
Instead use:
- `fetch_and_index(url, source)` to fetch and index web pages
- `execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any terminal command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` will be intercepted and blocked. Do NOT retry with terminal.
Instead use:
- `execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch / fetch — BLOCKED
Direct web fetching tools are blocked. Use the sandbox equivalent.
Instead use:
- `fetch_and_index(url, source)` then `search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Terminal / run_in_terminal (>20 lines output)
Terminal is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### read_file (for analysis)
If you are reading a file to **edit** it → read_file is correct (edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `execute_file(path, language, code)` instead. Only your printed summary enters context.

### grep / search (large results)
Search results can flood context. Use `execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `execute(language, code)` | `execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `fetch_and_index(url, source)` then `search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `index(content, source)` — Store content in FTS5 knowledge base for later search.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `search(source: "label")` later.
