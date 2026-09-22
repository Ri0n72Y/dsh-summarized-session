import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {
  Session, SessionEvent, UserMessage,
} from '@deepseek-ai/dsh-session'
import {
  parseMemoryEdit,
  parseWorkingMemoryText,
  proposeCompletion,
  workingMemoryText,
} from './protocol.ts'
import type { MemorySnapshot, WorkingMemory } from './protocol.ts'

export const MEMORY_SOURCE_KIND = 'summarized-working-memory'

export interface MemorySource {
  kind: typeof MEMORY_SOURCE_KIND
  revision: number
  surfaceStartSeq?: number
}

export interface SessionMemorySnapshot extends MemorySnapshot {
  memoryMessageSeq?: number
  lastResponse?: string
  lastError?: string
}

interface TurnState {
  expectedRevision: number
  latestAssistant?: SessionEvent<'assistant/message'>
  stopping: boolean
}

interface LiveState extends SessionMemorySnapshot {
  turns: Map<number, TurnState>
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'summarized-working-memory/commit': {
      revision: number
      summary: string
      recentChats: WorkingMemory['recentChats']
      response: string
      sourceAssistantSeq: number
      memoryMessageSeq: number
    }
    'summarized-working-memory/edit': {
      revision: number
      summary: string
      recentChats: WorkingMemory['recentChats']
      memoryMessageSeq: number
    }
    'summarized-working-memory/error': {
      turn: number
      sourceAssistantSeq?: number
      message: string
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function memorySource(value: unknown): MemorySource | undefined {
  if (!isRecord(value) || value.kind !== MEMORY_SOURCE_KIND) return undefined
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return undefined
  if (value.surfaceStartSeq !== undefined
    && (!Number.isSafeInteger(value.surfaceStartSeq) || (value.surfaceStartSeq as number) < 0)) return undefined
  return value as unknown as MemorySource
}

function textContent(message: { content: readonly unknown[] }): string {
  return message.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return []
    return [block.text]
  }).join('')
}

function createMemoryMessage(memory: MemorySnapshot, surfaceStartSeq?: number): UserMessage {
  const visibleMemory: WorkingMemory = {
    summary: memory.summary,
    recentChats: memory.recentChats,
  }
  return {
    id: `summarized-working-memory-${randomUUID()}`,
    role: 'user',
    source: {
      kind: MEMORY_SOURCE_KIND,
      revision: memory.revision,
      ...(surfaceStartSeq === undefined ? {} : { surfaceStartSeq }),
    },
    content: [{ type: 'text', text: workingMemoryText(visibleMemory, Number.MAX_SAFE_INTEGER) }],
  }
}

function readPersistedMemory(session: Session, limit: number): SessionMemorySnapshot {
  const messages = session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const source = memorySource(message.source)
    if (source === undefined) continue
    const memory = parseWorkingMemoryText(textContent(message), limit)
    return {
      revision: source.revision,
      summary: memory.summary,
      recentChats: memory.recentChats,
      ...(source.surfaceStartSeq === undefined ? {} : { memoryMessageSeq: source.surfaceStartSeq }),
    }
  }
  return { revision: 0, summary: '', recentChats: [] }
}

function assistantRaw(event: SessionEvent<'assistant/message'>): string {
  return textContent(event.data.message)
}

/**
 * Owns the turn-boundary state machine. Persistence is carried by ordinary
 * Session events and the replacement memory message, never browser storage.
 */
export class SessionMemoryController {
  private readonly states = new WeakMap<Session, LiveState>()
  private readonly ctx: Context
  readonly recentChatLimit: number

  constructor(ctx: Context, recentChatLimit: number) {
    this.ctx = ctx
    this.recentChatLimit = recentChatLimit
  }

