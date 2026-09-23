import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { finalResponsePrompt, validateLimit } from './host/protocol.ts'

export interface Config {
  recentChatLimit?: number
}

export const inject = ['systemPrompt']

export const Config: z<Config> = z.object({
  recentChatLimit: z.number().step(1).min(1).default(8),
})

/** Agent-scoped half mounted by the dedicated preset. */
export function apply(ctx: Context, config: Config = {}): void {
  const recentChatLimit = config.recentChatLimit ?? 8
  validateLimit(recentChatLimit)
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'summarized-working-memory:final-response',
    order: 9_500,
    text: finalResponsePrompt(recentChatLimit),
    interpolate: false,
  }), 'summarized-working-memory: final response protocol')
}
