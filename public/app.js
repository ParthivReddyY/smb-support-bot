const log = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const send = document.getElementById("send");
const suggestions = document.getElementById("suggestions");

/** Conversation sent to the API (last few turns only). */
const history = [];
let busy = false;

const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Minimal formatting: paragraphs, "- " lists, **bold**, and [n] citation chips.
function render(text) {
  const blocks = escape(text).trim().split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-*•]\s+/, "")}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.join("<br>")}</p>`;
    })
    .join("")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, list) => list.split(/\s*,\s*/).map((n) => `<span class="cite">${n}</span>`).join(""));
}

function addMessage(role, html) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap.innerHTML = html;
  log.append(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}

function setBusy(value) {
  busy = value;
  send.disabled = value;
  input.disabled = value;
}

async function ask(question) {
  if (busy || !question.trim()) return;
  suggestions.hidden = true;
  setBusy(true);
  addMessage("user", `<div class="bubble">${escape(question)}</div>`);
  history.push({ role: "user", content: question });

  const reply = addMessage("bot", `<div class="bubble typing" aria-label="Assistant is typing"><i></i><i></i><i></i></div>`);
  let answer = "";
  let sources = [];

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history.slice(-6) }),
    });
    const left = res.headers.get("x-demo-remaining-today");
    if (left !== null) {
      document.getElementById("remaining").textContent = `${left} free question${left === "1" ? "" : "s"} left today.`;
    }
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      reply.innerHTML = `<div class="error">${escape(data.error ?? "The assistant is unavailable. Try again shortly.")}</div>`;
      history.pop();
      return;
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const raw of events) {
        if (!raw.startsWith("data: ")) continue;
        const event = JSON.parse(raw.slice(6));
        if (event.type === "notice") {
          reply.insertAdjacentHTML("beforebegin", `<div class="msg bot"><div class="notice" role="alert">${escape(event.text)}</div></div>`);
        } else if (event.type === "sources") {
          sources = event.sources;
        } else if (event.type === "token") {
          answer += event.text;
          reply.innerHTML = `<div class="bubble">${render(answer)}</div>`;
        } else if (event.type === "handoff") {
          answer = event.text;
          reply.innerHTML = `<div class="handoff">${escape(event.text)}<br><button type="button">Pass to the front desk</button></div>`;
          reply.querySelector("button").addEventListener("click", (e) => {
            e.currentTarget.disabled = true;
            e.currentTarget.textContent = "Sent — in a real deployment this opens a ticket";
          });
        } else if (event.type === "error") {
          reply.innerHTML = `<div class="error">${escape(event.text)}</div>`;
        }
        log.scrollTop = log.scrollHeight;
      }
    }

    // Show only the sources the answer actually cited.
    const citedNumbers = new Set([...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/).map(Number)));
    const cited = sources.filter((s) => citedNumbers.has(s.n));
    if (cited.length) {
      reply.insertAdjacentHTML(
        "beforeend",
        `<div class="sources" aria-label="Sources">${cited.map((s) => `<span><b>${s.n}</b>${escape(s.page)} · ${escape(s.section)}</span>`).join("")}</div>`,
      );
    }
    if (answer) history.push({ role: "assistant", content: answer });
  } catch {
    reply.innerHTML = `<div class="error">Connection lost. Check your network and try again.</div>`;
    history.pop();
  } finally {
    setBusy(false);
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value;
  input.value = "";
  input.style.height = "";
  ask(q);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
});

suggestions.addEventListener("click", (e) => {
  if (e.target instanceof HTMLButtonElement) ask(e.target.textContent);
});
