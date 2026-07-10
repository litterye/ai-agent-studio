/**
 * Plan-mode session state tracker.
 *
 * When a user types /plan, the session enters plan mode. The system prompt is
 * modified and write tools are restricted. Plan mode persists across turns
 * until the agent calls the exit_plan_mode tool.
 */

const planSessions = new Map<string, { goal: string }>()

export const planState = {
  /** Enter plan mode for a session. */
  enter(sessionId: string, goal: string): void {
    planSessions.set(sessionId, { goal })
  },

  /** Exit plan mode for a session. */
  exit(sessionId: string): void {
    planSessions.delete(sessionId)
  },

  /** Check whether a session is in plan mode. */
  isActive(sessionId: string | undefined | null): boolean {
    if (!sessionId) return false
    return planSessions.has(sessionId)
  },

  /** Get the plan goal for a session. */
  getGoal(sessionId: string | undefined | null): string | undefined {
    if (!sessionId) return undefined
    return planSessions.get(sessionId)?.goal
  },

  /** Get session IDs currently in plan mode. */
  activeSessions(): string[] {
    return [...planSessions.keys()]
  }
}
