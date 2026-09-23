import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRecentChatsEditor, recentChatsEditorValue } from '../src/client/model.ts'
import { projectAssistantBlocks, responseFromCommit } from '../src/client/response.ts'

test('Recent Chats editor round-trips the strict public shape', () => {
  const chats = [{ user: '请求', assistant: '执行并报告' }]
  assert.deepEqual(parseRecentChatsEditor(recentChatsEditorValue(chats)), chats)
  for (const raw of ['{}', '[null]', '[{"user":"x"}]', '[{"user":"x","assistant":""}]',
    '[{"user":"x","assistant":"y","extra":true}]']) {
    assert.throws(() => parseRecentChatsEditor(raw))
  }
})

test('commit response extraction ignores unrelated events', () => {
  assert.equal(responseFromCommit({
    type: 'summarized-working-memory/commit', data: { response: '正常回复', revision: 2 },
  }), '正常回复')
  assert.equal(responseFromCommit({ type: 'assistant/message', data: {} }), undefined)
})

test('assistant projection replaces only a strict final envelope and preserves native blocks', () => {
  const reasoning = { kind: 'reasoning', text: 'thinking' }
  const envelope = JSON.stringify({
    response: 'normal answer', summary: 'state',
    recentChats: [{ user: 'request', assistant: 'completed' }],
  })
  assert.deepEqual(projectAssistantBlocks([
    reasoning, { kind: 'text', text: envelope }, { kind: 'image', attachment: 'x' },
  ]), [reasoning, { kind: 'text', text: 'normal answer' }, { kind: 'image', attachment: 'x' }])
  const ordinary = [{ kind: 'text', text: 'ordinary reply' }]
  assert.equal(projectAssistantBlocks(ordinary), ordinary)
})
