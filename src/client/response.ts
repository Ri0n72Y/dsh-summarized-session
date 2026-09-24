import type { SessionMemorySnapshot } from '../types.ts'

export interface AssistantTextBlock {
  kind: string
  text?: string
}

/** Keep native non-text blocks; replace envelope text once the Host validated this exact response. */
export function projectAssistantBlocks<T extends AssistantTextBlock>(
  blocks: readonly T[],
  visibleResponse: string | undefined,
): readonly T[] {
  if (visibleResponse === undefined) return blocks
  const textBlocks = blocks.filter(block => block.kind === 'text')
  if (textBlocks.length === 0 || textBlocks.some(block => typeof block.text !== 'string')) return blocks
  let replaced = false
  return blocks.flatMap((block): T[] => {
    if (block.kind !== 'text') return [block]
    if (replaced) return []
    replaced = true
    return [{ ...block, text: visibleResponse }]
  })
}

export function responseForAssistant(
  snapshot: Pick<SessionMemorySnapshot, 'pending' | 'committedResponses'>,
  sourceAssistantSeq: number,
): string | undefined {
  if (snapshot.pending?.sourceAssistantSeq === sourceAssistantSeq) return snapshot.pending.response
  return snapshot.committedResponses
    .find(entry => entry.sourceAssistantSeq === sourceAssistantSeq)?.response
}


export function shouldBufferAssistant(
  snapshot: Pick<SessionMemorySnapshot, 'classifyingAssistantSeq'>,
  status: 'running' | 'settled' | 'interrupted',
  sourceAssistantSeq: number,
): boolean {
  return status === 'running' || snapshot.classifyingAssistantSeq === sourceAssistantSeq
}
