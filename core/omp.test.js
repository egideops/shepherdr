import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIND, LOG, Conversation, records, resultText } from "./chat-log.js";
import { sessionOf, freshArgv, argvFor, forkArgv } from "./agents.js";
import { kindOf } from "./chat-reader.js";
import { keptArgv, menu, current } from "./omp.js";

// omp's own session log (schema "version" 3), as LOG reads it and the omp adapter maps it to the
// same conversation items Claude Code's log gives. Lines as omp 18.16 writes them (from a real
// disposable session): the shapes matter, not the words.
const at = "2026-11-06T14:22:46.000Z";
const line = (o) => JSON.stringify(o);
const msg = (id, parentId, role, content) => line({ type: "message", id, parentId, timestamp: at, runtime: { version: "18.16.0" }, message: { role, content } });
const started = (id, parentId, callId, tool, args) => line({ type: "custom", customType: "tool_execution_start",
  data: { toolCallId: callId, toolName: tool, startedAt: at, args }, id, parentId, timestamp: at });

const SESSION = (cwd) => [
  line({ type: "title", v: 1, title: "", source: "auto", updatedAt: at, pad: "" }),
  line({ type: "session", version: 3, id: "01a1b13d-821f-70ce-8122-8aeac2dee93e", timestamp: at, cwd }),
  line({ type: "model_change", id: "m", parentId: null, timestamp: at, runtime: { version: "18.16.0" }, model: "zai/glm-5.3", resolvedModelIsFallback: false }),
  line({ type: "thinking_level_change", id: "t", parentId: "m", timestamp: at, runtime: { version: "18.16.0" }, thinking: "high" }),
  line({ type: "custom", customType: "date-cwd-reminder", data: { reminder: "<system-reminder>Today</system-reminder>" }, id: "d", parentId: null, timestamp: at }),
  msg("u1", "d", "user", [{ type: "text", text: "Say PONG after checking today's date" }]),
  line({ type: "custom", customType: "system-prompt-digest", data: "9927b862e0242b66", id: "s", parentId: "u1", timestamp: at }),
  msg("a1", "s", "assistant", [{ type: "thinking", thinking: "I will run date then answer." }, { type: "toolCall", id: "call_1", name: "bash",
    arguments: { i: "Checking the date", command: "date" }, intent: "Checking the date" }]),
  started("e1", "a1", "call_1", "bash", { command: "date" }),
  msg("r1", "e1", "toolResult", [{ type: "text", text: "Fri Nov 6 14:22:46 UTC 2026" }]),
  msg("a2", "r1", "assistant", [{ type: "text", text: "PONG" }]),
  msg("u2", "a2", "user", [{ type: "text", text: "Ask me my favorite color." }]),
  msg("a3", "u2", "assistant", [{ type: "toolCall", id: "call_2", name: "ask",
    arguments: { i: "Asking", questions: [{ id: "c", question: "What is my favorite color?", options: [{ label: "blue" }, { label: "red" }] }] } }]),
  started("e2", "a3", "call_2", "ask", {}),
  msg("r2", "e2", "toolResult", [{ type: "text", text: "User selected: blue" }]),
  msg("a4", "r2", "assistant", [{ type: "text", text: "Your favorite color is **blue**." }]),
];

