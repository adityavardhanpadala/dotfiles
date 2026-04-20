---
name: parallel-web
description: "DEFAULT for all web work. Use for current-info research, discovery, direct URL fetching, articles, docs, PDFs, and JavaScript-heavy sites. Automatically choose search for topics/questions and extract for known URLs."
user-invocable: true
argument-hint: <query | url [url2] [url3]>
context: fork
agent: parallel:parallel-subagent
compatibility: Requires parallel-cli and internet access.
allowed-tools: Bash(parallel-cli:*)
metadata:
  author: parallel
---

# Web Search + URL Extraction

Use this as the single web skill.

## Mode selection

Choose **search** when:
- the user asks a question or topic without giving URLs
- you need current info, discovery, comparisons, or recent coverage
- you want authoritative sources before reading specific pages

Choose **extract** when:
- the user provides one or more direct URLs
- they want page contents, quotes, docs, article text, or PDF text
- you need the exact structure/content of known pages

For tasks that need both:
1. Run **search** to find the best sources.
2. Run **extract** on the top 1–3 URLs when you need more detail.
3. Answer using the search/extract results.

Treat the input as **URL mode** only when the arguments are one or more direct URLs. If extracting multiple URLs, pass each URL as a separate positional argument, not as one quoted string containing spaces.

## Commands

Choose a short, descriptive filename based on the topic. Use lowercase with hyphens, no spaces.

### Search mode

```bash
parallel-cli search "$ARGUMENTS" -q "<keyword1>" -q "<keyword2>" --json --max-results 10 --excerpt-max-chars-total 27000 -o "/tmp/$FILENAME.search.json"
```

Options if needed:
- `--after-date YYYY-MM-DD` for time-sensitive queries
- `--include-domains domain1.com,domain2.com` to limit to official/high-signal sources and reduce noisy ranking

Notes:
- The first argument is the objective: a natural-language description of what you want.
- Add `-q` flags only to supplement the objective with precise keywords.
- Do **not** set `max_output_tokens` on command execution; the JSON is already bounded.

### Extract mode

Single URL:

```bash
parallel-cli extract "$ARGUMENTS" --json -o "/tmp/$FILENAME.extract.md"
```

Multiple URLs:

```bash
parallel-cli extract "$URL1" "$URL2" "$URL3" --json -o "/tmp/$FILENAME.extract.md"
```

Options if needed:
- `--objective "focus area"` to focus on the most relevant sections

Notes:
- Prefer extract for webpages, articles, docs, PDFs, and JavaScript-heavy sites.
- PDF extraction generally works, but some hosts may fail with fetch/cache errors (for example HTTP 304). If that happens, report the failure and, if useful, try an alternate document URL or search for another accessible copy.

## Parsing results

### Search mode

Parse the JSON from stdout. For each result, extract:
- title
- url
- publish_date
- useful content from excerpts

Skip obvious navigation noise like menus, footers, and “Skip to content”.

When answering from search results or from a combined search+extract workflow:
- **Every claim must have an inline citation.**
- Use markdown links like `[Title](URL)`.
- Never invent or guess URLs.
- Prefer official/primary sources when available.

### Extract mode

Return content as:

**[Page Title](URL)**

Then the extracted content verbatim, with these rules:
- Keep content verbatim — do not paraphrase or summarize
- Parse lists exhaustively — extract every numbered/bulleted item
- Strip only obvious noise: nav menus, footers, ads
- Preserve all facts, names, numbers, dates, quotes
- If extracting multiple URLs, repeat the title/content block for each URL

## Response format

### Search mode

Synthesize a response that:
- leads with the key answer/finding
- includes specific facts, names, numbers, dates
- cites every fact inline as `[Source Title](URL)`
- organizes by theme if multiple topics

End with a mandatory `Sources:` section listing every referenced URL:

```text
Sources:
- [Source Title](https://example.com/article) (Feb 2026)
- [Another Source](https://example.com/other) (Jan 2026)
```

After the `Sources:` section, mention the output file path (`/tmp/$FILENAME.search.json`).

### Extract mode

Return the extracted content block(s) exactly as described above, then mention the output file path (`/tmp/$FILENAME.extract.md`).
