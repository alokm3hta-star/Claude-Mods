export type Fill = { tokens: number; window: number; percent: number }
export type Cache = { read: number; write: number; input: number; at: number }
// One plan window as left, not used: five_hour or seven_day.
export type Plan = { kind: string; left: number; resetsAt: string | null }
// The hand-over points: a helper's stopAt, from which it takes no new job (null outside SolveFoundry), and pauseAt,
// its hand-over, and a Core's coreAt.
export type Points = { stopAt: number | null; pauseAt: number; coreAt: number }

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { fill: Fill | null; cache: Cache | null; now: number; requestAt: number | null; requestModel: string | null; model: string | null; boardAsk: number; plan: Plan[]; title: string | null; titleAt: number; points: Points | null; pointsAt: number }
    // Read only: the workspace board says it is installed, and gives a short summary.
    'workspace-board': { band: { present: boolean; summary: string; waiting: boolean } }
    'control-panel': { shown: boolean }
  }
}
