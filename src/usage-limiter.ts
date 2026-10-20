import { DurableObject } from "cloudflare:workers";

// Daily usage limits for a public AI demo, backed by one SQLite Durable Object.
// Two checks per call: a per-visitor daily cap and a shared daily AI budget (in Workers AI neurons),
// so the demo can never exceed Cloudflare's free allowance. Visitor keys are one-way hashes and
// rows are deleted once their UTC day has passed.

export type Limits = { perVisitor: number; dailyBudget: number };
export type Verdict = {
  allowed: boolean;
  reason?: "visitor_daily_limit" | "daily_budget";
  visitorRemaining: number;
  resetsAt: string;
};

type Row = { calls: number; neurons: number };

export class UsageLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS usage (
         day TEXT NOT NULL, key TEXT NOT NULL,
         calls INTEGER NOT NULL DEFAULT 0, neurons REAL NOT NULL DEFAULT 0,
         PRIMARY KEY (day, key))`,
    );
  }

  consume(visitor: string, estimate: number, limits: Limits): Verdict {
    const sql = this.ctx.storage.sql;
    const day = today();
    sql.exec("DELETE FROM usage WHERE day < ?", day);

    const read = (key: string): Row =>
      (sql.exec<Row>("SELECT calls, neurons FROM usage WHERE day = ? AND key = ?", day, key).toArray()[0] ?? { calls: 0, neurons: 0 });
    const own = read(`v:${visitor}`);
    const all = read("global");
    const resetsAt = `${nextDay(day)}T00:00:00Z`;

    if (own.calls >= limits.perVisitor) return { allowed: false, reason: "visitor_daily_limit", visitorRemaining: 0, resetsAt };
    if (all.neurons + estimate > limits.dailyBudget) {
      return { allowed: false, reason: "daily_budget", visitorRemaining: limits.perVisitor - own.calls, resetsAt };
    }

    for (const key of [`v:${visitor}`, "global"]) {
      sql.exec(
        `INSERT INTO usage (day, key, calls, neurons) VALUES (?, ?, 1, ?)
         ON CONFLICT (day, key) DO UPDATE SET calls = calls + 1, neurons = neurons + excluded.neurons`,
        day, key, estimate,
      );
    }
    return { allowed: true, visitorRemaining: limits.perVisitor - own.calls - 1, resetsAt };
  }

  // Replace an estimate with the real cost once the model reports it.
  correct(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.ctx.storage.sql.exec("UPDATE usage SET neurons = MAX(0, neurons + ?) WHERE day = ? AND key = 'global'", delta, today());
  }

  stats(): { day: string; calls: number; neurons: number; visitors: number } {
    const sql = this.ctx.storage.sql;
    const day = today();
    const g = sql.exec<Row>("SELECT calls, neurons FROM usage WHERE day = ? AND key = 'global'", day).toArray()[0] ?? { calls: 0, neurons: 0 };
    const visitors = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM usage WHERE day = ? AND key LIKE 'v:%'", day).one().n;
    return { day, calls: g.calls, neurons: Math.round(g.neurons), visitors };
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// Hash the visitor key so raw IP addresses are never stored.
export async function visitorKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${today()}:${ip}`));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function limiter(env: { USAGE: DurableObjectNamespace<UsageLimiter> }) {
  return env.USAGE.get(env.USAGE.idFromName("global"));
}

export function limitMessage(v: Verdict): string {
  const time = "00:00 UTC";
  return v.reason === "visitor_daily_limit"
    ? `You've reached today's limit for this free demo. It resets at ${time}.`
    : `This free demo has used today's shared AI budget. It resets at ${time}.`;
}
