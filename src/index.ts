import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { finalResponsePrompt, validateLimit } from './host/protocol.ts'
import { SummarizedWorkingMemory } from './host/api.ts'

export interface Config {
  recentChatLimit?: number
}

export const inject = ['sessions', 'systemPrompt']

export const Config: z<Config> = z.object({
  recentChatLimit: z.number().step(1).min(1).default(8),
})

export function apply(ctx: Context, config: Config = {}): void {
  const recentChatLimit = config.recentChatLimit ?? 8
  validateLimit(recentChatLimit)
  ctx.systemPrompt.section({
    name: 'summarized-working-memory:final-response',
    order: 9_500,
    text: finalResponsePrompt(recentChatLimit),
    interpolate: false,
  })
  ctx.plugin(SummarizedWorkingMemory, recentChatLimit)
}

export { SummarizedWorkingMemory } from './host/api.ts'
export type { SessionMemorySnapshot } from './host/session.ts'
