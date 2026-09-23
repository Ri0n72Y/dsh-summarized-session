import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SummarizedWorkingMemory } from './api.ts'
import { MEMORY_RPC_PREFIX } from '../rpc.ts'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('RPC payload must be an object')
  }
  return value as Record<string, unknown>
}

function sessionId(value: unknown): SessionId {
  if (typeof value !== 'string' || !value) throw new Error('sessionId must be a nonempty string')
  return value as SessionId
}

function failure(error: unknown) {
  return {
    ok: false as const,
    error: {
      code: 'summarized-working-memory/rejected',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

export function registerMemoryRpc(ctx: Context, memory: SummarizedWorkingMemory): void {
  ctx.effect(() => ctx.connection.rpc.intercept(
    '/api',
    endpoint => endpoint.startsWith(MEMORY_RPC_PREFIX),
    async (endpoint, payload) => {
      try {
        const input = record(payload)
        if (endpoint === `${MEMORY_RPC_PREFIX}read`) {
          return { ok: true, value: memory.getById(sessionId(input.sessionId)) }
        }
        if (endpoint === `${MEMORY_RPC_PREFIX}save`) {
          if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) {
            throw new Error('expectedRevision must be a non-negative safe integer')
          }
          return {
            ok: true,
            value: memory.editById(
              sessionId(input.sessionId),
              input.expectedRevision as number,
              input.memory,
            ),
          }
        }
        return {
          ok: false,
          error: { code: 'gateway/not-found', message: `Unknown endpoint: ${endpoint}`, details: {} },
        }
      } catch (error: unknown) {
        return failure(error)
      }
    },
  ), 'summarized-working-memory: RPC')
}
