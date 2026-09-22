import assert from 'node:assert/strict'
import test from 'node:test'
import {
  finalResponsePrompt, parseFinalResponse, parseMemoryEdit,
  proposeCompletion, workingMemoryText,
} from '../src/host/protocol.ts'

const entry = n => ({ user: `问题 ${n}`, assistant: `处理 ${n}，向用户报告了结果。` })
const envelope = changes => ({
  response: '正常回复："已完成"\n```ts\nconst path = "C:\\\\tmp"\n```',
  summary: '第一段自由文本。\n\n第二段包含最近几轮的状态。',
  recentChats: [entry(1), entry(2), entry(3)],
  ...changes,
})

test('JSON escaping and natural paragraphs survive unchanged', () => {
  const value = envelope()
  assert.deepEqual(parseFinalResponse(JSON.stringify(value), 3), value)
})

test('retains the newest N entries without clearing the window or changing summary', () => {
  const value = envelope()
  assert.deepEqual(parseFinalResponse(JSON.stringify(value), 2), {
    ...value, recentChats: [entry(2), entry(3)],
  })
})

test('rejects truncated JSON, fences, missing fields and malformed records', () => {
  const values = [
    '{"response":"partial"', '```json\n{}\n```', 'null', '[]',
    JSON.stringify({ response: 'x', summary: 'y' }),
    JSON.stringify(envelope({ summary: {} })),
    JSON.stringify(envelope({ response: '' })),
    JSON.stringify(envelope({ recentChats: [] })),
    JSON.stringify(envelope({ recentChats: [{ user: 'x', assistant: 42 }] })),
    JSON.stringify(envelope({ extra: true })),
  ]
  for (const raw of values) assert.throws(() => parseFinalResponse(raw, 3))
})

test('failed completion does not partially update memory', () => {
  const current = { revision: 2, summary: '原状态', recentChats: [entry(1)] }
  const original = structuredClone(current)
  assert.throws(() => proposeCompletion(current, 2, '{', 3))
  assert.deepEqual(current, original)
  const result = proposeCompletion(current, 2, JSON.stringify(envelope()), 3)
  assert.equal(result.next.revision, 3)
  assert.equal(result.response, envelope().response)
  assert.deepEqual(current, original)
})

test('a stale completion cannot overwrite a later user edit', () => {
  const edited = { revision: 3, summary: '用户修正后的状态', recentChats: [entry(1)] }
  assert.throws(() => proposeCompletion(edited, 2, JSON.stringify(envelope()), 3), /changed/)
  assert.equal(edited.summary, '用户修正后的状态')
})

test('manual edits and a blank initial state are accepted without a summary template', () => {
  assert.deepEqual(parseMemoryEdit({ summary: '', recentChats: [] }, 3), { summary: '', recentChats: [] })
  const edited = { summary: '我只想保留这一段。', recentChats: [entry(2)] }
  assert.deepEqual(parseMemoryEdit(edited, 3), edited)
  const rendered = workingMemoryText(edited, 3)
  assert.deepEqual(JSON.parse(rendered.slice(rendered.indexOf('\n') + 1)), edited)
})

test('the system prompt is stable, limits are explicit, and memory is not interpolated into it', () => {
  assert.equal(finalResponsePrompt(3), finalResponsePrompt(3))
  assert.match(finalResponsePrompt(3), /most recent 3 compressed/)
  assert.doesNotMatch(finalResponsePrompt(3), /\{\{recentChatLimit\}\}/)
  for (const n of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => finalResponsePrompt(n))
    assert.throws(() => parseFinalResponse(JSON.stringify(envelope()), n))
  }
})
