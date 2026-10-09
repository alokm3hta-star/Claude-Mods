export type Fill = { tokens: number; window: number; percent: number }
export type Cache = { read: number; write: number; input: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { fill: Fill | null; cache: Cache | null; now: number }
  }
}
