import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionMemorySnapshot } from '../types.ts'
import type { EditableMemory, WorkingMemoryClientController } from './model.ts'
import { MEMORY_RPC_PREFIX } from '../rpc.ts'

function snapshot(value: unknown): SessionMemorySnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Host returned an invalid working-memory snapshot')
  }
  const candidate = value as Partial<SessionMemorySnapshot>
  if (typeof candidate.enabled !== 'boolean'
    || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0
    || typeof candidate.summary !== 'string' || !Array.isArray(candidate.recentChats)) {
    throw new Error('Host returned an invalid working-memory snapshot')
  }
  return candidate as SessionMemorySnapshot
}

export class RpcWorkingMemoryClient implements WorkingMemoryClientController {
  private readonly listeners = new Set<(snapshot: SessionMemorySnapshot) => void>()
  private current?: SessionMemorySnapshot
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

  save(expectedRevision: number, memory: EditableMemory): Promise<SessionMemorySnapshot> {
    return this.call('save', { sessionId: this.sessionId, expectedRevision, memory })
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

  async refresh(): Promise<SessionMemorySnapshot> {
    return this.read()
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
    for (const listener of [...this.listeners]) listener(value)
  }
}
