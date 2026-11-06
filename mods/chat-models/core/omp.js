// The omp adapter (Shepherdr's omp-native fork): everything omp-specific in one file, so the fork
// stays a few parallel branches beside the claude/codex ones and rebases cheaply. Two halves:
//   - the conversation: omp's own session log (a type-discriminated jsonl, schema "version" 3:
//     session / model_change / thinking_level_change / message records, message holding
//     { role: "user" | "assistant" | "toolResult", content: [{type:"text"|"thinking"|"toolCall"}] })
//     read as the same conversation items the chat shows for Claude Code. toolResult messages close
//     the call their parent tool_execution_start record names (data.toolCallId).
//   - the argv: how omp starts, resumes (it appends the SAME file: never two omp on one session
//     file), restarts on another model, and forks (no native fork: a copy of the file, resumed).
// Shared core: the source is core/omp.js; bin/sync-shared copies it into mods/chat/core/.
// The helpers it needs from chat-log.js (claudeStep's words, claudeUser's cleaning, time) are
// handed in by the caller, so this file imports nothing.

// ---- the conversation --------------------------------------------------------------------------

// One omp record into conv's items (l: the parsed line, h: { step, userOf, time } from chat-log.js).
export function feed(conv, l, off, h) {
  const at = h.time(l.timestamp);
  if (l.type === "model_change" && l.model) conv.meta = { ...conv.meta, model: String(l.model), at };
  else if (l.type === "thinking_level_change" && l.thinking != null)
    conv.meta = { ...conv.meta, effort: String(l.thinking), at };
  else if (l.type === "custom" && l.customType === "tool_execution_start" && l.data?.toolCallId)
    conv.execOf.set(String(l.id), String(l.data.toolCallId));
  else if (l.type === "message") {
    const m = l.message ?? {};
    const blocks = Array.isArray(m.content) ? m.content
      : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
    if (m.role === "toolResult") {
      // the answer to a call: its call id through the execution record that names it
      const id = conv.execOf.get(String(l.parentId));
      if (id) conv.done(id, off);
    } else if (m.role === "user") {
      const u = h.userOf(blocks);
      if (u) conv.user(`u${off}`, { ...u, at });
    } else if (m.role === "assistant") {
      for (const b of blocks) {
        if (b?.type === "text") {
          const said = conv.agentText(String(b.text ?? ""));
          if (said) conv.push({ kind: "agent", id: `a${off}`, text: said, at });
        } else if (b?.type === "thinking" && !conv.open.size && String(b.thinking ?? "").trim()) conv.doing = "Thinking";
        else if (b?.type === "toolCall") {
          const name = String(b.name ?? ""), args = b.arguments ?? {};
          if (name === "ask") {
            // its own question: shown as asked; answered in its terminal (no hook to answer from here)
            const text = (Array.isArray(args.questions) ? args.questions : []).map((q) =>
              [q?.question, ...(Array.isArray(q?.options) ? q.options.map((o) => `- ${o?.label ?? o}`) : [])].filter(Boolean).join("\n")).join("\n\n");
            if (text) conv.asked(String(b.id), { kind: "ask", id: `q${off}`, text });
            conv.open.set(String(b.id), "Asking you something");
            conv.doing = "Asking you something";
          } else {
            const st = stepOf(name, args, h);
            if (st) { st.at = at || Date.now(); conv.step(String(b.id), off, st); }
            if (name === "bash") {
              if (/herdr-artifact\b[^\n|;&]*\b(publish|update)\b/.test(String(args.command ?? "")))
                conv.push({ kind: "artifact", id: `art${off}`, at });
              conv.sent(String(args.command ?? ""), off, at);
            }
          }
        }
      }
    }
  }
}

// omp's tool names are claude's in lowercase (bash, read, write, edit, grep, glob, task):
// claudeStep's words for them, its own fall-through for the rest.
const CASE = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", multiedit: "MultiEdit", notebookedit: "NotebookEdit",
  grep: "Grep", glob: "Glob", todowrite: "TodoWrite", taskcreate: "TaskCreate", taskupdate: "TaskUpdate",
  websearch: "WebSearch", webfetch: "WebFetch", monitor: "Monitor", agent: "Agent", task: "Task" };
function stepOf(name, args, h) {
  const st = h.step(CASE[name.toLowerCase()] ?? name, args ?? {});
  return st ?? { kind: "tool", line: `Used ${name}`, doing: "Working" };
}

// What a toolResult line holds for its open row (its text), or null.
export function resultOf(line) {
  const l = (() => { try { return JSON.parse(line); } catch { return null; } })();
  const c = l?.message?.content;
  const text = Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : null;
  return text == null ? null : String(text);
}

// exec records by their id -> the call they run (Conversation gains this in chat-log.js).
export const execMap = () => new Map();

