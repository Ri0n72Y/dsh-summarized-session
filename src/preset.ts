import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from './host/api.ts'
import { finalResponsePrompt } from './host/protocol.ts'

export const inject = ['summarizedWorkingMemory', 'systemPrompt']

/** Agent-scoped half mounted by the dedicated preset. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'summarized-working-memory:final-response',
    order: 9_500,
    text: finalResponsePrompt(ctx.summarizedWorkingMemory.controller.recentChatLimit),
    interpolate: false,
  }), 'summarized-working-memory: final response protocol')
}
