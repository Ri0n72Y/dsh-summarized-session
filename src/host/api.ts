import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionMemorySnapshot } from './session.ts'
import { SessionMemoryController } from './session.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    summarizedWorkingMemory: SummarizedWorkingMemory
  }
}

export class SummarizedWorkingMemory extends Service {
  static inject = ['sessions', 'systemPrompt']

  readonly controller: SessionMemoryController

  constructor(ctx: Context, recentChatLimit: number) {
    super(ctx, 'summarizedWorkingMemory', true)
    this.controller = new SessionMemoryController(ctx, recentChatLimit)
    this.controller.attach()
  }

  get(session: Session): SessionMemorySnapshot {
    return this.controller.snapshot(session)
  }

  edit(agent: Agent, expectedRevision: number, value: unknown): SessionMemorySnapshot {
    return this.controller.edit(agent, expectedRevision, value)
  }
}