// ---- the argv ----------------------------------------------------------------------------------

// Flags whose next word is their value (so it isn't taken for a first message or dropped).
const VALUE = new Set(["--model", "-m", "--thinking", "--session-dir", "--add-dir", "--system-prompt", "--system-prompt-template",
  "--append-system-prompt", "--profile", "--config", "--mode", "--api-key", "--smol", "--slow", "--plan", "--models",
  "--service-tier", "--cwd", "--tools", "--plan-yolo-into", "--prewalk-into"]);
// What a restart chooses again (model, thinking, permissions) or what resumed a conversation.
const DROP = new Set(["--model", "-m", "--thinking", "--auto-approve"]);
const RESUME = new Set(["-r", "--resume", "-c", "--continue", "--restore"]);
const isResume = (a) => RESUME.has(a) || a.startsWith("--resume=") || a.startsWith("--restore=");

// The old agent's flags worth keeping on a restart, without what is chosen again or resumed.
export function keptArgv(argv) {
  const out = [];
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (isResume(a)) { if (!a.includes("=") && rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
    if (DROP.has(a)) continue;
    if ([...DROP].some((f) => a.startsWith(f + "="))) continue;
    if (VALUE.has(a)) { out.push(a, rest[++i]); continue; }
    if (a.startsWith("-")) out.push(a);
  }
  return out;
}

// The same flags without what resumed a conversation, or null when argv resumed none (a fresh
// start once that session is gone).
export function freshArgv(argv) {
  argv = argv ?? [];
  const at = argv.findIndex((a, i) => (i === 0 || !a.startsWith("-")) && String(a).split("/").pop() === "omp");
  if (at < 0) return null;
  const rest = argv.slice(at + 1), out = [argv[at]];
  let resumed = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (isResume(a)) { resumed = true; if (!a.includes("=") && rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
    if (VALUE.has(a)) { out.push(a, rest[++i]); continue; }
    if (a.startsWith("-")) out.push(a);
  }
  return resumed ? out : null;
}

// How to start omp with the picked model, thinking level and permissions. `session` for omp is
// its session file's path: it resumes by path, appending that same file (so a resume starts only
// once the old process has ended — never two omp on one file).
export function argvFor(pick, old) {
  const same = pick.agent === old.agent;
  const a = ["omp", ...(same ? keptArgv(old.argv ?? []) : [])];
  if (pick.model) a.push("--model", pick.model);
  if (pick.effort) a.push("--thinking", pick.effort);
  if (pick.perm === "full") a.push("--auto-approve");
  if (same && old.session) return { argv: [...a, `--resume=${old.session}`], resume: true, base: a };
  return { argv: a, resume: false, base: a };
}

// A conversation's session, from its log's path: omp resumes the file itself.
export function sessionOf(path) {
  return typeof path === "string" && path.endsWith(".jsonl") ? path : null;
}

// A copy of the conversation in a new tab: omp has no fork flag, so the file is copied (by the
// caller, service/omp.ts) and the copy resumed — with the model, thinking level and permissions
// it had.
export function forkArgv(argv, session) {
  argv = argv ?? [];
  const same = ["--model", "--thinking"].flatMap((f) => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === f && argv[i + 1] !== undefined) return [f, argv[i + 1]];
      if (argv[i].startsWith(f + "=")) return [argv[i]];
    }
    return [];
  });
  const auto = argv.includes("--auto-approve") ? ["--auto-approve"] : [];
  return ["omp", ...auto, ...keptArgv(argv), ...same, `--resume=${session}`];
}

// What omp runs on now: its model and thinking level from the log's own words, else its flags.
export function current(argv, meta) {
  argv = argv ?? [];
  const flag = (n) => { for (let i = argv.length - 1; i >= 0; i--) { if (argv[i] === n && argv[i + 1] !== undefined) return argv[i + 1]; if (argv[i].startsWith(n + "=")) return argv[i].slice(n.length + 1); } return null; };
  return { agent: "omp", model: meta.model ?? flag("--model"), label: null, perm: argv.includes("--auto-approve") ? "full" : "auto",
    effort: meta.effort ?? flag("--thinking"), fast: false, used: meta.used ?? null, window: meta.window ?? null };
}

// The model picker's omp section: no model list of its own (a model typed by id, or one picked
// before, is what it runs); its thinking levels are the levels --thinking takes.
export function menu(currentModel = null) {
  const models = [];
  if (currentModel && !models.some((m) => m.id === currentModel))
    models.unshift({ id: currentModel, name: currentModel, efforts: EFFORTS, defaultEffort: null, fast: false });
  return { name: "OMP", perms: [{ id: "auto", label: "Auto" }, { id: "full", label: "Full access" }], models };
}
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
