// Ask the deployed bot questions and print the answer, sources and handoffs.
// Usage: node scripts/ask.mjs "question one" "question two"
const URL = process.env.BOT_URL ?? "https://smb-support-bot.smb-support-bot.workers.dev";
for (const q of process.argv.slice(2)) {
  const res = await fetch(`${URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
  });
  const raw = res.ok ? await res.text() : `HTTP ${res.status} ${await res.text()}`;
  let answer = "", out = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const e = JSON.parse(line.slice(6));
    if (e.type === "token") answer += e.text;
    else if (e.type === "sources") out.push(`sources: ${e.sources.map((s) => `${s.n}=${s.section} (${s.score})`).join(", ")}`);
    else if (e.type !== "done") out.push(`${e.type.toUpperCase()}${e.topScore !== undefined ? ` (top ${e.topScore})` : ""}: ${e.text}`);
  }
  console.log(`\nQ: ${q}\n${out.join("\n")}${answer ? `\nA: ${answer.trim()}` : ""}${res.ok ? "" : raw}`);
}
