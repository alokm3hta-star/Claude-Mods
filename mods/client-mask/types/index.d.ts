export type MaskStatus = {
  level: 'on' | 'off' | 'paused' | 'broken'
  names: number
  detectors: number
  folders: number
  // The on-device model; absent in a status saved by 0.17.
  model?: 'off' | 'loading' | 'on' | 'broken'
}

declare module 'claude-code' {
  interface PluginState {
    'client-mask': { status: MaskStatus | null; masked: number; paused: boolean | null; sent: Record<string, number> }
  }
}
