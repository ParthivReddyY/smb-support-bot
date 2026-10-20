import { KB } from "./kb.generated";
import { limiter, limitMessage, visitorKey } from "./usage-limiter";

export { UsageLimiter } from "./usage-limiter";

type Turn = { role: "user" | "assistant"; content: string };
type Source = { n: number; id: string; page: string; section: string; score: number };

const MAX_MESSAGE = 500;
const MAX_HISTORY = 6;
const TOP_K = 4;

// Phrases that need a pointer to urgent care before any answer, whatever the knowledge base says.
const URGENT =
  /\b(can'?t|cannot|trouble|hard to|difficulty) (breathe|breathing|swallow|swallowing)|\b(swell\w*|swollen)\b.*\b(eye|neck|spread\w*|throat)|spread\w* swelling|high fever|(won'?t|doesn'?t|can'?t) stop bleeding|jaw (is )?(broken|fractured?)|\baccident\b/i;

const SYSTEM = `You are the virtual front-desk assistant for Juniper Lane Dental, a fictional family dental practice used as a demo.

Rules:
- Answer ONLY from the numbered context passages. Cite the passages you used like [1] or [2].
- If the context does not contain the answer, say you don't have that information and offer to pass the question to the front desk team. Never invent prices, times, policies or plan names.
- You are not a dentist. Do not diagnose, and do not recommend medicines or doses. For pain, swelling or injury, explain how to get an emergency appointment.
- Be warm and brief: 2 to 5 sentences, or a short list when listing items. Use plain language.`;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/chat" && request.method === "POST") return await chat(request, env, ctx);
      if (url.pathname === "/api/ingest" && request.method === "POST") return await ingest(request, env);
      if (url.pathname === "/api/health") return Response.json({ ok: true, chunks: KB.length });
      if (url.pathname === "/api/usage") return Response.json(await limiter(env).stats(), { headers: { "cache-control": "no-store" } });
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(JSON.stringify({ event: "unhandled", path: url.pathname, error: String(err) }));
      return Response.json({ error: "Something went wrong. Try again in a moment." }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function chat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const { success } = await env.CHAT_LIMITER.limit({ key: ip });
  if (!success) {
    return Response.json({ error: "You're sending messages quickly. Wait a minute and try again." }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as { messages?: Turn[] } | null;
  const history = (body?.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }));
  const question = history.at(-1);
  if (!question || question.role !== "user" || !question.content.trim()) {
    return Response.json({ error: "Send a question to get an answer." }, { status: 400 });
  }

  // Daily limits: per visitor, plus a shared AI budget that keeps the demo inside the free tier.
  const estimate = Number(env.NEURONS_PER_CHAT);
  const usage = limiter(env);
  const verdict = await usage.consume(await visitorKey(ip), estimate, {
    perVisitor: Number(env.DAILY_CHATS_PER_VISITOR),
    dailyBudget: Number(env.DAILY_NEURON_BUDGET),
  });
  if (!verdict.allowed) {
    console.log(JSON.stringify({ event: "daily_limit", reason: verdict.reason }));
    return Response.json({ error: limitMessage(verdict), reason: verdict.reason, resetsAt: verdict.resetsAt }, { status: 429 });
  }

  // Retrieval: include the previous user turn so follow-ups like "and on Saturdays?" keep their topic.
  const previousUser = history.slice(0, -1).findLast((m) => m.role === "user")?.content ?? "";
  const query = `${previousUser}\n${question.content}`.trim();
  // bge models are trained with this instruction prefix on queries (not on passages).
  const embedding = await env.AI.run(env.EMBED_MODEL as "@cf/baai/bge-base-en-v1.5", {
    text: [`Represent this sentence for searching relevant passages: ${query}`],
  });
  const vector = (embedding as { data: number[][] }).data[0];
  const result = await env.VECTORIZE.query(vector, { topK: TOP_K, returnMetadata: "all" });

  // Gate on the best match; once it clears the bar, keep nearby passages as supporting context.
  const minScore = Number(env.MIN_SCORE);
  const confident = (result.matches[0]?.score ?? 0) >= minScore;
  const matches = confident ? result.matches.filter((m) => m.score >= minScore - Number(env.SUPPORT_MARGIN)) : [];
  const sources: Source[] = matches.map((m, i) => ({
    n: i + 1,
    id: m.id,
    page: String(m.metadata?.page ?? ""),
    section: String(m.metadata?.section ?? ""),
    score: Math.round(m.score * 1000) / 1000,
  }));

  console.log(JSON.stringify({ event: "retrieval", top: result.matches[0]?.score ?? 0, kept: matches.length }));

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const send = (data: unknown) => writer.write(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));

  const respond = async () => {
    try {
      if (URGENT.test(question.content)) {
        await send({
          type: "notice",
          text: "If you have swelling that affects breathing or swallowing, a high fever, or bleeding you can't control, call 911 or go to the nearest emergency department now.",
        });
      }

      // Nothing relevant enough in the knowledge base: hand off rather than let the model guess.
      if (matches.length === 0) {
        // No model call on a handoff, so give back most of the estimate (the embedding still ran).
        await usage.correct(1 - estimate);
        await send({
          type: "handoff",
          topScore: Math.round((result.matches[0]?.score ?? 0) * 1000) / 1000,
          text: "I don't have that information. I can pass your question to our front desk team, who reply within one working day, or you can call us on (555) 014-2290.",
        });
        return;
      }

      await send({ type: "sources", sources });

      const context = matches
        .map((m, i) => `[${i + 1}] ${m.metadata?.page} — ${m.metadata?.section}\n${m.metadata?.text}`)
        .join("\n\n");
      const messages = [
        { role: "system", content: `${SYSTEM}\n\nContext:\n${context}` },
        ...history,
      ];

      const stream = (await env.AI.run(env.CHAT_MODEL as "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages,
        stream: true,
        max_tokens: 400,
        temperature: 0.2,
      })) as ReadableStream<Uint8Array>;

      // The fp8 model occasionally streams garbage ("!!!!…"). Hold back the start of the answer,
      // and if it is degenerate, retry once without streaming before falling back to a handoff.
      // Local testing only (wrangler dev --var DEBUG_DEGENERATE:1): "1" breaks the stream, "2" the retry too.
      const debug = (env as { DEBUG_DEGENERATE?: string }).DEBUG_DEGENERATE;
      const streamed = await pipeGuarded(stream, (text) => send({ type: "token", text }), debug === "1" || debug === "2");
      if (streamed) return;

      console.warn(JSON.stringify({ event: "degenerate_output", retry: true }));
      await usage.correct(estimate); // the retry is a second model call
      const retry = (await env.AI.run(env.CHAT_MODEL as "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages,
        max_tokens: 400,
        temperature: 0.2,
      })) as { response?: unknown };
      const answer = retry.response == null ? "" : String(retry.response);
      if (debug !== "2" && answer.trim() && !isDegenerate(answer)) {
        await send({ type: "token", text: answer });
        return;
      }

      console.warn(JSON.stringify({ event: "degenerate_output", retry: false }));
      await send({
        type: "handoff",
        topScore: sources[0]?.score ?? 0,
        text: "Sorry, I couldn't put that answer together just now. I can pass your question to our front desk team, who reply within one working day, or you can call us on (555) 014-2290.",
      });
    } catch (err) {
      console.error(JSON.stringify({ event: "chat_error", error: String(err) }));
      await send({
        type: "error",
        text: "The assistant is unavailable right now, usually because today's free AI allowance is used up. Try again tomorrow or call (555) 014-2290.",
      });
    } finally {
      await send({ type: "done" });
      await writer.close();
    }
  };

  // Generate in the background while the response streams to the client.
  ctx.waitUntil(respond());
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-demo-remaining-today": String(verdict.visitorRemaining),
    },
  });
}

