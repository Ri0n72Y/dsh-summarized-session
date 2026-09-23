import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionMemoryController, MEMORY_SOURCE_KIND } from '../src/host/session.ts'
import { parseWorkingMemoryText } from '../src/host/protocol.ts'

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
      const shadowed = this.surface.nodes.slice(start, end + 1)
      assert.deepEqual(options.sourceEventSeqs, shadowed)
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

  eventAt(seq) { return this.events[seq] }
  snapshotEvents() { return [...this.events] }
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
  const needsMemory = !session.deriveMessages().some(message => message.source.kind === MEMORY_SOURCE_KIND)
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [current], turn, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [current] }),
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages[0]?.source.kind, needsMemory ? MEMORY_SOURCE_KIND : 'test')
  assert.equal(decision.messages.at(-1)?.source.kind, 'test')
  for (const message of decision.messages) {
    session.append('user/message', message, { surfaceOp: 'append' })
  }
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

function acceptProposal(controller, agent) {
  const snapshot = controller.snapshot(agent.session)
  assert.ok(snapshot.pending)
  return controller.edit(agent, snapshot.revision, {
    summary: snapshot.pending.summary,
    recentChats: snapshot.pending.recentChats,
  }, snapshot.pending.sourceAssistantSeq)
}

test('successful turns require human acceptance before replacing covered history', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'idle' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })

  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))
  const proposed = controller.snapshot(session)
  assert.equal(proposed.revision, 0)
  assert.equal(proposed.summary, '')
  assert.equal(proposed.pending?.summary, '状态 1')
  assert.equal(session.surface.nodes.length, 3)

  const snapshot = acceptProposal(controller, agent)
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.summary, '状态 1')
  assert.equal(snapshot.committedResponses[0]?.response, '回复 1')
  assert.deepEqual(session.surface.nodes, [snapshot.memoryMessageSeq])
  const memory = session.deriveMessages()[0]
  assert.equal(memory.source.kind, MEMORY_SOURCE_KIND)

  await runTurn(ctx, session, agent, 2, assistantEnvelope(2))
  assert.equal(controller.snapshot(session).revision, 1)
  assert.equal(controller.snapshot(session).pending?.summary, '状态 2')
  acceptProposal(controller, agent)
  assert.equal(controller.snapshot(session).revision, 2)
  assert.equal(session.surface.nodes.length, 1)
})

test('acceptance persists memory and its projected response in one authoritative event', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'idle' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })
  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))

  const before = session.events.length
  const accepted = acceptProposal(controller, agent)
  assert.equal(session.events.length, before + 1)
  assert.equal(session.events.at(-1).type, 'user/message')
  assert.equal(session.events.filter(event => event.type === 'summarized-working-memory/commit').length, 0)
  assert.equal(accepted.committedResponses[0]?.response, '回复 1')

  const resumedContext = new FakeContext()
  session.ctx = resumedContext
  const resumed = new SessionMemoryController(resumedContext, 3)
  resumed.attach()
  resumedContext.emit('agent/created', { agent, source: 'resume' })
  assert.equal(resumed.snapshot(session).committedResponses[0]?.response, '回复 1')
})

test('a pending proposal restores and can be reviewed before acceptance', async () => {
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
  assert.equal(restored.revision, 0)
  assert.equal(restored.summary, '')
  assert.equal(restored.pending?.summary, '状态 1')

  const edited = resumed.edit(agent, 0, {
    summary: '用户修正',
    recentChats: [{ user: '修正请求', assistant: '用户手动修正了记忆' }],
  }, restored.pending.sourceAssistantSeq)
  assert.equal(edited.revision, 1)
  assert.equal(edited.summary, '用户修正')
  assert.deepEqual(session.surface.nodes, [edited.memoryMessageSeq])

  const revised = resumed.edit(agent, 1, {
    summary: '用户再次修正',
    recentChats: edited.recentChats,
  })
  assert.equal(revised.revision, 2)
  assert.equal(revised.summary, '用户再次修正')
  assert.deepEqual(session.surface.nodes, [revised.memoryMessageSeq])
})

test('invalid final JSON preserves memory and unfinished raw history', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'idle' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })
  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))
  acceptProposal(controller, agent)
  const before = controller.snapshot(session)

  await runTurn(ctx, session, agent, 2, '{broken')
  const after = controller.snapshot(session)
  assert.equal(after.revision, before.revision)
  assert.equal(after.summary, before.summary)
  assert.equal(session.surface.nodes.length, 3)
  assert.match(after.lastError, /JSON/)
  const recovered = controller.edit(agent, after.revision, {
    summary: '人工恢复', recentChats: [],
  })
  assert.equal(recovered.revision, before.revision + 1)
  assert.equal(recovered.summary, '人工恢复')
  assert.equal(session.surface.nodes.length, 3)
})

