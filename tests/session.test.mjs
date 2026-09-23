import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionMemoryController, MEMORY_SOURCE_KIND } from '../src/host/session.ts'

class FakeContext {
  listeners = new Map()
  warnings = []
  logger = { warn: message => this.warnings.push(message) }

  on(name, listener) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }

  emit(name, ...args) {
    for (const listener of this.listeners.get(name) ?? []) listener(...args)
  }

  async waterfall(name, payload, terminal) {
    const listeners = this.listeners.get(name) ?? []
    let next = terminal
    for (const listener of [...listeners].reverse()) {
      const downstream = next
      next = () => listener(payload, downstream)
    }
    return next()
  }
}

class FakeSession {
  events = []
  surface = { nodes: [] }
  header = { agentPreset: 'summarized-working-memory' }

  constructor(ctx) { this.ctx = ctx }
  get seq() { return this.events.length }

  append(type, data, options) {
    const event = { type, data: structuredClone(data), seq: this.events.length, time: Date.now() }
    if (options?.surfaceOp?.op === 'replace') {
      const { startSeq, endSeq } = options.surfaceOp
      const start = this.surface.nodes.indexOf(startSeq)
      const end = this.surface.nodes.indexOf(endSeq)
      assert.notEqual(start, -1)
      assert.notEqual(end, -1)
      this.surface.nodes.splice(start, end - start + 1, event.seq)
    } else if (['user/message', 'assistant/message'].includes(type)) {
      this.surface.nodes.push(event.seq)
    }
    this.events.push(event)
    this.ctx.emit('session/event', this, event)
    return event
  }

  deriveMessages() {
    return this.surface.nodes.map(seq => {
      const event = this.events[seq]
      return event.type === 'user/message' ? event.data : event.data.message
    })
  }
}

const text = value => [{ type: 'text', text: value }]
const user = value => ({ id: crypto.randomUUID(), role: 'user', source: { kind: 'test' }, content: text(value) })

function assistantEnvelope(turn, summary = `状态 ${turn}`) {
  return JSON.stringify({
    response: `回复 ${turn}`,
    summary,
    recentChats: [{ user: `问题 ${turn}`, assistant: `完成 ${turn}` }],
  })
}

async function runTurn(ctx, session, agent, turn, raw) {
  const current = user(`输入 ${turn}`)
  session.append('user/message', current)
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, turn, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: session.deriveMessages() }),
  )
  assert.equal(decision.messages.at(-2)?.source.kind, MEMORY_SOURCE_KIND)
  assert.equal(decision.messages.at(-1)?.source.kind, 'test')
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      id: crypto.randomUUID(), role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'test' }, content: text(raw),
    },
    stream: [],
  })
  ctx.emit('agent/turn-stopping', { agent, turn, signal: new AbortController().signal })
  ctx.emit('agent/status', { agent, status: 'idle' })
}

test('successful turns replace covered history with one durable memory node', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'idle' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })

  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))
  const snapshot = controller.snapshot(session)
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.summary, '状态 1')
  assert.equal(snapshot.lastResponse, '回复 1')
  assert.deepEqual(session.surface.nodes, [snapshot.memoryMessageSeq])
  const memory = session.deriveMessages()[0]
  assert.equal(memory.source.kind, MEMORY_SOURCE_KIND)

  await runTurn(ctx, session, agent, 2, assistantEnvelope(2))
  assert.equal(controller.snapshot(session).revision, 2)
  assert.equal(session.surface.nodes.length, 1)
})

test('memory restores from the surface and an idle edit replaces it', async () => {
  const firstContext = new FakeContext()
  const session = new FakeSession(firstContext)
  const agent = { session, status: 'idle' }
  const first = new SessionMemoryController(firstContext, 3)
  first.attach()
  firstContext.emit('agent/created', { agent, source: 'startup' })
  await runTurn(firstContext, session, agent, 1, assistantEnvelope(1))

  const resumedContext = new FakeContext()
  session.ctx = resumedContext
  const resumed = new SessionMemoryController(resumedContext, 3)
  resumed.attach()
  resumedContext.emit('agent/created', { agent, source: 'resume' })
  const restored = resumed.snapshot(session)
  assert.equal(restored.revision, 1)
  assert.equal(restored.summary, '状态 1')

  const edited = resumed.edit(agent, 1, {
    summary: '用户修正',
    recentChats: [{ user: '修正请求', assistant: '用户手动修正了记忆' }],
  })
  assert.equal(edited.revision, 2)
  assert.equal(edited.summary, '用户修正')
  assert.deepEqual(session.surface.nodes, [edited.memoryMessageSeq])
})

test('invalid final JSON preserves memory and unfinished raw history', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'idle' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })
  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))
  const before = controller.snapshot(session)

  await runTurn(ctx, session, agent, 2, '{broken')
  const after = controller.snapshot(session)
  assert.equal(after.revision, before.revision)
  assert.equal(after.summary, before.summary)
  assert.equal(session.surface.nodes.length, 3)
  assert.match(after.lastError, /JSON/)
  assert.throws(() => controller.edit(agent, after.revision, {
    summary: '不应保存', recentChats: [],
  }), /unfinished/)
})

test('a tentative stop followed by same-turn steering does not compact early', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'running' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })

  session.append('user/message', user('最初输入'))
  const firstDecision = await ctx.waterfall(
    'agent/pre-step',
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: session.deriveMessages() }),
  )
  assert.equal(firstDecision.messages.at(-2)?.source.kind, MEMORY_SOURCE_KIND)
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: { id: crypto.randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: text(assistantEnvelope(1, '过早状态')) },
  })
  ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(controller.snapshot(session).revision, 0)

  session.append('user/message', user('同轮 steering'))
  const steered = await ctx.waterfall(
    'agent/pre-step',
    { agent, turn: 1, step: 2, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: session.deriveMessages() }),
  )
  assert.equal(steered.messages.at(-2)?.source.kind, MEMORY_SOURCE_KIND)
  session.append('assistant/message', {
    turn: 1, step: 2, stream: [],
    message: { id: crypto.randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: text(assistantEnvelope(1, '最终状态')) },
  })
  ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(controller.snapshot(session).summary, '最终状态')
  assert.equal(controller.snapshot(session).revision, 1)
})

test('stable injected context stays before the replaceable memory boundary', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'idle' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })
  const stable = { id: crypto.randomUUID(), role: 'user', source: { kind: 'agent-instructions' }, content: text('stable') }
  const current = user('current')
  session.append('user/message', stable)
  session.append('user/message', current)
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: session.deriveMessages() }),
  )
  assert.equal(decision.messages[0].source.kind, 'agent-instructions')
  assert.equal(decision.messages[1].source.kind, MEMORY_SOURCE_KIND)
  assert.equal(decision.messages[2].source.kind, 'test')
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: { id: crypto.randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: text(assistantEnvelope(1)) },
  })
  ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(session.deriveMessages()[0].source.kind, 'agent-instructions')
  assert.equal(session.deriveMessages()[1].source.kind, MEMORY_SOURCE_KIND)
})

test('disabled sessions remain untouched', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  session.header.agentPreset = 'standard'
  const agent = { session, status: 'idle' }
  const controller = new SessionMemoryController(ctx, 3, value => value.header.agentPreset === 'summarized-working-memory')
  controller.attach()
  const current = user('current')
  session.append('user/message', current)
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: session.deriveMessages() }),
  )
  assert.deepEqual(decision.messages, [current])
  assert.deepEqual(controller.snapshot(session), {
    enabled: false, revision: 0, summary: '', recentChats: [],
  })
})
