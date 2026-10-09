export type Server = 'up' | 'down' | 'none'
export type Tally = { wiki: number; web: number; own: number }

declare module 'claude-code' {
  interface PluginState {
    'wiki-sources': { isWikiProject: boolean; server: Server; tally: Tally }
  }
}
