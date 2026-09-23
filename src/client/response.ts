import type { SessionMemorySnapshot } from '../types.ts'
import { parseFinalResponse } from '../host/protocol.ts'

export interface AssistantTextBlock {
  kind: string
  text?: string
}

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

/** Keep reasoning and other native blocks; replace only a valid final JSON text payload. */
export function projectAssistantBlocks<T extends AssistantTextBlock>(blocks: readonly T[]): readonly T[] {
  const textBlocks = blocks.filter(block => block.kind === 'text')
  if (textBlocks.length === 0 || textBlocks.some(block => typeof block.text !== 'string')) return blocks
  try {
    const parsed = parseFinalResponse(textBlocks.map(block => block.text).join(''), Number.MAX_SAFE_INTEGER)
    let replaced = false
    return blocks.flatMap((block): T[] => {
      if (block.kind !== 'text') return [block]
      if (replaced) return []
      replaced = true
      return [{ ...block, text: parsed.response }]
    })
  } catch {
    return blocks
  }
}
