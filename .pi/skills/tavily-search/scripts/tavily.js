#!/usr/bin/env node
/**
 * Tavily Search & Extract CLI (zero dependencies, Node 18+)
 *
 * Usage:
 *   node tavily.js search "query" [options]
 *   node tavily.js extract "url" [more-urls...] [options]
 *
 * Requires TAVILY_API_KEY environment variable.
 */

const API = "https://api.tavily.com";

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(args, flagsWithValues) {
  const opts = { _: [] };
  const withValue = new Set(flagsWithValues);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (withValue.has(name)) {
        const value = args[++i];
        if (value === undefined) fail(`Flag --${name} requires a value`);
        opts[name] = value;
      } else {
        opts[name] = true;
      }
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function printResult(r, i) {
  const date = r.published_date ? `  (${r.published_date})` : "";
  console.log(`\n[${i}] ${r.title}${date}`);
  console.log(`    ${r.url}`);
  if (r.content) console.log(`    ${r.content.replace(/\s+/g, " ").slice(0, 400)}`);
}

async function main() {
  const apiKey = process.env.TAVILY_API_KEY;
  const [command, ...rest] = process.argv.slice(2);

  if (command !== "search" && command !== "extract") {
    fail('Usage: tavily.js search "query" [options] | tavily.js extract "url" [more-urls...] [options]');
  }
  if (!apiKey) fail("TAVILY_API_KEY environment variable is not set. Get a key at https://app.tavily.com");

  if (command === "search") {
    const opts = parseArgs(rest, ["depth", "topic", "max", "time", "country", "language", "include-domains", "exclude-domains", "chunks"]);
    const query = opts._.join(" ");
    if (!query) fail('Usage: tavily.js search "query" [--depth basic|advanced|fast|ultra-fast] [--topic general|news|finance] [--max N] [--time day|week|month|year] [--answer] [--raw] [--json] [--include-domains a,b] [--exclude-domains a,b] [--country X] [--language en]');

    const body = {
      query,
      search_depth: opts.depth || "basic",
      max_results: opts.max ? parseInt(opts.max, 10) : 10,
    };
    if (opts.topic) body.topic = opts.topic;
    if (opts.time) body.time_range = opts.time;
    if (opts.country) body.country = opts.country;
    if (opts.language) body.language = opts.language;
    if (opts.chunks) body.chunks_per_source = parseInt(opts.chunks, 10);
    if (opts["include-domains"]) body.include_domains = opts["include-domains"].split(",").map((s) => s.trim());
    if (opts["exclude-domains"]) body.exclude_domains = opts["exclude-domains"].split(",").map((s) => s.trim());
    if (opts.answer) body.include_answer = true;
    if (opts.raw) body.include_raw_content = "markdown";

    const res = await fetch(`${API}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      fail(`API ${res.status}: ${JSON.stringify(err.detail || err)}`);
    }
    const data = await res.json();

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (data.answer) console.log(`Answer: ${data.answer}\n`);
    (data.results || []).forEach((r, i) => printResult(r, i + 1));
    if (opts.raw) {
      console.log("\n--- Raw page content ---");
      (data.results || []).forEach((r) => {
        if (r.raw_content) console.log(`\n## ${r.url}\n${r.raw_content.slice(0, 3000)}`);
      });
    }
    return;
  }

  if (command === "extract") {
    const opts = parseArgs(rest, ["depth", "query", "format", "timeout"]);
    const urls = opts._;
    if (urls.length === 0) fail('Usage: tavily.js extract "url1" ["url2" ...] [--depth basic|advanced] [--query rerank-query] [--format markdown|text] [--json]');

    const body = { urls, format: opts.format || "markdown" };
    if (opts.depth) body.extract_depth = opts.depth;
    if (opts.query) {
      body.query = opts.query;
      if (opts.chunks) body.chunks_per_source = parseInt(opts.chunks, 10);
    }
    if (opts.timeout) body.timeout = parseFloat(opts.timeout);

    const res = await fetch(`${API}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      fail(`API ${res.status}: ${JSON.stringify(err.detail || err)}`);
    }
    const data = await res.json();

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    (data.results || []).forEach((r) => {
      console.log(`\n## ${r.url}\n`);
      console.log(r.raw_content || "(empty)");
    });
    (data.failed_results || []).forEach((f) => console.error(`\nFAILED: ${f.url} — ${f.error}`));
    return;
  }

  fail(`Unknown command "${command}". Usage: tavily.js search "query" [...] | tavily.js extract "url" [...]`);
}

main().catch((e) => fail(e.message));