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

function fakeAgent(session, status = 'idle') {
  const queues = { 'next-turn': [], 'next-step': [] }
  const inbox = {
    get nextTurn() { return queues['next-turn'] },
    get nextStep() { return queues['next-step'] },
    splice(target, start, deleteCount, inserted) {
      return queues[target].splice(start, deleteCount, ...inserted)
    },
  }
  const agent = {
    session,
    status,
    inbox,
    send(message, target, wakeup) {
      queues[target].push(message)
      if (wakeup) agent.status = 'running'
    },
  }
  return agent
}

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
  const agent = fakeAgent(session)
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

test('acceptance keeps the memory message authoritative and emits a runtime commit event', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = fakeAgent(session)
  const commits = []
  ctx.on('summarized-working-memory/commit', payload => { commits.push(payload) })
  ctx.on('summarized-working-memory/commit', () => { throw new Error('observer boom') })
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })
  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))

  const before = session.events.length
  const accepted = acceptProposal(controller, agent)
  assert.equal(session.events.length, before + 1)
  assert.equal(session.events.at(-1).type, 'user/message')
  assert.equal(commits.length, 1)
  assert.equal(commits[0].memoryMessageSeq, session.events.at(-1).seq)
  assert.equal(commits[0].response, '回复 1')
  assert.equal(accepted.committedResponses[0]?.response, '回复 1')
  assert.match(ctx.warnings.at(-1), /observer boom/)
  assert.equal(session.events.some(event => event.type.startsWith('summarized-working-memory/')), false)

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
  const agent = fakeAgent(session)
  const first = new SessionMemoryController(firstContext, 3)
  first.attach()
  firstContext.emit('agent/created', { agent, source: 'startup' })
  await runTurn(firstContext, session, agent, 1, assistantEnvelope(1))

  const resumedContext = new FakeContext()
  const edits = []
  resumedContext.on('summarized-working-memory/edit', payload => { edits.push(payload) })
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
  assert.equal(edits.length, 1)
  assert.equal(edits[0].memoryMessageSeq, revised.memoryMessageSeq)
  assert.equal(edits[0].recovery, false)
  assert.equal(session.events.some(event => event.type.startsWith('summarized-working-memory/')), false)
})

test('invalid final JSON blocks later turns until manual recovery replaces raw history', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = fakeAgent(session)
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })
  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))
  acceptProposal(controller, agent)
  const before = controller.snapshot(session)

  await runTurn(ctx, session, agent, 2, '{broken')
  const failed = controller.snapshot(session)
  assert.equal(failed.revision, before.revision)
  assert.equal(failed.summary, before.summary)
  assert.equal(session.surface.nodes.length, 3)
  assert.match(failed.recovery?.message, /JSON/)

  const resumedContext = new FakeContext()
  session.ctx = resumedContext
  const resumedAgent = fakeAgent(session)
  const resumed = new SessionMemoryController(resumedContext, 3)
  resumed.attach()
  resumedContext.emit('agent/created', { agent: resumedAgent, source: 'resume' })
  assert.match(resumed.snapshot(session).recovery?.message, /JSON/)

  const nextInput = user('不能偷渡到下一轮')
  const blocked = await resumedContext.waterfall(
    'agent/pre-step',
    { agent: resumedAgent, messages: [nextInput], turn: 3, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [nextInput] }),
  )
  assert.deepEqual(blocked, { kind: 'reject' })
  assert.equal(resumedAgent.inbox.nextTurn[0].id, nextInput.id)

  resumedAgent.status = 'idle'
  const recovered = resumed.edit(resumedAgent, failed.revision, {
    summary: '人工恢复', recentChats: [],
  })
  assert.equal(recovered.revision, before.revision + 1)
  assert.equal(recovered.summary, '人工恢复')
  assert.equal(recovered.recovery, undefined)
  assert.equal(session.surface.nodes.length, 1)
  assert.equal(session.events.some(event => event.type.startsWith('summarized-working-memory/')), false)
})

test('a non-completed durable turn end enters recovery without waiting for agent error', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = fakeAgent(session, 'running')
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })

  const current = user('触发 max tokens')
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [current], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [current] }),
  )
  for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: {
      id: crypto.randomUUID(), role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'test' }, content: text('partial'),
    },
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  const snapshot = controller.snapshot(session)
  assert.match(snapshot.recovery?.message, /max-tokens/)
  assert.equal(snapshot.pending, undefined)
})

