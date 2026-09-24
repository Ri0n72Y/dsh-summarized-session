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
  WorkingMemoryCommitEvent,
  WorkingMemoryEditEvent,
} from '../types.ts'

export const MEMORY_SOURCE_KIND = 'summarized-working-memory'
const WAKE_SOURCE_KIND = 'summarized-working-memory-wake'

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

interface RecoveryState {
  surfaceStartSeq: SessionSeq
  surfaceEndSeq: SessionSeq
  sourceAssistantSeq?: SessionSeq
  message: string
}

interface LiveState extends MemorySnapshot {
  memoryMessageSeq?: SessionSeq
  /** First durable surface node covered by the next successful commit. */
  surfaceStartSeq?: SessionSeq
  pending?: PendingProposal
  recovery?: RecoveryState
  needsNormalization: boolean
  responses: Map<SessionSeq, string>
  turns: Map<number, TurnState>
}

export type { SessionMemorySnapshot } from '../types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'summarized-working-memory': MemorySource
    'summarized-working-memory-wake': { kind: typeof WAKE_SOURCE_KIND }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Accepted a reviewed pending Working Memory proposal. @mode emit */
    'summarized-working-memory/commit'(payload: WorkingMemoryCommitEvent): void
    /** Saved an explicit edit or recovery of accepted Working Memory. @mode emit */
    'summarized-working-memory/edit'(payload: WorkingMemoryEditEvent): void
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

function createWakeMessage(): UserMessage {
  return {
    id: randomUUID() as MessageId,
    role: 'user',
    source: { kind: WAKE_SOURCE_KIND },
    content: [],
  }
}

function isWakeMessage(message: UserMessage): boolean {
  return message.source.kind === WAKE_SOURCE_KIND
}

function assistantRaw(event: SessionEvent<'assistant/message'>): string {
  return textContent(event.data.message)
}

