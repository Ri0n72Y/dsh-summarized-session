import type { SessionMemorySnapshot } from '../host/session.ts'

export interface MemoryCommitEvent {
  type: 'summarized-working-memory/commit'
  data: {
    response: string
    revision: number
  }
}

export function isMemoryCommitEvent(value: unknown): value is MemoryCommitEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Record<string, unknown>
  if (event.type !== 'summarized-working-memory/commit'
    || typeof event.data !== 'object' || event.data === null) return false
  const data = event.data as Record<string, unknown>
  return typeof data.response === 'string' && typeof data.revision === 'number'
}

/** Renderer adapters should display this text instead of the raw JSON assistant body. */
export function responseFromCommit(value: unknown): string | undefined {
  return isMemoryCommitEvent(value) ? value.data.response : undefined
}

export function responseFromSnapshot(value: SessionMemorySnapshot): string | undefined {
  return value.lastResponse
}