test('a tentative stop followed by same-turn steering does not compact early', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = fakeAgent(session, 'running')
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
  const firstAssistant = session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: { id: crypto.randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: text(assistantEnvelope(1, '过早状态')) },
  })
  assert.equal(controller.snapshot(session).classifyingAssistantSeq, firstAssistant.seq)
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
  assert.equal(controller.snapshot(session).classifyingAssistantSeq, undefined)
  assert.equal(controller.snapshot(session).revision, 0)
  acceptProposal(controller, agent)
  assert.equal(controller.snapshot(session).summary, '最终状态')
})

test('stable injected context stays before the replaceable memory boundary', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = fakeAgent(session)
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
  const agent = fakeAgent(session)
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

test('pending rejection restores claimed steering and followup to their original inbox classes', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = fakeAgent(session)
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })
  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))

  const steering = user('steering')
  const followup = user('followup')
  session.append('turn/start', { turn: 2 })
  session.append('agent/inbox/spliced', {
    target: 'next-step', start: 0, removedCount: 1, inserted: [],
  })
  session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [],
  })

  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [steering, followup], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [steering, followup] }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
  assert.deepEqual(agent.inbox.nextStep.map(message => message.id), [steering.id])
  assert.deepEqual(agent.inbox.nextTurn.map(message => message.id), [followup.id])
})

test('pending proposal blocks the next turn and resumes its input after acceptance', async () => {
  const ctx = new FakeContext()
  const session = new FakeSession(ctx)
  const agent = fakeAgent(session)
  const controller = new SessionMemoryController(ctx, 3)
  controller.attach()
  ctx.emit('agent/created', { agent, source: 'startup' })

  await runTurn(ctx, session, agent, 1, assistantEnvelope(1))
  const pending = controller.snapshot(session)
  assert.equal(pending.revision, 0)
  assert.equal(pending.pending?.summary, '状态 1')

  const nextInput = user('输入 2')
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [nextInput], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [nextInput] }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(session.surface.nodes.length, 3)
  assert.equal(controller.snapshot(session).pending?.sourceAssistantSeq, pending.pending.sourceAssistantSeq)
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(agent.inbox.nextTurn[0].id, nextInput.id)

  agent.status = 'idle'
  const accepted = acceptProposal(controller, agent)
  assert.equal(accepted.revision, 1)
  assert.equal(accepted.pending, undefined)
  assert.equal(session.surface.nodes.length, 1)
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(agent.inbox.nextTurn[0].id, nextInput.id)
  assert.equal(agent.inbox.nextStep.length, 1)
  assert.equal(agent.inbox.nextStep[0].source.kind, 'summarized-working-memory-wake')
  assert.equal(agent.status, 'running')

  const claimed = [...agent.inbox.nextStep, agent.inbox.nextTurn[0]]
  agent.inbox.splice('next-step', 0, agent.inbox.nextStep.length, [])
  agent.inbox.splice('next-turn', 0, 1, [])
  const resumed = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: claimed, turn: 3, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: claimed }),
  )
  assert.equal(resumed.kind, 'enter')
  assert.equal(resumed.messages.some(message => message.source.kind === 'summarized-working-memory-wake'), false)
  assert.equal(resumed.messages.some(message => message.id === nextInput.id), true)
})

test('pending proposal survives a recent-chat limit change without normalization bypass', async () => {
  const firstContext = new FakeContext()
  const session = new FakeSession(firstContext)
  const agent = fakeAgent(session)
  const first = new SessionMemoryController(firstContext, 3)
  first.attach()
  firstContext.emit('agent/created', { agent, source: 'startup' })

  const initial = JSON.stringify({
    response: '第一轮',
    summary: '已有三条',
    recentChats: [1, 2, 3].map(value => ({ user: `问题 ${value}`, assistant: `处理 ${value}` })),
  })
  await runTurn(firstContext, session, agent, 1, initial)
  acceptProposal(first, agent)
  await runTurn(firstContext, session, agent, 2, assistantEnvelope(2))
  assert.ok(first.snapshot(session).pending)

  const resumedContext = new FakeContext()
  session.ctx = resumedContext
  const resumedAgent = fakeAgent(session)
  const resumed = new SessionMemoryController(resumedContext, 1)
  resumed.attach()
  resumedContext.emit('agent/created', { agent: resumedAgent, source: 'resume' })
  const restored = resumed.snapshot(session)
  assert.equal(restored.recentChats.length, 1)
  assert.ok(restored.pending)
  assert.equal(restored.pending.recentChats.length, 1)

  const current = user('下一轮不能绕过审核')
  const decision = await resumedContext.waterfall(
    'agent/pre-step',
    { agent: resumedAgent, messages: [current], turn: 3, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [current] }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
  assert.ok(resumed.snapshot(session).pending)
})

test('a changed recent-chat limit normalizes the persisted surface before the next step', async () => {
  const firstContext = new FakeContext()
  const session = new FakeSession(firstContext)
  const agent = fakeAgent(session)
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
