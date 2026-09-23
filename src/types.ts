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

export interface PendingMemoryProposal extends WorkingMemory {
  response: string
  sourceAssistantSeq: SessionSeq
}

export interface CommittedResponse {
  sourceAssistantSeq: SessionSeq
  response: string
}

/** JSON-safe Host/Client snapshot returned by the Connection RPC. */
export interface SessionMemorySnapshot extends MemorySnapshot {
  enabled: boolean
  memoryMessageSeq?: SessionSeq
  lastError?: string
  pending?: PendingMemoryProposal
  committedResponses: CommittedResponse[]
}
