import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { validateLimit } from './host/protocol.ts'
import { SummarizedWorkingMemory } from './host/api.ts'

export const PRESET_ID = 'summarized-working-memory'

export interface Config {
  recentChatLimit?: number
  presetId?: string
}

export const inject = ['agents', 'connection', 'sessions']

export const Config: z<Config> = z.object({
  recentChatLimit: z.number().step(1).min(1).default(8),
  presetId: z.string().default(PRESET_ID),
})

export function apply(ctx: Context, config: Config = {}): void {
  const recentChatLimit = config.recentChatLimit ?? 8
  const presetId = config.presetId ?? PRESET_ID
  validateLimit(recentChatLimit)
  if (!presetId.trim()) throw new Error('presetId must be a nonempty string')
  ctx.plugin(SummarizedWorkingMemory, { recentChatLimit, presetId })
}

export { SummarizedWorkingMemory } from './host/api.ts'
export type { SessionMemorySnapshot } from './types.ts'
