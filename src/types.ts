import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

export interface RecentChat {
  user: string
  assistant: string
}

export interface WorkingMemory {
  summary: string
  recentChats: RecentChat[]
}

export interface FinalResponse extends WorkingMemory {
  response: string
}

export interface MemorySnapshot extends WorkingMemory {
  revision: number
}

/** JSON-safe Host/Client snapshot returned by the Connection RPC. */
export interface SessionMemorySnapshot extends MemorySnapshot {
  enabled: boolean
  memoryMessageSeq?: SessionSeq
  lastResponse?: string
  lastError?: string
}
