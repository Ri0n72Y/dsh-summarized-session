import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRecentChatsEditor, recentChatsEditorValue } from '../src/client/model.ts'
import { projectAssistantBlocks } from '../src/client/response.ts'
import { RpcWorkingMemoryClient } from '../src/client/transport.ts'

test('Recent Chats editor round-trips the strict public shape', () => {
  const chats = [{ user: '请求', assistant: '执行并报告' }]
  assert.deepEqual(parseRecentChatsEditor(recentChatsEditorValue(chats)), chats)
  for (const raw of ['{}', '[null]', '[{"user":"x"}]', '[{"user":"x","assistant":""}]',
    '[{"user":"x","assistant":"y","extra":true}]']) {
    assert.throws(() => parseRecentChatsEditor(raw))
  }
})

test('assistant projection requires a Host-accepted response and preserves native blocks', () => {
  const reasoning = { kind: 'reasoning', text: 'thinking' }
  const envelope = JSON.stringify({
    response: 'normal answer', summary: 'state',
    recentChats: [{ user: 'request', assistant: 'completed' }],
  })
  const blocks = [
    reasoning, { kind: 'text', text: envelope }, { kind: 'image', attachment: 'x' },
  ]
  assert.equal(projectAssistantBlocks(blocks, undefined), blocks)
  assert.deepEqual(projectAssistantBlocks(blocks, 'normal answer'), [
    reasoning, { kind: 'text', text: 'normal answer' }, { kind: 'image', attachment: 'x' },
  ])
  const ordinary = [{ kind: 'text', text: 'ordinary reply' }]
  assert.equal(projectAssistantBlocks(ordinary, undefined), ordinary)
})

test('the shared client combines Summary and Recent Chats edits for one proposal', () => {
  const client = new RpcWorkingMemoryClient({}, 'session')
  const snapshot = {
    enabled: true,
    revision: 2,
    summary: 'accepted',
    recentChats: [],
    committedResponses: [],
    pending: {
      response: 'reply',
      summary: 'proposed',
      recentChats: [{ user: 'u', assistant: 'a' }],
      sourceAssistantSeq: 9,
    },
  }
  client.updateDraft(snapshot, { summary: 'reviewed summary' })
  client.updateDraft(snapshot, { recentChats: [{ user: 'revised', assistant: 'reviewed' }] })
  assert.deepEqual(client.draft(snapshot), {
    summary: 'reviewed summary',
    recentChats: [{ user: 'revised', assistant: 'reviewed' }],
  })

  client.setValidationError('recentChats', 'Recent Chats JSON 无效')
  assert.equal(client.validationError(), 'Recent Chats JSON 无效')
  client.setValidationError('recentChats')
  assert.equal(client.validationError(), undefined)
})
