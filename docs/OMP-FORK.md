# OMP-FORK: omp as a native Shepherdr agent, as a survivable patch

This fork makes [omp](https://omp.ai) a first-class chat agent in Shepherdr next to Claude Code and
Codex: a space's Assistant can run omp, its conversation renders as chat bubbles from omp's own
session log, restarts resume the same session file, and the whole thing is a small, isolated diff
that rebases onto upstream releases (they ship 2–3 a week) without pain.

Plan of record: `docs/omp-shepherdr-fork-plan.md` in the research-btc repo (BTC-81). Facts below
were probed live against herdr-core 0.1.18 and omp 18.16.0 on 2026-11-06.

## What you get

- **Assistant on omp**: set the Assistant's agent to omp (below) and every new Assistant — a
  space's first message, a new space's auto-start, a restart — runs the fork's
  `assistant-omp` template instead of `assistant` (claude).
- **Real chat bubbles**: omp's own session jsonl is read by the same `ChatReader` the chat uses
  for Claude Code: user/agent bubbles, tools rows that open to their output, its questions, the
  working line, its model. History survives refreshes and ended agents (`log:` readers) like any
  CLI's.
- **Restart = same conversation**: omp appends the session file it resumes, so a resume is started
  only after the old process has fully exited (`restart.sh` stops and waits first). Never two omp
  on one session file.
- **Everything herdr-core already does for omp keeps working**: `hc` 0.1.18 knows omp natively
  (`status.app "omp"`, `working`/`done`, turn counts, `blocked` with the question's words while it
  waits on its `ask` tool, first-message delivery to a template). No core changes needed.

### Degradations (known, accepted)

- **No question/permission cards from hooks**: omp 18.16 has no hook file the installer can write,
  so a question card can't be answered from the web. omp under `--auto-approve` doesn't ask
  permissions; its `ask` tool shows as a card in the chat (with its options) and is answered in
  the terminal tab (hc reports `blocked` + the question while it waits). Plan P9/R3.
- **No usage meter**: omp's log names the model and thinking level but not token counts, so the
  context percentage stays empty.
- **Model picker**: omp has no model list API; its picker section offers the running/pinned/recent
  model and anything typed by id (plan R5).

## Turning it on

The Assistant's CLI is a Shepherdr setting (Settings › Agents › Assistant, i.e. the `coordinator`
role), Everywhere or per space, in `~/.herdr/shepherdr.json`:

```json
{ "everywhere": { "coordinator": { "agent": "omp" } } }
```

Unset (or `"claude"`) is upstream behavior, byte for byte. The web's **+** and **Switch agent**
menus also list omp (as `omp --auto-approve`), and the model-menu restart sheet offers it. The
fork's template is installed beside the person's own: `~/.config/herdr-core/templates/assistant-omp.md`
(`command: omp --auto-approve`, body identical to `assistant.md`). Sessions land in omp's own tree
(`~/.omp/agent/sessions/<folder-slug>/`), one jsonl per conversation, never shared.

## The patch

