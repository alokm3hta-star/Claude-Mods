export type MaskStatus = {
  level: 'on' | 'off' | 'paused' | 'broken'
  names: number
  detectors: number
  folders: number
  // The on-device model; absent in a status saved by 0.17.
  model?: 'off' | 'loading' | 'on' | 'broken'
  // While the model loads: what it is doing. Absent before 0.18.2.
  step?: 'reading' | 'checking' | 'starting'
  // A press on the band not yet settled: which way it goes.
  switching?: 'on' | 'off'
  // True while the model scans a text that is not known clean.
  scanning?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'client-mask': { status: MaskStatus | null; masked: number; paused: boolean | null; sent: Record<string, number> }
  }
}
