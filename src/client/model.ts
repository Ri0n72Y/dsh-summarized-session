import type { RecentChat, SessionMemorySnapshot } from '../types.ts'

export interface EditableMemory {
  summary: string
  recentChats: RecentChat[]
}

/** Thin transport boundary; the DSH client adapter supplies the current Session id. */
export interface WorkingMemoryClient {
  read(): Promise<SessionMemorySnapshot>
  save(expectedRevision: number, memory: EditableMemory): Promise<SessionMemorySnapshot>
  subscribe(listener: (snapshot: SessionMemorySnapshot) => void): () => void
  isRunning(): boolean
}

export interface WorkingMemoryClientController extends WorkingMemoryClient {
  refresh(): Promise<SessionMemorySnapshot>
  setRunning(running: boolean): void
}

export function parseRecentChatsEditor(raw: string): RecentChat[] {
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value)) throw new Error('Recent Chats 必须是 JSON 列表')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`第 ${index + 1} 条必须是对象`)
    }
    const record = entry as Record<string, unknown>
    if (Object.keys(record).length !== 2 || typeof record.user !== 'string'
      || typeof record.assistant !== 'string') {
      throw new Error(`第 ${index + 1} 条必须且只能包含 user 与 assistant 字符串`)
    }
    if (!record.user.trim() || !record.assistant.trim()) {
      throw new Error(`第 ${index + 1} 条的 user 与 assistant 不能为空`)
    }
    return { user: record.user, assistant: record.assistant }
  })
}

export function recentChatsEditorValue(value: RecentChat[]): string {
  return JSON.stringify(value, null, 2)
}
