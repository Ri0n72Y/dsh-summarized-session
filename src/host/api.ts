import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionMemorySnapshot } from './session.ts'
import { SessionMemoryController } from './session.ts'
import { registerMemoryRpc } from './rpc.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    summarizedWorkingMemory: SummarizedWorkingMemory
  }
}

export class SummarizedWorkingMemory extends Service {
  static inject = ['agents', 'connection', 'sessions']

  readonly controller: SessionMemoryController

  constructor(ctx: Context, recentChatLimit: number, presetId: string) {
    super(ctx, 'summarizedWorkingMemory')
    this.controller = new SessionMemoryController(
      ctx,
      recentChatLimit,
      session => session.header.agentPreset === presetId,
    )
    this.controller.attach()
    registerMemoryRpc(ctx, this)
  }

  get(session: Session): SessionMemorySnapshot {
    return this.controller.snapshot(session)
  }

  edit(agent: Agent, expectedRevision: number, value: unknown): SessionMemorySnapshot {
    return this.controller.edit(agent, expectedRevision, value)
  }

  getById(sessionId: SessionId): SessionMemorySnapshot {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error(`Unknown session: ${sessionId}`)
    return this.get(session)
  }

  editById(sessionId: SessionId, expectedRevision: number, value: unknown): SessionMemorySnapshot {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`Session has no active agent: ${sessionId}`)
    return this.edit(agent, expectedRevision, value)
  }
}