test('a tentative stop followed by same-turn steering does not compact early', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'running' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })

  const firstInput = user('最初输入')
  const firstDecision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [firstInput], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [firstInput] }),
  )
  for (const message of firstDecision.messages) session.append('user/message', message, { surfaceOp: 'append' })
  assert.equal(firstDecision.messages[0]?.source.kind, MEMORY_SOURCE_KIND)
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: { id: crypto.randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: text(assistantEnvelope(1, '过早状态')) },
  })
  ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.equal(controller.snapshot(session).revision, 0)

  const steering = user('同轮 steering')
  const steered = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [steering], turn: 1, step: 2, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [steering] }),
  )
  for (const message of steered.messages) session.append('user/message', message, { surfaceOp: 'append' })
  assert.equal(steered.messages[0]?.source.kind, 'test')
  session.append('assistant/message', {
    turn: 1, step: 2, stream: [],
    message: { id: crypto.randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: text(assistantEnvelope(1, '最终状态')) },
  })
  ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  ctx.emit('agent/status', { agent, status: 'idle' })
  agent.status = 'idle'
  assert.equal(controller.snapshot(session).pending?.summary, '最终状态')
  assert.equal(controller.snapshot(session).revision, 0)
  acceptProposal(controller, agent)
  assert.equal(controller.snapshot(session).summary, '最终状态')
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
  session.append('user/message', stable, { surfaceOp: 'append' })
  const runtimeContext = { ...user('runtime'), source: { kind: 'runtime-context' } }
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [current], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [current, runtimeContext] }),
  )
  assert.equal(decision.messages[0].source.kind, MEMORY_SOURCE_KIND)
  assert.equal(decision.messages[1].source.kind, 'test')
  assert.equal(decision.messages[2].source.kind, 'runtime-context')
  for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: { id: crypto.randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: text(assistantEnvelope(1)) },
  })
  ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  ctx.emit('agent/status', { agent, status: 'idle' })
  acceptProposal(controller, agent)
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
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [current], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [current] }),
  )
  assert.deepEqual(decision.messages, [current])
  assert.deepEqual(controller.snapshot(session), {
    enabled: false, revision: 0, summary: '', recentChats: [], committedResponses: [],
  })
})

test('an unreviewed proposal never becomes accepted memory and can be superseded', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'idle' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })
  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))
  const first = controller.snapshot(session)
  assert.equal(first.revision, 0)
  assert.ok(first.pending)
  await runTurn(ctx, session, agent, 2, assistantEnvelope(2))
  const latest = controller.snapshot(session)
  assert.equal(latest.revision, 0)
  assert.equal(latest.summary, '')
  assert.equal(latest.pending?.summary, '状态 2')
  assert.equal(session.surface.nodes.length, 5)
  assert.throws(() => controller.edit(agent, 0, {
    summary: first.pending.summary,
    recentChats: first.pending.recentChats,
  }, first.pending.sourceAssistantSeq), /proposal changed/)
  acceptProposal(controller, agent)
  assert.equal(session.surface.nodes.length, 1)
})

test('new failed history invalidates an older proposal without blocking manual recovery', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = { session, status: 'idle' }
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })

  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))
  assert.ok(controller.snapshot(session).pending)
  await runTurn(ctx, session, agent, 2, '{broken')
  const failed = controller.snapshot(session)
  assert.equal(failed.pending, undefined)
  assert.match(failed.lastError, /JSON/)

  const recovered = controller.edit(agent, failed.revision, {
    summary: '人工恢复状态',
    recentChats: [{ user: '恢复', assistant: '人工确认保留未完成历史' }],
  })
  assert.equal(recovered.revision, 1)
  assert.equal(recovered.summary, '人工恢复状态')
  assert.equal(session.surface.nodes.length, 5)
})

test('a changed recent-chat limit normalizes the persisted surface before the next step', async () => {
  const firstContext = new FakeContext()
  const session = new FakeSession(firstContext)
  const agent = { session, status: 'idle' }
  const first = new SessionMemoryController(firstContext, 3)
  first.attach()
  firstContext.emit('agent/created', { agent, source: 'startup' })
  const raw = JSON.stringify({
    response: '回复',
    summary: '状态',
    recentChats: [1, 2, 3].map(value => ({ user: `问题 ${value}`, assistant: `处理 ${value}` })),
  })
  await runTurn(firstContext, session, agent, 1, raw)
  acceptProposal(first, agent)

  const resumedContext = new FakeContext()
  session.ctx = resumedContext
  const resumed = new SessionMemoryController(resumedContext, 1)
  resumed.attach()
  resumedContext.emit('agent/created', { agent, source: 'resume' })
  assert.equal(resumed.snapshot(session).recentChats.length, 1)

  const current = user('下一轮')
  await resumedContext.waterfall(
    'agent/pre-step',
    { agent, messages: [current], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [current] }),
  )
  const memory = session.deriveMessages().find(message => message.source.kind === MEMORY_SOURCE_KIND)
  assert.equal(parseWorkingMemoryText(memory.content[0].text, Number.MAX_SAFE_INTEGER).recentChats.length, 1)
})
