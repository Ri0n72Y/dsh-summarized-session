import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type {
  Session, SessionEvent, SessionSeq, UserMessage,
} from '@deepseek-ai/dsh-session'
import {
  parseMemoryEdit,
  parseWorkingMemoryText,
  proposeCompletion,
  workingMemoryText,
} from './protocol.ts'
import type {
  CommittedResponse,
  MemorySnapshot,
  PendingMemoryProposal,
  SessionMemorySnapshot,
  WorkingMemory,
} from '../types.ts'

export const MEMORY_SOURCE_KIND = 'summarized-working-memory'

export interface MemorySource {
  kind: typeof MEMORY_SOURCE_KIND
  revision: number
  acceptedResponse?: CommittedResponse
}

interface TurnState {
  expectedRevision: number
  latestAssistant?: SessionEvent<'assistant/message'>
  stopping: boolean
}

interface PendingProposal extends PendingMemoryProposal {
  expectedRevision: number
  surfaceStartSeq: SessionSeq
}

interface LiveState extends MemorySnapshot {
  memoryMessageSeq?: SessionSeq
  lastError?: string
  /** First durable surface node covered by the next successful commit. */
  surfaceStartSeq?: SessionSeq
  pending?: PendingProposal
  needsNormalization: boolean
  responses: Map<SessionSeq, string>
  turns: Map<number, TurnState>
}

export type { SessionMemorySnapshot } from '../types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'summarized-working-memory': MemorySource
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'summarized-working-memory/commit': {
      revision: number
      summary: string
      recentChats: WorkingMemory['recentChats']
      response: string
      sourceAssistantSeq: SessionSeq
      memoryMessageSeq: SessionSeq
    }
    'summarized-working-memory/proposal': {
      expectedRevision: number
      summary: string
      recentChats: WorkingMemory['recentChats']
      response: string
      sourceAssistantSeq: SessionSeq
      surfaceStartSeq: SessionSeq
    }
    'summarized-working-memory/edit': {
      revision: number
      summary: string
      recentChats: WorkingMemory['recentChats']
      memoryMessageSeq: SessionSeq
    }
    'summarized-working-memory/error': {
      turn: number
      sourceAssistantSeq?: SessionSeq
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
  if (value.acceptedResponse !== undefined) {
    if (!isRecord(value.acceptedResponse)
      || !Number.isSafeInteger(value.acceptedResponse.sourceAssistantSeq)
      || (value.acceptedResponse.sourceAssistantSeq as number) < 0
      || typeof value.acceptedResponse.response !== 'string') return undefined
  }
  return value as unknown as MemorySource
}

function textContent(message: { content: readonly unknown[] }): string {
  return message.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return []
    return [block.text]
  }).join('')
}

function createMemoryMessage(memory: MemorySnapshot, acceptedResponse?: CommittedResponse): UserMessage {
  const visibleMemory: WorkingMemory = {
    summary: memory.summary,
    recentChats: memory.recentChats,
  }
  return {
    id: randomUUID() as MessageId,
    role: 'user',
    source: {
      kind: MEMORY_SOURCE_KIND,
      revision: memory.revision,
      ...(acceptedResponse === undefined ? {} : { acceptedResponse }),
    },
    content: [{ type: 'text', text: workingMemoryText(visibleMemory, Number.MAX_SAFE_INTEGER) }],
  }
}