function uncoveredState(
  session: Session,
  accepted: MemorySnapshot & { memoryMessageSeq?: SessionSeq },
  limit: number,
): Pick<LiveState, 'pending' | 'recovery'> {
  const startSeq = accepted.memoryMessageSeq
  if (startSeq === undefined) return {}
  const start = session.surface.nodes.indexOf(startSeq)
  if (start < 0) return {}
  const tail = session.surface.nodes.slice(start + 1)
  const endSeq = tail.at(-1)
  if (endSeq === undefined) return {}
  const endEvent = session.eventAt(endSeq)
  if (endEvent?.type !== 'assistant/message' || endEvent.data.interrupted === true) {
    return {
      recovery: {
        surfaceStartSeq: startSeq,
        surfaceEndSeq: endSeq,
        message: 'Unreviewed working history has no valid completed final response and requires manual recovery.',
      },
    }
  }
  try {
    const completion = proposeCompletion(accepted, accepted.revision, assistantRaw(endEvent), limit)
    return {
      pending: {
        expectedRevision: accepted.revision,
        summary: completion.next.summary,
        recentChats: completion.next.recentChats,
        response: completion.response,
        sourceAssistantSeq: endEvent.seq,
        surfaceStartSeq: startSeq,
      },
    }
  } catch (error: unknown) {
    return {
      recovery: {
        surfaceStartSeq: startSeq,
        surfaceEndSeq: endSeq,
        sourceAssistantSeq: endEvent.seq,
        message: error instanceof Error ? error.message : String(error),
      },
    }
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

  const responses = new Map<SessionSeq, string>()
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const source = memorySource(event.data.source)
    if (source?.acceptedResponse !== undefined) {
      responses.set(source.acceptedResponse.sourceAssistantSeq, source.acceptedResponse.response)
    }
  }
  return {
    ...accepted,
    ...uncoveredState(session, accepted, limit),
    needsNormalization,
    responses,
  }
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
      this.completeStoppedTurns(agent.session, turn)

      // Pending or failed/uncovered history is a strict between-turn boundary.
      // Restore the driver's claimed batch to its original inbox classes before
      // rejecting so no input is lost and no raw history reaches another turn.
      if (state.pending !== undefined || state.recovery !== undefined) {
        this.restoreClaimed(agent, claimed, turn, step)
        return { kind: 'reject' }
      }

      this.normalizeMemoryMessage(agent.session, state)
      for (let index = claimed.length - 1; index >= 0; index -= 1) {
        if (isWakeMessage(claimed[index] as UserMessage)) claimed.splice(index, 1)
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
          this.extendUnreviewedHistory(state, event.seq)
          return
        }
        const memory = parseWorkingMemoryText(textContent(event.data), this.recentChatLimit)
        Object.assign(state, memory, {
          revision: source.revision,
          memoryMessageSeq: event.seq,
          surfaceStartSeq: event.seq,
          needsNormalization: false,
        })
        delete state.pending
        delete state.recovery
        if (source.acceptedResponse !== undefined) {
          state.responses.set(source.acceptedResponse.sourceAssistantSeq, source.acceptedResponse.response)
        }
        return
      }
      if (event.type === 'assistant/message') {
        this.extendUnreviewedHistory(state, event.seq, event.seq)
        const turn = state.turns.get(event.data.turn)
        if (turn !== undefined) turn.latestAssistant = event
        return
      }
      if (event.type === 'turn/end') {
        const turn = state.turns.get(event.data.turn)
        if (event.data.reason.kind === 'completed' && turn?.stopping === true) {
          this.complete(session, event.data.turn)
          return
        }
        state.turns.delete(event.data.turn)
        if (event.data.reason.kind !== 'blocked') {
          this.forceRecoveryFromSurface(
            session,
            state,
            `Turn ${event.data.turn} ended as ${event.data.reason.kind} before Working Memory was accepted.`,
          )
        }
      }
    })

    this.ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      if (signal.aborted || !this.enabled(agent.session)) return
      const state = this.ensure(agent.session)
      const current = state.turns.get(turn)
      if (current !== undefined) current.stopping = true
    })

    this.ctx.on('agent/status', ({ agent, status }) => {
      // Fallback for lightweight/custom drivers that do not expose the durable
      // turn/end event before becoming idle.
      if (status === 'idle' && this.enabled(agent.session)) this.completeStoppedTurns(agent.session)
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
      ...(state.pending === undefined ? {} : {
        pending: {
          response: state.pending.response,
          summary: state.pending.summary,
          recentChats: structuredClone(state.pending.recentChats),
          sourceAssistantSeq: state.pending.sourceAssistantSeq,
        },
      }),
      ...(state.recovery === undefined ? {} : {
        recovery: {
          message: state.recovery.message,
          ...(state.recovery.sourceAssistantSeq === undefined
            ? {}
            : { sourceAssistantSeq: state.recovery.sourceAssistantSeq }),
        },
      }),
      ...this.classifyingAssistantSeq(state) === undefined
        ? {}
        : { classifyingAssistantSeq: this.classifyingAssistantSeq(state) },
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
      this.emitCommit({
        sessionId: session.id,
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

    if (state.recovery !== undefined) {
      const recovery = state.recovery
      if (session.surface.nodes.at(-1) !== recovery.surfaceEndSeq) {
        throw new Error('Cannot recover working memory after new conversation history was appended')
      }
      const next: MemorySnapshot = {
        revision: state.revision + 1,
        summary: edited.summary,
        recentChats: edited.recentChats,
      }
      const sources = replacementSources(session, recovery.surfaceStartSeq, recovery.surfaceEndSeq)
      const memoryEvent = session.append('user/message', createMemoryMessage(next), {
        surfaceOp: {
          op: 'replace',
          startSeq: recovery.surfaceStartSeq,
          endSeq: recovery.surfaceEndSeq,
        },
        sourceEventSeqs: sources,
      })
      this.emitEdit({
        sessionId: session.id,
        revision: next.revision,
        summary: next.summary,
        recentChats: next.recentChats,
        memoryMessageSeq: memoryEvent.seq,
        recovery: true,
      })
      this.wakeDeferredTurns(agent)
      return this.snapshot(session)
    }
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
    this.emitEdit({
      sessionId: session.id,
      revision: next.revision,
      summary: next.summary,
      recentChats: next.recentChats,
      memoryMessageSeq: memoryEvent.seq,
      recovery: false,
    })
    return this.snapshot(session)
  }

  private emitCommit(payload: WorkingMemoryCommitEvent): void {
    try {
      this.ctx.emit('summarized-working-memory/commit', payload)
    } catch (error: unknown) {
      this.ctx.logger.warn(`summarized working memory commit observer failed: ${
        error instanceof Error ? error.message : String(error)
      }`)
    }
  }

  private emitEdit(payload: WorkingMemoryEditEvent): void {
    try {
      this.ctx.emit('summarized-working-memory/edit', payload)
    } catch (error: unknown) {
      this.ctx.logger.warn(`summarized working memory edit observer failed: ${
        error instanceof Error ? error.message : String(error)
      }`)
    }
  }

  private wakeDeferredTurns(agent: Agent): void {
    if (agent.status !== 'idle') return
    if (agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0) return
    if (agent.inbox.nextStep.some(isWakeMessage)) return
    // DSH alpha.1 has no wake-only seam. Add one private marker to next-step;
    // pre-step strips it before downstream listeners and model admission.
    agent.send(createWakeMessage(), 'next-step', true)
  }

  private restoreClaimed(
    agent: Agent,
    claimed: readonly UserMessage[],
    turn: number,
    step: number,
  ): void {
    if (claimed.length === 0) return
    if (step > 1) {
      agent.inbox.splice('next-step', 0, 0, [...claimed])
      return
    }
    const hasNextTurnClaim = this.turnClaimedNextTurn(agent.session, turn)
    const split = hasNextTurnClaim ? claimed.length - 1 : claimed.length
    const nextStep = claimed.slice(0, split)
    const nextTurn = claimed.slice(split)
    if (nextStep.length) agent.inbox.splice('next-step', 0, 0, [...nextStep])
    if (nextTurn.length) agent.inbox.splice('next-turn', 0, 0, [...nextTurn])
  }

  private turnClaimedNextTurn(session: Session, turn: number): boolean {
    const events = session.snapshotEvents()
    const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn)
    if (start < 0) return true // lightweight/fake drivers used by tests
    for (let index = start + 1; index < events.length; index += 1) {
      const event = events[index]
      if (event?.type !== 'agent/inbox/spliced') continue
      if (event.data.target === 'next-turn'
        && event.data.inserted.length === 0
        && (event.data.removedCount ?? 0) > 0
        && event.data.outcome === undefined) return true
    }
    return false
  }

  private classifyingAssistantSeq(state: LiveState): SessionSeq | undefined {
    let latest: SessionSeq | undefined
    for (const turn of state.turns.values()) {
      const seq = turn.latestAssistant?.seq
      if (seq !== undefined && (latest === undefined || seq > latest)) latest = seq
    }
    return latest
  }

  private extendUnreviewedHistory(
    state: LiveState,
    endSeq: SessionSeq,
    sourceAssistantSeq?: SessionSeq,
  ): void {
    if (state.pending !== undefined && endSeq > state.pending.sourceAssistantSeq) {
      state.recovery = {
        surfaceStartSeq: state.pending.surfaceStartSeq,
        surfaceEndSeq: endSeq,
        sourceAssistantSeq: sourceAssistantSeq ?? state.pending.sourceAssistantSeq,
        message: 'New conversation history was appended before the pending Working Memory was reviewed.',
      }
      delete state.pending
      return
    }
    if (state.recovery !== undefined && endSeq > state.recovery.surfaceEndSeq) {
      state.recovery = {
        ...state.recovery,
        surfaceEndSeq: endSeq,
        ...(sourceAssistantSeq === undefined ? {} : { sourceAssistantSeq }),
      }
    }
  }

  private forceRecoveryFromSurface(session: Session, state: LiveState, message: string): void {
    const startSeq = state.memoryMessageSeq
    if (startSeq === undefined) return
    const start = session.surface.nodes.indexOf(startSeq)
    if (start < 0) return
    const endSeq = session.surface.nodes.at(-1)
    if (endSeq === undefined || endSeq === startSeq) return
    const assistant = session.surface.nodes
      .slice(start + 1)
      .map(seq => session.eventAt(seq))
      .findLast((event): event is SessionEvent<'assistant/message'> => event?.type === 'assistant/message')
    state.recovery = {
      surfaceStartSeq: startSeq,
      surfaceEndSeq: endSeq,
      ...(assistant === undefined ? {} : { sourceAssistantSeq: assistant.seq }),
      message,
    }
    delete state.pending
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
    if (state.pending !== undefined || state.recovery !== undefined) return
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

  private complete(session: Session, turnNumber: number): void {
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
      state.pending = pending
      delete state.recovery
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      state.recovery = {
        surfaceStartSeq: state.surfaceStartSeq,
        surfaceEndSeq: assistant.seq,
        sourceAssistantSeq: assistant.seq,
        message,
      }
      delete state.pending
      this.ctx.logger.warn(`summarized working memory rejected turn ${turnNumber}: ${message}`)
    }
  }

  private completeStoppedTurns(session: Session, exceptTurn?: number): void {
    const state = this.ensure(session)
    const completed = [...state.turns]
      .filter(([turn, value]) => value.stopping && turn !== exceptTurn)
      .map(([turn]) => turn)
      .sort((left, right) => left - right)
    for (const turn of completed) this.complete(session, turn)
  }
}
