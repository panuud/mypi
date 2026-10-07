---
name: tavily-search
description: Web search and web page content extraction via the Tavily API. Use when the user asks to search the web, look up current information, find documentation, check recent news, or read/extract the content of a specific URL or set of URLs.
---

# Tavily Search & Extract

Search the web and extract page content using the Tavily REST API. No dependencies; requires Node 18+ and the `TAVILY_API_KEY` environment variable.

## Setup

The API key is read from `TAVILY_API_KEY`. If it is not set, ask the user for their key and instruct them to set it:

```bash
# Windows (PowerShell):         setx TAVILY_API_KEY "tvly-..."  (then restart terminal)
# Windows (cmd, current session): set TAVILY_API_KEY=tvly-...
# Linux/macOS:                  export TAVILY_API_KEY=tvly-...
```

Users can get a key at https://app.tavily.com (free tier included).

## Search

```bash
node "<skill-dir>/scripts/tavily.js" search "query" [options]
```

Options:
- `--depth basic|advanced|fast|ultra-fast` — search depth (default `basic`). `advanced` gives higher relevance but costs 2 credits vs 1.
- `--topic general|news|finance` — use `news` for recent events/current affairs.
- `--max N` — max results, 1–20 (default 10).
- `--time day|week|month|year` — restrict to recent content.
- `--answer` — also return an LLM-generated answer.
- `--raw` — include cleaned full page content of results.
- `--country X` — boost results from a country (e.g. `united states`, `germany`).
- `--language en` — boost results in a language.
- `--include-domains a.com,b.com` / `--exclude-domains a.com` — domain filtering.
- `--json` — output full raw JSON response.

Examples:

```bash
node "<skill-dir>/scripts/tavily.js" search "pi coding agent documentation"
node "<skill-dir>/scripts/tavily.js" search "latest AI news" --topic news --time week --max 5
node "<skill-dir>/scripts/tavily.js" search "rust async runtime comparison" --depth advanced
```

## Extract page content

```bash
node "<skill-dir>/scripts/tavily.js" extract "https://example.com/page" [more-urls...] [options]
```

Options:
- `--depth basic|advanced` — `advanced` retrieves tables/embedded content, 2 credits per 5 URLs.
- `--query "intent"` — rerank extracted chunks by relevance to this query.
- `--format markdown|text` — output format (default markdown).
- `--json` — output full raw JSON response.

Example:

```bash
node "<skill-dir>/scripts/tavily.js" extract "https://docs.tavily.com/llms.txt"
```

## Workflow guidance

- Use `search` first to find relevant sources; use `extract` on the most promising URLs when you need full page content.
- Default to `basic` depth and `--max 5` to conserve API credits; escalate to `advanced` when precision matters.
- For questions about recent events, add `--topic news --time week`.
- Summarize results for the user and cite URLs; don't dump raw output unless asked.
