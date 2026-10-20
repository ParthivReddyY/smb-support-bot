# AI support assistant for small businesses (RAG on Cloudflare)

A live support assistant for a **fictional** dental practice. It answers patient questions only from the practice's own help pages, cites every answer, and hands off to a human when it isn't sure.

**Live demo:** https://smb-support-bot.smb-support-bot.workers.dev

<!-- Add demo.gif here: record a 20-second capture of the "Delta Dental", "crown price" and "bring my dog" questions. -->

## What it shows

- **Retrieval-augmented answers.** Questions are embedded with `bge-base-en-v1.5` and matched against 56 help-page sections in a Vectorize index. Only matched passages reach the model.
- **Citations.** Llama 3.3 70B (Workers AI) answers with numbered references, and the UI shows which page each one came from.
- **Confidence-gated handoff.** If no passage scores above `MIN_SCORE`, the model is never called and the visitor is offered the front desk. No guessing.
- **Safety notice.** Urgent phrases (breathing, spreading swelling, uncontrolled bleeding) trigger an emergency notice before any answer.
- **Streaming.** Answers stream token by token over server-sent events.
- **Garbage-output guard.** The first 40 characters of each answer are held back and checked. If the model returns symbol soup (the fp8 model occasionally streams "!!!!…"), the Worker retries once without streaming, and hands off to the front desk if that fails too.
- **Layered usage limits.** A per-visitor burst limit, a per-visitor daily cap and a shared daily AI budget keep the public demo inside the free tier. The UI shows how many questions you have left.

## Limits of this public demo (tested)

| Layer | Limit | What the visitor sees |
|---|---|---|
| Burst, per visitor | 8 questions a minute (Workers Rate Limiting) | "You're sending messages quickly…" |
| Daily, per visitor | 25 questions a day (Durable Object counter) | "You've reached today's limit… resets at 00:00 UTC" |
| Daily AI budget, shared | 6,000 neurons a day (~90 answers) | "This free demo has used today's shared AI budget…" |
| Scope | Answers only from 11 help pages of a fictional practice | Anything else is handed off to the front desk |

A handed-off question refunds most of its budget, since the model is never called. All three limits were verified by temporarily deploying with tiny limits and pushing past them.

The shared `src/usage-limiter.ts` is one SQLite-backed Durable Object that keeps exact daily counters. Visitor IPs are stored only as one-way hashes (SHA-256 of the IP plus the date), and rows are deleted once their UTC day has passed. The three demo Workers split Cloudflare's 10,000 free neurons a day: support bot 6,000, n8n proxy 2,500, MCP server 300, leaving headroom.

## Architecture

```
browser ──POST /api/chat──▶ Worker
                              ├─ burst limit (CHAT_LIMITER) + daily limits (UsageLimiter DO)
                              ├─ embed question  (Workers AI: bge-base-en-v1.5)
                              ├─ top-4 search     (Vectorize, cosine, 768 dims)
                              ├─ score < MIN_SCORE? ──▶ handoff event, stop
                              └─ answer from passages (Workers AI: Llama 3.3 70B, streamed)
                                       └─▶ SSE: notice · sources · token… · done
```

| Path | Purpose |
|---|---|
| `kb/*.md` | The knowledge base. Each `## ` section is one chunk |
| `scripts/build-kb.mjs` | Compiles `kb/` into `src/kb.generated.ts` |
| `src/index.ts` | Worker: `/api/chat`, `/api/ingest` (token-protected), `/api/health`, `/api/usage` (today's aggregate usage) |
| `src/usage-limiter.ts` | Durable Object with the daily per-visitor and budget counters |
| `public/` | Static chat UI (no framework) |

## Run it yourself

Requires a Cloudflare account (the free plan is enough).

```bash
npm install
npx wrangler login
npx wrangler vectorize create smb-support-kb --dimensions=768 --metric=cosine
npx wrangler secret put INGEST_TOKEN        # any long random string
npm run deploy
curl -X POST https://<your-worker>.workers.dev/api/ingest -H "authorization: Bearer <INGEST_TOKEN>"
```

The author's deployed token is kept in the macOS Keychain (service `smb-support-bot-ingest-token`). Re-index without printing it:

```bash
curl -X POST https://smb-support-bot.smb-support-bot.workers.dev/api/ingest \
  -H "authorization: Bearer $(security find-generic-password -s smb-support-bot-ingest-token -w)"
```

Local development: put `INGEST_TOKEN=...` in `.dev.vars`, then `npm run dev`. Workers AI and Vectorize always run against your Cloudflare account, even in dev.

## Adapting it for a real business

1. Replace the files in `kb/` with the business's FAQs, policies and price list, one topic per `## ` section.
2. Change the business name and rules in `SYSTEM` (`src/index.ts`) and in `public/index.html`.
3. `npm run deploy`, then call `/api/ingest` again.
4. Tune `MIN_SCORE` using real questions: raise it if the bot answers off-topic questions, lower it if it hands off too often.

Swap `CHAT_MODEL` for Claude or GPT through AI Gateway if a client wants a frontier model.

## Cost

On the Workers free plan, Workers AI includes 10,000 neurons a day. A typical answer uses about 65, and this demo's budget is capped at 6,000, so roughly 90 answers a day. Durable Objects and Vectorize usage here stay well within their free tiers.


## More demos

Part of a three-demo set built on the same fictional dental practice:

- **[MCP server](https://business-mcp-server.smb-support-bot.workers.dev)**: the practice's data as tools inside Claude or Codex ([source](https://github.com/ParthivReddyY/business-mcp-server)).
- **[n8n lead triage](https://github.com/ParthivReddyY/n8n-lead-triage)**: website enquiries scored, routed and given a drafted reply in about 4 seconds.

---

Juniper Lane Dental, its staff, prices and contact details are fictional. Built by [Parthiv Reddy](https://github.com/ParthivReddyY).