New files (the fork's own, no upstream lines):

| File | What |
| --- | --- |
| `core/omp.js` | the adapter: omp's log as a conversation (fed by `chat-log.js` with its own helpers injected), and its argv (`keptArgv`, `freshArgv`, `argvFor`, `sessionOf` = the file path, `forkArgv`, `current`, `menu`) |
| `service/omp.ts` | the service side: `assistantTemplate(scope)` (the setting → template name) and `forkedFile` (a fork is a copy of the session file, resumed) |
| `templates/assistant-omp.md` | the Assistant template on omp |
| `core/omp.test.js` | the adapter's tests (fixture from a real disposable omp session) |
| `docs/OMP-FORK.md` | this file |

Inclusion points in upstream files — every omp addition is a parallel branch (`if kind === "omp"`
or one map entry), never a rewrite; ~90 changed lines in total, of which ~35 are the FIND/LOG
shell rules in `core/chat-log.js`:

| File | Lines | What |
| --- | --- | --- |
| `core/chat-log.js` | ~37 | FIND: omp branch (fd scan under `agent/sessions`, else newest jsonl whose `session` record names the terminal's cwd, mtime ≥ start − 60 s, `--session-dir` from its /proc cmdline). LOG: keep omp's message/model/thinking/execution records. `Conversation.feed` dispatches to the adapter; `execOf` map; `resultText` reads a toolResult line |
| `core/chat-reader.js` | ~4 | `KINDS` knows `omp` (status.app / foreground name); `locate` passes cwd + start to FIND |
| `core/agents.js` | ~13 | `NAMES`, and one-line dispatches to the adapter in `kept`/`freshArgv`/`argvFor`/`sessionOf`/`forkArgv`/`current`/`menuFor` |
| `core/screens.js`, `core/chat-view.js` | ~6 | omp in the CLI maps, labels and `subagentCli` |
| `service/actions.ts` | ~9 | omp in `knownAgents` and the model-menu guards; the spawn path picks `assistantTemplate(sp.id)`; a fork copies the file; `firstWhenIdle` takes omp's `done` for idle |
| `service/agents.ts` | ~1 | the restart sheet lists omp |
| `service/spaces.ts`, `service/watch.ts` | ~6 | a new space's Assistant and a lost Assistant's template pick; `checkLost` knows omp |
| `service/settings.ts`, `service/main.ts` | ~9 | `Settings.agentOf(role, scope)`; main wires it to `service/omp.ts` |
| `mods/coordinator/restart.sh` | ~13 | an omp Assistant restarts from `assistant-omp`; a resuming omp start waits for the old process to exit first |
| `bin/shepherdr`, `lib/COPIES` | 2 | omp on the service PATH; the adapter copied to the mods that carry `agents.js`/`chat-log.js` |

`mods/*/core/*.js` copies are generated (`bin/sync-shared`); they are not hand-diffed.

## Rebase playbook (per upstream release)

The fork lives on its branch (`omp-native`) off upstream `main`, installed from the clone. Never
run `shepherdr update` on a fork install — it would bring upstream files over the fork's. Updates
are: rebase, test, reinstall:

```bash
cd <the fork clone>
git fetch origin
git rebase origin/main            # conflicts: every omp piece is a parallel branch; take both sides
bin/sync-shared && bin/sync-shared --check
python3 -m unittest discover -s test          # (5 AutomationFromAnotherMachine tests fail on some machines' env, upstream too)
bun test service core web && bunx tsc --noEmit -p . && (cd web && bunx vite build)
./install.sh                    # or --root <scratch> first; then `shepherdr doctor`
```

Then one scratch-space smoke (spawn, bubbles, restart-resume — see below) before pointing the
person's spaces at it.

If a release moves one of the touched spots (rare: they're stable seams), the conflict is one
hunk in one file: keep upstream's change, re-add the single omp line. The awk rules in
`chat-log.js` are the only block of real omp logic in an upstream file; everything else calls
into `core/omp.js`.

### `shepherdr update` and the fork

The updater refuses to overwrite files it didn't ship (it writes `.new` and keeps a backup under
`~/.config/herdr-app/.shepherdr-backup/`), so even a mistaken update won't eat the fork's files
silently — but the service it installs would be upstream's, without omp support, while the
`assistant-omp` template and any `coordinator.agent: "omp"` setting remain. If that happens:
reinstall from the fork clone (`./install.sh`) and the omp Assistants come back; their session
files were never touched.

## Why it's safe with omp's own sessions

- omp appends the jsonl it resumes; two omp processes on one file is the one forbidden state. The
  only resume path is `restart.sh` with `HERDR_RESTART_RESUME=1` (the model-menu restart), and it
  kills the old process and waits for its exit (up to 15 s) before starting the new one. A
  *lost* session (the file is gone) starts fresh with a handover instead, as upstream does.
- Session discovery is exact: the jsonl the process holds open, else the newest file in omp's
  sessions tree whose own `session` record names that terminal's cwd and is at most as old as the
  terminal. Two omp agents in one folder never mix (probed: pid-exact fd; cwd + start for idle).
- The person's other omp data (`~/.omp/agent/…`) is only ever appended to by omp itself.

## Verified (2026-11-06, scratch core + scratch service)

1. **Spawn**: a new space's Assistant and a space's first message both start
   `template: assistant-omp` → `omp --auto-approve` (herdr-core reports `status.app "omp"`,
   first message delivered by hc). Probe + live smoke.
2. **Bubbles**: the chat shows the person's words and omp's answer (read from omp's session log:
   FIND → LOG → `Conversation`), plus tools rows and its questions. Live smoke over `/api/ws`.
3. **Restart = same file**: `omp --resume=<file>` appends the same jsonl (grew in place, one
   file, memory intact: it answered a question about the session's first message); `restart.sh`
   kills and waits before the resuming start. Probe + manual `restart.sh` run.
4. **`shepherdr doctor`** passes on a scratch install of the fork.
5. **Rebase**: rebased onto upstream `main` (3.1.10 → 3.1.14) without conflicts during
   development; the playbook above re-runs it per release.
6. **Diff**: ~90 changed lines in upstream source files (see the table), everything else new
   files and generated copies.

## The upstream PR (proposed, not opened)

The clean contribution is a **pluggable agent registry**: per-kind knowledge objects
`{ key, name, run, menu(), current(), kept(), fresh(), argvFor(), sessionOf(), fork(), feed(), resultOf() }`
replacing the hardcoded claude/codex branches in `core/agents.js`, `core/chat-log.js` and the
guards in `service/*`. This fork already carries that shape internally (everything omp lives in
`core/omp.js` + `service/omp.ts`; upstream files only dispatch), so the PR is mostly a move, not
a rewrite: lift the two existing branches into `core/claude.js`/`core/codex.js` siblings of
`core/omp.js`, route the dispatches through a registry, and ship omp as the second consumer that
proves the seam. Open it against `eliasstravik/shepherdr` only with the founder's go-ahead; if it
lands, this fork reduces to the `assistant-omp` template plus a settings line.
