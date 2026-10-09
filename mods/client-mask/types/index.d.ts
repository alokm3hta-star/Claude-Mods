export type GroupMode = 'group' | 'individual' | 'off'

export type MaskStatus = { level: 'on' | 'off' | 'broken'; names: number; detectors: number; folders: number }

declare module 'claude-code' {
  interface PluginState {
    'client-mask': { status: MaskStatus | null; masked: number; groups: GroupMode }
  }
}
