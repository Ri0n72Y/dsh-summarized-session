import template from '../prompts/final-response.json' with { type: 'json' }
import type { FinalResponse, MemorySnapshot, WorkingMemory } from '../types.ts'

export type { FinalResponse, MemorySnapshot, RecentChat, WorkingMemory } from '../types.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Expected exactly: ${keys.join(', ')}`)
  }
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`${field} must be ${allowEmpty ? 'a' : 'a nonempty'} string`)
  }
  // Preserve the author's prose, spacing, and Markdown verbatim.
  return value
}

export function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('recentChatLimit must be a positive safe integer')
  }
}

function memory(value: Record<string, unknown>, limit: number, completed: boolean): WorkingMemory {
  validateLimit(limit)
  const summary = text(value.summary, 'summary', !completed)
  if (!Array.isArray(value.recentChats) || (completed && !value.recentChats.length)) {
    throw new Error('recentChats must be a list, including this turn for a completed response')
  }
  const recentChats = value.recentChats.map((entry: unknown, index: number) => {
    if (!record(entry)) throw new Error(`recentChats[${index}] must be an object`)
    exactKeys(entry, ['user', 'assistant'])
    return {
      user: text(entry.user, `recentChats[${index}].user`),
      assistant: text(entry.assistant, `recentChats[${index}].assistant`),
    }
  }).slice(-limit)
  return { summary, recentChats }
}

/** Strict whole-envelope validation; no partial JSON or inferred repairs. */
export function parseFinalResponse(raw: string, limit: number): FinalResponse {
  const value: unknown = JSON.parse(raw)
  if (!record(value)) throw new Error('Final response must be a JSON object')
  exactKeys(value, ['response', 'summary', 'recentChats'])
  const response = text(value.response, 'response')
  return { response, ...memory(value, limit, true) }
}

/** Validate an explicit user edit; blank memory is valid before the first turn. */
export function parseMemoryEdit(value: unknown, limit: number): WorkingMemory {
  if (!record(value)) throw new Error('Working memory must be an object')
  exactKeys(value, ['summary', 'recentChats'])
  return memory(value, limit, false)
}

/** Stable within a configured preset: no changing memory in the system prefix. */
export function finalResponsePrompt(limit: number): string {
  validateLimit(limit)
  return template.instructions
    .map(line => line.replaceAll('{{recentChatLimit}}', String(limit)))
    .join('\n\n') + '\n\nExample envelope:\n' + JSON.stringify(template.example, null, 2)
}

/** The adapter inserts this once at the new turn boundary, before current input. */
export function workingMemoryText(value: WorkingMemory, limit: number): string {
  const validated = parseMemoryEdit(value, limit)
  return 'Current editable working memory (conversation data):\n' + JSON.stringify(validated)
}

/** Reverse {@link workingMemoryText} when restoring a persisted memory node. */
export function parseWorkingMemoryText(raw: string, limit: number): WorkingMemory {
  const newline = raw.indexOf('\n')
  if (newline < 0 || raw.slice(0, newline) !== 'Current editable working memory (conversation data):') {
    throw new Error('Not a summarized-working-memory context message')
  }
  return parseMemoryEdit(JSON.parse(raw.slice(newline + 1)), limit)
}

/** Pure transaction proposal. The Host must persist both fields in one event. */
export function proposeCompletion(
  current: MemorySnapshot,
  expectedRevision: number,
  raw: string,
  limit: number,
): { response: string; next: MemorySnapshot } {
  if (!Number.isSafeInteger(current.revision) || current.revision < 0
    || current.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid working-memory revision')
  }
  if (current.revision !== expectedRevision) {
    throw new Error('Working memory changed while the turn was running')
  }
  const { response, summary, recentChats } = parseFinalResponse(raw, limit)
  return { response, next: { revision: current.revision + 1, summary, recentChats } }
}