async function readOmp(lines) {
  const dir = mkdtempSync(join(tmpdir(), "omp-log-"));
  const f = join(dir, "log.jsonl");
  writeFileSync(f, lines.join("\n") + "\n");
  const p = Bun.spawn(["sh", "-c", LOG, "log", "tail", f, "0"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  const recs = records(out).records;
  rmSync(dir, { recursive: true });
  const c = new Conversation("omp");
  c.feed(recs);
  return { c, recs };
}

test("an omp session reads as the same conversation: bubbles, tool rows, asks, its model", async () => {
  const { c } = await readOmp(SESSION("/tmp/probe"));
  const texts = (k) => c.items.filter((x) => x.kind === k).map((x) => x.text);
  expect(texts("user")).toEqual(["Say PONG after checking today's date", "Ask me my favorite color."]);
  expect(texts("agent")).toEqual(["PONG", "Your favorite color is **blue**."]);
  expect(c.meta.model).toBe("zai/glm-5.3");
  expect(c.meta.effort).toBe("high");
  // the bash call: a tools row whose step closes on its result (which the open row then loads)
  const row = c.items.find((x) => x.kind === "tools");
  expect(row.steps).toHaveLength(1);
  expect(row.steps[0].kind).toBe("run");
  expect(row.steps[0].line).toContain("date");
  expect(row.steps[0].out).toBeGreaterThan(0);
  expect([...c.open.keys()]).toEqual([]);  // call_2 (the ask) closed on its answer too
  // its own question: an ask item with its options, answered in its terminal
  const ask = c.items.find((x) => x.kind === "ask");
  expect(ask.text).toBe("What is my favorite color?\n- blue\n- red");
  // the ask's answer reads back from the log like any result
  const answer = SESSION("/tmp/probe").find((l) => l.includes("User selected"));
  expect(resultText(answer, "call_2")).toBe("User selected: blue");
});

test("what the log doesn't show stays out: injected reminders, thinking, bookkeeping", async () => {
  const { c, recs } = await readOmp(SESSION("/tmp/probe"));
  expect(c.items.filter((x) => x.kind === "user").map((x) => x.text)).not.toContain("<system-reminder>Today</system-reminder>");
  expect(c.items.some((x) => x.text?.includes("I will run date"))).toBe(false);
  expect(recs.every((r) => !r.data.includes("date-cwd-reminder"))).toBe(true);
});

// ---- finding the log of a running omp (FIND's omp branch) ------------------------------------

async function runFind(args, stdin = null) {
  const p = Bun.spawn(["sh", "-c", FIND, "chat", ...args], { stdout: "pipe", stderr: "pipe", stdin: stdin ? "pipe" : "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

test("FIND: the jsonl a live omp holds open, exact by pid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-find-"));
  mkdirSync(join(dir, "agent", "sessions"), { recursive: true });
  const f = join(dir, "agent", "sessions", "2026-11-06T14-22-40-671Z_01a1b13d-821f-70ce-8122-8aeac2dee93e.jsonl");
  writeFileSync(f, SESSION("/tmp/probe").join("\n") + "\n");
  // a stand-in process holding the file open, as omp holds its session while it works
  const holder = Bun.spawn(["sh", "-c", 'exec 9<"$1"; exec sleep 30', "hold", f]);
  await Bun.sleep(300);
  const pid = String(holder.pid);
  expect(await runFind(["omp", pid])).toBe(f);
  // an omp that holds nothing open (idle) is not found by the fd scan alone
  const bare = Bun.spawn(["sleep", "30"]);
  await Bun.sleep(200);
  expect(await runFind(["omp", String(bare.pid)])).toBe("");
  holder.kill(); bare.kill();
  rmSync(dir, { recursive: true });
});

test("FIND: idle omp by its session record's cwd, never another folder's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-idle-"));
  mkdirSync(join(dir, "agent", "sessions"), { recursive: true });
  const mine = join(dir, "agent", "sessions", "2026-11-06T14-22-40-671Z_01a1b13d-821f-70ce-8122-8aeac2dee93e.jsonl");
  const other = join(dir, "agent", "sessions", "2026-11-06T13-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl");
  writeFileSync(mine, SESSION("/tmp/probe").join("\n") + "\n");
  writeFileSync(other, SESSION("/tmp/other-folder").join("\n") + "\n");
  // a stand-in omp whose command line names the session dir (as omp's does), holding nothing open
  const proc = Bun.spawn(["sh", "-c", "sleep 30", `--session-dir=${join(dir, "agent", "sessions")}`]);
  await Bun.sleep(300);
  const now = String(Date.now());
  expect(await runFind(["omp", String(proc.pid), "/tmp/probe", now])).toBe(mine);
  expect(await runFind(["omp", String(proc.pid), "/tmp/a-folder-no-session-names", now])).toBe("");
  // a session from before this terminal started is not its session
  utimesSync(mine, new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));
  expect(await runFind(["omp", String(proc.pid), "/tmp/probe", now])).toBe("");
  proc.kill();
  rmSync(dir, { recursive: true });
});

// ---- the argv: kind, restart, resume, fork ----------------------------------------------------

test("kindOf knows omp (its report or its program)", () => {
  expect(kindOf({ status: { app: "omp", state: "done" } })).toBe("omp");
  expect(kindOf({ foreground: { name: "omp", pid: 1 } })).toBe("omp");
  expect(kindOf({ foreground: { name: "claude", pid: 1 } })).toBe("claude");
});

test("restart argv: the same session file resumed, model and thinking chosen again", () => {
  const old = { agent: "omp", argv: ["omp", "--auto-approve", "--session-dir", "/tmp/s", "--model", "zai/glm-5.3"],
    session: "/tmp/s/2026-11-06T14-22-40-671Z_01a1b13d-821f-70ce-8122-8aeac2dee93e.jsonl" };
  const same = argvFor({ agent: "omp", model: "openai/gpt-5.2", effort: "max" }, old);
  expect(same.resume).toBe(true);
  expect(same.argv).toEqual(["omp", "--session-dir", "/tmp/s", "--model", "openai/gpt-5.2", "--thinking", "max",
    `--resume=${old.session}`]);
  const plain = argvFor({ agent: "omp" }, old);
  expect(plain.argv).toEqual(["omp", "--session-dir", "/tmp/s", `--resume=${old.session}`]);
  // switching agents never resumes omp's file
  expect(argvFor({ agent: "claude" }, old).argv).toEqual(["claude", "--settings", `{"fastMode":false}`]);
});

test("a fresh start once the session is gone: omp's own flags, without what resumed it", () => {
  const argv = ["omp", "--auto-approve", "--session-dir", "/tmp/s", "--resume=/tmp/s/x.jsonl", "--model", "zai/glm-5.3"];
  expect(freshArgv("omp", argv)).toEqual(["omp", "--auto-approve", "--session-dir", "/tmp/s", "--model", "zai/glm-5.3"]);
  expect(freshArgv("omp", ["omp", "--auto-approve"])).toBeNull();
  expect(keptArgv(argv)).toEqual(["--session-dir", "/tmp/s"]);
});

test("omp's session is its file's path; a fork resumes a copy of it", () => {
  const p = "/tmp/s/2026-11-06T14-22-40-671Z_01a1b13d-821f-70ce-8122-8aeac2dee93e.jsonl";
  expect(sessionOf("omp", p)).toBe(p);
  expect(sessionOf("omp", "/tmp/s/nothelp.txt")).toBeNull();
  expect(forkArgv("omp", ["omp", "--auto-approve"], `${p}.copy.jsonl`))
    .toEqual(["omp", "--auto-approve", `--resume=${p}.copy.jsonl`]);
});

test("what omp runs on, and its picker section (models typed, not listed)", () => {
  expect(current(["omp", "--auto-approve", "--model", "zai/glm-5.3"], { effort: "high" }))
    .toMatchObject({ agent: "omp", model: "zai/glm-5.3", effort: "high", perm: "full" });
  expect(menu("zai/glm-5.3").models[0]).toMatchObject({ id: "zai/glm-5.3", name: "zai/glm-5.3" });
  expect(menu().perms.map((x) => x.id)).toEqual(["auto", "full"]);
});
