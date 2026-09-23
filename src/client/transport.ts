import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionMemorySnapshot } from '../types.ts'
import type { EditableMemory, WorkingMemoryClientController } from './model.ts'
import { MEMORY_RPC_PREFIX } from '../rpc.ts'

function chats(value: unknown): boolean {
  return Array.isArray(value) && value.every(entry => typeof entry === 'object' && entry !== null
    && !Array.isArray(entry)
    && Object.keys(entry).length === 2
    && typeof (entry as Record<string, unknown>).user === 'string'
    && typeof (entry as Record<string, unknown>).assistant === 'string')
}

function snapshot(value: unknown): SessionMemorySnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Host returned an invalid working-memory snapshot')
  }
  const candidate = value as Partial<SessionMemorySnapshot>
  if (typeof candidate.enabled !== 'boolean'
    || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0
    || typeof candidate.summary !== 'string' || !chats(candidate.recentChats)
    || !Array.isArray(candidate.committedResponses)
    || candidate.committedResponses.some(entry => typeof entry !== 'object' || entry === null
      || !Number.isSafeInteger(entry.sourceAssistantSeq) || entry.sourceAssistantSeq < 0
      || typeof entry.response !== 'string')
    || (candidate.pending !== undefined
      && (typeof candidate.pending !== 'object'
        || typeof candidate.pending.response !== 'string'
        || typeof candidate.pending.summary !== 'string'
        || !chats(candidate.pending.recentChats)
        || !Number.isSafeInteger(candidate.pending.sourceAssistantSeq)
        || candidate.pending.sourceAssistantSeq < 0))) {
    throw new Error('Host returned an invalid working-memory snapshot')
  }
  return candidate as SessionMemorySnapshot
}

export class RpcWorkingMemoryClient implements WorkingMemoryClientController {
  private readonly listeners = new Set<(snapshot: SessionMemorySnapshot) => void>()
  private current?: SessionMemorySnapshot
  private refreshing?: Promise<SessionMemorySnapshot>
  private draftKey?: string
  private editable?: EditableMemory
  private readonly validationErrors = new Map<string, string>()
  private running = false
  private readonly rpc: ClientConnectionRpc
  private readonly sessionId: SessionId

  constructor(rpc: ClientConnectionRpc, sessionId: SessionId) {
    this.rpc = rpc
    this.sessionId = sessionId
  }

  read(): Promise<SessionMemorySnapshot> {
    return this.call('read', { sessionId: this.sessionId })
  }

  save(
    expectedRevision: number,
    memory: EditableMemory,
    expectedProposalSeq?: number,
  ): Promise<SessionMemorySnapshot> {
    return this.call('save', {
      sessionId: this.sessionId,
      expectedRevision,
      memory,
      ...(expectedProposalSeq === undefined ? {} : { expectedProposalSeq }),
    })
  }

  subscribe(listener: (value: SessionMemorySnapshot) => void): () => void {
    this.listeners.add(listener)
    if (this.current !== undefined) listener(this.current)
    return () => { this.listeners.delete(listener) }
  }

  isRunning(): boolean {
    return this.running
  }

  setRunning(running: boolean): void {
    this.running = running
  }

  draft(value: SessionMemorySnapshot): EditableMemory {
    const key = `${value.revision}:${value.pending?.sourceAssistantSeq ?? 'accepted'}`
    if (this.draftKey !== key || this.editable === undefined) {
      this.draftKey = key
      this.validationErrors.clear()
      this.editable = {
        summary: value.pending?.summary ?? value.summary,
        recentChats: structuredClone(value.pending?.recentChats ?? value.recentChats),
      }
    }
    return structuredClone(this.editable)
  }

  updateDraft(value: SessionMemorySnapshot, change: Partial<EditableMemory>): EditableMemory {
    this.editable = { ...this.draft(value), ...structuredClone(change) }
    return this.draft(value)
  }

  validationError(): string | undefined {
    const errors = [...this.validationErrors.values()]
    return errors.length === 0 ? undefined : errors.join('\n')
  }

  setValidationError(field: 'recentChats', error?: string): void {
    if (error === undefined) this.validationErrors.delete(field)
    else this.validationErrors.set(field, error)
    if (this.current !== undefined) {
      const notification = { ...this.current }
      for (const listener of [...this.listeners]) listener(notification)
    }
  }

  async refresh(): Promise<SessionMemorySnapshot> {
    if (this.refreshing !== undefined) return this.refreshing
    const request = this.read().finally(() => {
      if (this.refreshing === request) delete this.refreshing
    })
    this.refreshing = request
    return request
  }

  private async call(endpoint: 'read' | 'save', payload: unknown): Promise<SessionMemorySnapshot> {
    const result = await this.rpc.call('/api', `${MEMORY_RPC_PREFIX}${endpoint}`, payload)
    if (!result.ok) throw new Error(result.error.message)
    const value = snapshot(result.value)
    this.publish(value)
    return value
  }

  private publish(value: SessionMemorySnapshot): void {
    this.current = value
    this.draft(value)
    for (const listener of [...this.listeners]) listener(value)
  }
}
