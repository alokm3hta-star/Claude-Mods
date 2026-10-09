export type MaskStatus = { level: 'on' | 'off' | 'paused' | 'broken'; names: number; detectors: number; folders: number }

declare module 'claude-code' {
  interface PluginState {
    'client-mask': { status: MaskStatus | null; masked: number; paused: boolean }
  }
}
