// The omp fork's service side (the adapter itself is core/omp.js): which Assistant template starts
// omp for a space, and omp's one argv side effect — a fork is a copy of its session file, resumed.
// Everything else the service does for omp goes through the shared core, so the fork's touch on
// the service stays one call per place. See docs/OMP-FORK.md.
import { copyFileSync } from "node:fs";

type AgentOf = (role: string, scope: string | null) => string | null;
let agentOf: AgentOf | null = null;

/** Installed by main.ts: a role's agent as the person's settings say it (Settings › Agents). */
export const setAgentOf = (fn: AgentOf) => { agentOf = fn; };

/** The Assistant template a space starts its Assistant from: the fork's omp one when its
 *  Assistant setting (Settings › Agents, Everywhere's or the space's own) says omp. */
export function assistantTemplate(scope: string | null): string {
  try { return agentOf?.("coordinator", scope) === "omp" ? "assistant-omp" : "assistant"; } catch { return "assistant"; }
}

/** omp has no fork flag (P4): a fork is a copy of the session file, resumed in the new tab. The
 *  copy is local (a fork needs the window, which is local); null when it can't be made. */
export function forkedFile(kind: string, session: string | null): string | null {
  if (kind !== "omp" || !session) return session;
  const to = `${session.replace(/\.jsonl$/, "")}.fork-${Date.now().toString(36)}.jsonl`;
  try { copyFileSync(session, to); return to; } catch { return null; }
}