// How much of the answer to hold back and check before streaming it to the visitor.
const GUARD_CHARS = 40;

// Garbage output looks like "!!!!!!" or punctuation soup: mostly symbols, or one symbol repeated.
// Digits count as real text so price lists like "$95 / $180 / $1,100" pass.
function isDegenerate(text: string) {
  const compact = text.replace(/\s+/g, "");
  if (!compact) return false;
  const wordChars = (compact.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return wordChars / compact.length < 0.3 || /([^\p{L}\p{N}])\1{7,}/u.test(compact);
}

// Stream tokens to the visitor, but only after the first GUARD_CHARS characters pass the check.
// Returns false (having sent nothing) when the start of the answer is degenerate.
async function pipeGuarded(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => Promise<void>,
  forceDegenerate = false,
) {
  let head = "";
  let released = false;
  const ok = await pipeTokens(stream, async (text) => {
    if (released) return onText(text);
    head += forceDegenerate ? "!".repeat(text.length) : text;
    if (head.length < GUARD_CHARS) return;
    if (isDegenerate(head)) return false;
    released = true;
    await onText(head);
  });
  if (!ok) return false;
  if (released) return true;
  // Short answer: the whole stream fit inside the guard window.
  if (!head.trim() || isDegenerate(head)) return false;
  await onText(head);
  return true;
}

// Workers AI streams server-sent events. Pull out the text from each event.
// onText can return false to stop reading; pipeTokens then returns false.
async function pipeTokens(stream: ReadableStream<Uint8Array>, onText: (text: string) => Promise<void | boolean>) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let text = "";
      try {
        const event = JSON.parse(payload) as { response?: unknown; choices?: { delta?: { content?: unknown } }[] };
        // Tokens can arrive as numbers (e.g. a citation "1"), so always send a string.
        const raw = event.response ?? event.choices?.[0]?.delta?.content;
        text = raw == null ? "" : String(raw);
      } catch {
        // Ignore partial or non-JSON keep-alive lines.
        continue;
      }
      if (text && (await onText(text)) === false) {
        await reader.cancel();
        return false;
      }
    }
  }
  return true;
}

async function ingest(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!env.INGEST_TOKEN || !(await safeEqual(token, env.INGEST_TOKEN))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let upserted = 0;
  for (let i = 0; i < KB.length; i += 50) {
    const batch = KB.slice(i, i + 50);
    const embedded = (await env.AI.run(env.EMBED_MODEL as "@cf/baai/bge-base-en-v1.5", {
      text: batch.map((c) => `${c.page} — ${c.section}\n${c.text}`),
    })) as { data: number[][] };
    await env.VECTORIZE.upsert(
      batch.map((c, j) => ({
        id: c.id,
        values: embedded.data[j],
        metadata: { page: c.page, section: c.section, text: c.text },
      })),
    );
    upserted += batch.length;
  }
  console.log(JSON.stringify({ event: "ingest", upserted }));
  return Response.json({ upserted });
}

// Compare secrets without leaking timing information.
async function safeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