function readPersistedMemory(session: Session, limit: number): Omit<LiveState, 'turns'> {
  let accepted: MemorySnapshot & { memoryMessageSeq?: SessionSeq; surfaceStartSeq?: SessionSeq } = {
    revision: 0, summary: '', recentChats: [],
  }
  let needsNormalization = false
  for (let index = session.surface.nodes.length - 1; index >= 0; index -= 1) {
    const seq = session.surface.nodes[index]
    if (seq === undefined) continue
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const source = memorySource(event.data.source)
    if (source === undefined) continue
    const persisted = parseWorkingMemoryText(textContent(event.data), Number.MAX_SAFE_INTEGER)
    const memory = parseMemoryEdit(persisted, limit)
    needsNormalization = persisted.summary !== memory.summary
      || persisted.recentChats.length !== memory.recentChats.length
    accepted = {
      revision: source.revision,
      summary: memory.summary,
      recentChats: memory.recentChats,
      memoryMessageSeq: seq,
      surfaceStartSeq: seq,
    }
    break
  }

  let pending: PendingProposal | undefined
  const responses = new Map<SessionSeq, string>()
  for (const event of session.snapshotEvents()) {
    if ((event.type === 'user/message' || event.type === 'assistant/message')
      && pending !== undefined && event.seq > pending.sourceAssistantSeq) {
      pending = undefined
    }
    if (event.type === 'user/message') {
      const source = memorySource(event.data.source)
      if (source?.acceptedResponse !== undefined) {
        responses.set(source.acceptedResponse.sourceAssistantSeq, source.acceptedResponse.response)
      }
    }
    if (event.type === 'summarized-working-memory/proposal') {
      const normalized = parseMemoryEdit({
        summary: event.data.summary,
        recentChats: event.data.recentChats,
      }, limit)
      pending = { ...event.data, ...normalized }
    } else if (event.type === 'summarized-working-memory/commit') {
      responses.set(event.data.sourceAssistantSeq, event.data.response)
      if (pending?.sourceAssistantSeq === event.data.sourceAssistantSeq) pending = undefined
    }
  }
  return {
    ...accepted,
    ...(pending === undefined ? {} : { pending }),
    needsNormalization,
    responses,
  }
}

function assistantRaw(event: SessionEvent<'assistant/message'>): string {
  return textContent(event.data.message)
}

function replacementSources(session: Session, startSeq: SessionSeq, endSeq: SessionSeq): SessionSeq[] {
  const start = session.surface.nodes.indexOf(startSeq)
  const end = session.surface.nodes.indexOf(endSeq)
  if (start < 0 || end < start) throw new Error('Working-memory replacement range is no longer present')
  return session.surface.nodes.slice(start, end + 1)
}

/**
 * Owns the turn-boundary state machine. Persistence is carried by ordinary
 * Session events and the replacement memory message, never browser storage.
 */
export class SessionMemoryController {
  private readonly states = new WeakMap<Session, LiveState>()
  private readonly ctx: Context
  private readonly enabled: (session: Session) => boolean
  readonly recentChatLimit: number

  constructor(
    ctx: Context,
    recentChatLimit: number,
    enabled: (session: Session) => boolean = () => true,
  ) {
    this.ctx = ctx
    this.recentChatLimit = recentChatLimit
    this.enabled = enabled
  }

