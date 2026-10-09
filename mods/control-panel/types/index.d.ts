export type Mode = 'commands' | 'review' | 'pages' | 'where'
export type Counts = { proposals: number; unreviewed: number; findings: number }

declare module 'claude-code' {
  interface PluginState {
    'control-panel': {
      root: string | null
      cwd: string
      mode: Mode
      counts: Counts
      cursor: number
      version: number
      newPages: string[]
      sent: string
    }
  }
}