  attach(): void {
    this.ctx.on('agent/created', ({ agent }) => {
      this.ensure(agent.session)
    })

    this.ctx.on('agent/pre-step', async ({ agent, turn, step }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const state = this.ensure(agent.session)
      this.completeStoppedTurns(agent, turn)
      if (step === 1 && !state.turns.has(turn)) {
        state.turns.set(turn, { expectedRevision: state.revision, stopping: false })
      }
      const currentTurn = state.turns.get(turn)
      if (currentTurn !== undefined) currentTurn.stopping = false
      if (state.memoryMessageSeq !== undefined) return decision

      // The first memory message enters the accepted user batch, after DSH's
      // system/runtime prefix and before the actual current input.
      return {
        ...decision,
        messages: [createMemoryMessage(state), ...decision.messages],
      }
    })

    this.ctx.on('session/event', (session, event) => {
      const state = this.states.get(session)
      if (state === undefined) return
      if (event.type === 'user/message') {
        const source = memorySource(event.data.source)
        if (source === undefined) return
        state.memoryMessageSeq = event.seq
        return
      }
      if (event.type === 'assistant/message') {
        const turn = state.turns.get(event.data.turn)
        if (turn !== undefined) turn.latestAssistant = event
      }
    })

    this.ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      if (signal.aborted) return
      const state = this.ensure(agent.session)
      const current = state.turns.get(turn)
      if (current !== undefined) current.stopping = true
    })

    this.ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.completeStoppedTurns(agent)
    })

    this.ctx.on('agent/error', ({ agent, turn }) => {
      this.states.get(agent.session)?.turns.delete(turn)
    })
  }

  snapshot(session: Session): SessionMemorySnapshot {
    const state = this.ensure(session)
    return {
      revision: state.revision,
      summary: state.summary,
      recentChats: structuredClone(state.recentChats),
      ...(state.memoryMessageSeq === undefined ? {} : { memoryMessageSeq: state.memoryMessageSeq }),
      ...(state.lastResponse === undefined ? {} : { lastResponse: state.lastResponse }),
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    }
  }

  edit(agent: Agent, expectedRevision: number, value: unknown): SessionMemorySnapshot {
    if (agent.status !== 'idle') throw new Error('Working memory can only be edited while the agent is idle')
    const session = agent.session
    const state = this.ensure(session)
    if (state.revision !== expectedRevision) throw new Error('Working memory changed before the edit was saved')
    if (state.memoryMessageSeq === undefined) throw new Error('Working memory has not entered the session surface')
    if (session.surface.nodes.at(-1) !== state.memoryMessageSeq) {
      throw new Error('Cannot edit memory while unfinished conversation history is present')
    }
    const edited = parseMemoryEdit(value, this.recentChatLimit)
    const next: MemorySnapshot = {
      revision: state.revision + 1,
      summary: edited.summary,
      recentChats: edited.recentChats,
    }
    const memorySeq = session.seq
    const message = createMemoryMessage(next, memorySeq)
    const event = session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: state.memoryMessageSeq, endSeq: state.memoryMessageSeq },
    })
    session.append('summarized-working-memory/edit', {
      revision: next.revision,
      summary: next.summary,
      recentChats: next.recentChats,
      memoryMessageSeq: event.seq,
    })
    Object.assign(state, next, { memoryMessageSeq: event.seq, lastError: undefined })
    return this.snapshot(session)
  }

  private ensure(session: Session): LiveState {
    const current = this.states.get(session)
    if (current !== undefined) return current
    const restored = readPersistedMemory(session, this.recentChatLimit)
    const state: LiveState = { ...restored, turns: new Map() }
    this.states.set(session, state)
    return state
  }

  private complete(agent: Agent, turnNumber: number): void {
    const session = agent.session
    const state = this.ensure(session)
    const turn = state.turns.get(turnNumber)
    if (turn === undefined) return
    state.turns.delete(turnNumber)
    const assistant = turn.latestAssistant
    if (assistant === undefined || state.memoryMessageSeq === undefined) return

    try {
      const completion = proposeCompletion(state, turn.expectedRevision, assistantRaw(assistant), this.recentChatLimit)
      const memorySeq = session.seq
      const message = createMemoryMessage(completion.next, memorySeq)
      const event = session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: state.memoryMessageSeq, endSeq: assistant.seq },
      })
      session.append('summarized-working-memory/commit', {
        revision: completion.next.revision,
        summary: completion.next.summary,
        recentChats: completion.next.recentChats,
        response: completion.response,
        sourceAssistantSeq: assistant.seq,
        memoryMessageSeq: event.seq,
      })
      Object.assign(state, completion.next, {
        memoryMessageSeq: event.seq,
        lastResponse: completion.response,
        lastError: undefined,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      state.lastError = message
      session.append('summarized-working-memory/error', {
        turn: turnNumber,
        sourceAssistantSeq: assistant.seq,
        message,
      })
      this.ctx.logger.warn(`summarized working memory rejected turn ${turnNumber}: ${message}`)
    }
  }

  private completeStoppedTurns(agent: Agent, exceptTurn?: number): void {
    const state = this.ensure(agent.session)
    const completed = [...state.turns]
      .filter(([turn, value]) => value.stopping && turn !== exceptTurn)
      .map(([turn]) => turn)
      .sort((left, right) => left - right)
    for (const turn of completed) this.complete(agent, turn)
  }
}