  attach(): void {
    this.ctx.on('agent/created', ({ agent }) => {
      if (this.enabled(agent.session)) this.ensure(agent.session)
    })

    this.ctx.on('agent/pre-step', async ({ agent, messages: claimed, turn, step }, next): Promise<PreStepDecision> => {
      if (!this.enabled(agent.session)) return next()
      const state = this.ensure(agent.session)
      this.normalizeMemoryMessage(agent.session, state)
      this.completeStoppedTurns(agent, turn)

      // A completed turn must be reviewed before another turn can consume raw
      // conversation history. Requeue the claimed input and close this empty
      // turn; accepting the proposal wakes the preserved queue again.
      if (state.pending !== undefined) {
        if (claimed.length) agent.inbox.splice('next-turn', 0, 0, claimed)
        return { kind: 'reject' }
      }

      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (step === 1 && !state.turns.has(turn)) {
        state.turns.set(turn, { expectedRevision: state.revision, stopping: false })
      }
      const currentTurn = state.turns.get(turn)
      if (currentTurn !== undefined) currentTurn.stopping = false
      if (state.memoryMessageSeq !== undefined) return decision

      // `decision.messages` are durably appended by the Agent loop. Insert the
      // memory immediately before the first claimed inbox message; assembled
      // runtime context may also use the user role and is not an input boundary.
      const claimedIds = new Set(claimed.map(message => message.id))
      const insertion = decision.messages.findIndex(message => claimedIds.has(message.id))
      const index = insertion < 0 ? 0 : insertion
      return {
        ...decision,
        messages: [
          ...decision.messages.slice(0, index),
          createMemoryMessage(state),
          ...decision.messages.slice(index),
        ],
      }
    })

    this.ctx.on('session/event', (session, event) => {
      const state = this.states.get(session)
      if (state === undefined) return
      if (event.type === 'user/message') {
        const source = memorySource(event.data.source)
        if (source === undefined) {
          if (state.pending !== undefined && event.seq > state.pending.sourceAssistantSeq) delete state.pending
          return
        }
        const memory = parseWorkingMemoryText(textContent(event.data), this.recentChatLimit)
        Object.assign(state, memory, {
          revision: source.revision,
          memoryMessageSeq: event.seq,
          surfaceStartSeq: event.seq,
          needsNormalization: false,
          lastError: undefined,
        })
        if (source.acceptedResponse !== undefined) {
          state.responses.set(source.acceptedResponse.sourceAssistantSeq, source.acceptedResponse.response)
        }
        if (state.pending !== undefined && event.seq > state.pending.sourceAssistantSeq) delete state.pending
        return
      }
      if (event.type === 'assistant/message') {
        if (state.pending !== undefined && event.seq > state.pending.sourceAssistantSeq) delete state.pending
        const turn = state.turns.get(event.data.turn)
        if (turn !== undefined) turn.latestAssistant = event
      }
    })

    this.ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      if (signal.aborted || !this.enabled(agent.session)) return
      const state = this.ensure(agent.session)
      const current = state.turns.get(turn)
      if (current !== undefined) current.stopping = true
    })

    this.ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && this.enabled(agent.session)) this.completeStoppedTurns(agent)
    })

    this.ctx.on('agent/error', ({ agent, turn }) => {
      this.states.get(agent.session)?.turns.delete(turn)
    })
  }

  snapshot(session: Session): SessionMemorySnapshot {
    if (!this.enabled(session)) {
      return { enabled: false, revision: 0, summary: '', recentChats: [], committedResponses: [] }
    }
    const state = this.ensure(session)
    return {
      enabled: true,
      revision: state.revision,
      summary: state.summary,
      recentChats: structuredClone(state.recentChats),
      committedResponses: [...state.responses].map(([sourceAssistantSeq, response]): CommittedResponse => ({
        sourceAssistantSeq, response,
      })),
      ...(state.memoryMessageSeq === undefined ? {} : { memoryMessageSeq: state.memoryMessageSeq }),
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      ...(state.pending === undefined ? {} : {
        pending: {
          response: state.pending.response,
          summary: state.pending.summary,
          recentChats: structuredClone(state.pending.recentChats),
          sourceAssistantSeq: state.pending.sourceAssistantSeq,
        },
      }),
    }
  }

  edit(
    agent: Agent,
    expectedRevision: number,
    value: unknown,
    expectedProposalSeq?: number,
  ): SessionMemorySnapshot {
    if (!this.enabled(agent.session)) throw new Error('Summarized working memory is not enabled for this session')
    if (agent.status !== 'idle') throw new Error('Working memory can only be edited while the agent is idle')
    const session = agent.session
    const state = this.ensure(session)
    if (state.revision !== expectedRevision) throw new Error('Working memory changed before the edit was saved')
    const edited = parseMemoryEdit(value, this.recentChatLimit)
    if (state.pending !== undefined) {
      const pending = state.pending
      if (expectedProposalSeq !== pending.sourceAssistantSeq) {
        throw new Error('Working-memory proposal changed before it was accepted')
      }
      if (pending.expectedRevision !== expectedRevision) {
        throw new Error('Working-memory proposal no longer matches the accepted revision')
      }
      if (session.surface.nodes.at(-1) !== pending.sourceAssistantSeq) {
        throw new Error('Cannot accept memory after new conversation history was appended')
      }
      const next: MemorySnapshot = {
        revision: state.revision + 1,
        summary: edited.summary,
        recentChats: edited.recentChats,
      }
      const sources = replacementSources(
        session, pending.surfaceStartSeq, pending.sourceAssistantSeq,
      )
      const memoryEvent = session.append('user/message', createMemoryMessage(next, {
        response: pending.response,
        sourceAssistantSeq: pending.sourceAssistantSeq,
      }), {
        surfaceOp: {
          op: 'replace',
          startSeq: pending.surfaceStartSeq,
          endSeq: pending.sourceAssistantSeq,
        },
        sourceEventSeqs: sources,
      })
      // Audit event only: the replacement memory message above remains the
      // authoritative atomic state for crash-safe recovery.
      session.append('summarized-working-memory/commit', {
        revision: next.revision,
        summary: next.summary,
        recentChats: next.recentChats,
        response: pending.response,
        sourceAssistantSeq: pending.sourceAssistantSeq,
        memoryMessageSeq: memoryEvent.seq,
      })
      this.wakeDeferredTurns(agent)
      return this.snapshot(session)
    }
    if (expectedProposalSeq !== undefined) throw new Error('Working-memory proposal is no longer pending')
    if (state.memoryMessageSeq === undefined || state.surfaceStartSeq === undefined) {
      throw new Error('Working memory has not entered the session surface')
    }
    const next: MemorySnapshot = {
      revision: state.revision + 1,
      summary: edited.summary,
      recentChats: edited.recentChats,
    }
    const memoryEvent = session.append('user/message', createMemoryMessage(next), {
      surfaceOp: { op: 'replace', startSeq: state.memoryMessageSeq, endSeq: state.memoryMessageSeq },
      sourceEventSeqs: [state.memoryMessageSeq],
    })
    session.append('summarized-working-memory/edit', {
      revision: next.revision,
      summary: next.summary,
      recentChats: next.recentChats,
      memoryMessageSeq: memoryEvent.seq,
    })
    return this.snapshot(session)
  }

  private wakeDeferredTurns(agent: Agent): void {
    const queued = [...agent.inbox.nextTurn]
    if (!queued.length) return

    // Reinsert the whole queue before waking so FIFO order is unchanged.
    agent.inbox.splice('next-turn', 0, queued.length, [])
    for (let index = 0; index < queued.length; index += 1) {
      const message = queued[index]
      if (message === undefined) continue
      agent.send(message, 'next-turn', index === queued.length - 1)
    }
  }

  private ensure(session: Session): LiveState {
    const current = this.states.get(session)
    if (current !== undefined) return current
    const restored = readPersistedMemory(session, this.recentChatLimit)
    const state: LiveState = { ...restored, turns: new Map() }
    this.states.set(session, state)
    return state
  }

  private normalizeMemoryMessage(session: Session, state: LiveState): void {
    if (!state.needsNormalization || state.memoryMessageSeq === undefined) return
    session.append('user/message', createMemoryMessage(state), {
      surfaceOp: {
        op: 'replace',
        startSeq: state.memoryMessageSeq,
        endSeq: state.memoryMessageSeq,
      },
      sourceEventSeqs: [state.memoryMessageSeq],
    })
  }

  private complete(agent: Agent, turnNumber: number): void {
    const session = agent.session
    const state = this.ensure(session)
    const turn = state.turns.get(turnNumber)
    if (turn === undefined) return
    state.turns.delete(turnNumber)
    const assistant = turn.latestAssistant
    if (assistant === undefined || state.surfaceStartSeq === undefined) return

    try {
      const completion = proposeCompletion(state, turn.expectedRevision, assistantRaw(assistant), this.recentChatLimit)
      const pending: PendingProposal = {
        expectedRevision: turn.expectedRevision,
        summary: completion.next.summary,
        recentChats: completion.next.recentChats,
        response: completion.response,
        sourceAssistantSeq: assistant.seq,
        surfaceStartSeq: state.surfaceStartSeq,
      }
      session.append('summarized-working-memory/proposal', pending)
      Object.assign(state, {
        pending,
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
