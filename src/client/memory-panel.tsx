import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { SessionMemorySnapshot } from '../types.ts'
import type { WorkingMemoryClient } from './model.ts'
import { parseRecentChatsEditor, recentChatsEditorValue } from './model.ts'

export interface MemoryPanelProps {
  client: WorkingMemoryClient
  initial: SessionMemorySnapshot
  running: boolean
}

const shell: CSSProperties = {
  display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', gap: 10,
  height: '100%', minHeight: 0, padding: 12,
}
const editor: CSSProperties = {
  boxSizing: 'border-box', width: '100%', height: '100%', minHeight: 180,
  resize: 'none', border: '1px solid var(--dsh-border, #d0d5dd)', borderRadius: 6,
  padding: 10, color: 'inherit', background: 'var(--dsh-surface, transparent)',
  font: 'inherit', lineHeight: 1.5,
}

function Footer({ revision, busy, dirty, pending, invalid, error, onSave, onReset }: {
  revision: number
  busy: boolean
  dirty: boolean
  pending: boolean
  invalid: boolean
  error: string | undefined
  onSave(): void
  onReset(): void
}): ReactNode {
  return <div style={{ display: 'grid', gap: 8 }}>
    {error ? <div role="alert" style={{ color: 'var(--dsh-danger, #b42318)', fontSize: 12 }}>{error}</div> : null}
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ opacity: 0.65, fontSize: 12 }}>revision {revision}</span>
      <span style={{ flex: 1 }} />
      <button type="button" disabled={!dirty || busy} onClick={onReset}>撤销</button>
      <button type="button" disabled={(!dirty && !pending) || busy || invalid} onClick={onSave}>
        {pending ? '审核并接受' : '保存'}
      </button>
    </div>
  </div>
}

function useMemory(client: WorkingMemoryClient, initial: SessionMemorySnapshot) {
  const [snapshot, setSnapshot] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => client.subscribe((next) => {
    setSnapshot(next)
    setError(next.lastError)
  }), [client])
  const save = async () => {
    if (client.isRunning()) {
      setError('Agent 运行期间不能保存工作记忆。')
      return
    }
    const validationError = client.validationError()
    if (validationError !== undefined) {
      setError(validationError)
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      setSnapshot(await client.save(
        snapshot.revision,
        client.draft(snapshot),
        snapshot.pending?.sourceAssistantSeq,
      ))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return { snapshot, saving, error, validationError: client.validationError(), save }
}

export function SummaryPanel({ client, initial, running }: MemoryPanelProps): ReactNode {
  const memory = useMemory(client, initial)
  const originalSummary = memory.snapshot.pending?.summary ?? memory.snapshot.summary
  const draftSummary = client.draft(memory.snapshot).summary
  const [value, setValue] = useState(draftSummary)
  useEffect(() => setValue(client.draft(memory.snapshot).summary), [
    client, memory.snapshot, memory.snapshot.pending?.sourceAssistantSeq, memory.snapshot.revision,
  ])
  const dirty = value !== originalSummary
  return <section style={shell} aria-label="Summary">
    <div>
      <strong>Summary</strong>
      <div style={{ opacity: 0.65, fontSize: 12 }}>
        {memory.snapshot.pending
          ? '这是 AI 提议的更新；可修改或清空，只有点击“审核并接受”后才会成为工作记忆。'
          : '可编辑的总体工作状态；保存后从下一轮开始生效。'}
      </div>
    </div>
    <textarea aria-label="Summary 内容" style={editor} value={value} onChange={(event) => {
      setValue(event.target.value)
      client.updateDraft(memory.snapshot, { summary: event.target.value })
    }} />
    <Footer revision={memory.snapshot.revision} busy={memory.saving || running} dirty={dirty}
      pending={memory.snapshot.pending !== undefined}
      invalid={memory.validationError !== undefined}
      error={memory.validationError ?? memory.error} onReset={() => {
        setValue(originalSummary)
        client.updateDraft(memory.snapshot, { summary: originalSummary })
      }}
      onSave={() => void memory.save()} />
  </section>
}

export function RecentChatsPanel({ client, initial, running }: MemoryPanelProps): ReactNode {
  const memory = useMemory(client, initial)
  const recentChats = client.draft(memory.snapshot).recentChats
  const originalRecentChats = memory.snapshot.pending?.recentChats ?? memory.snapshot.recentChats
  const canonical = useMemo(
    () => recentChatsEditorValue(recentChats),
    [memory.snapshot.revision, recentChats],
  )
  const originalCanonical = useMemo(
    () => recentChatsEditorValue(originalRecentChats),
    [memory.snapshot.revision, originalRecentChats],
  )
  const [value, setValue] = useState(canonical)
  const [parseError, setParseError] = useState<string>()
  useEffect(() => {
    setValue(canonical)
    setParseError(undefined)
  }, [canonical])
  const dirty = value !== originalCanonical
  const save = () => {
    try {
      const recentChats = parseRecentChatsEditor(value)
      setParseError(undefined)
      client.setValidationError('recentChats')
      client.updateDraft(memory.snapshot, { recentChats })
      void memory.save()
    } catch (cause: unknown) {
      setParseError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return <section style={shell} aria-label="Recent Chats">
    <div>
      <strong>Recent Chats</strong>
      <div style={{ opacity: 0.65, fontSize: 12 }}>
        {memory.snapshot.pending
          ? '这是 AI 提议的近期记录；可修改或清空，接受前不会覆盖现有工作记忆。'
          : '按时间升序保存最近几轮压缩交互，格式为 user / assistant。'}
      </div>
    </div>
    <textarea aria-label="Recent Chats JSON" spellCheck={false}
      style={{ ...editor, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 }}
      value={value} onChange={(event) => {
        const next = event.target.value
        setValue(next)
        try {
          client.updateDraft(memory.snapshot, { recentChats: parseRecentChatsEditor(next) })
          setParseError(undefined)
          client.setValidationError('recentChats')
        } catch (cause: unknown) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setParseError(message)
          client.setValidationError('recentChats', message)
        }
      }} />
    <Footer revision={memory.snapshot.revision} busy={memory.saving || running} dirty={dirty}
      pending={memory.snapshot.pending !== undefined}
      invalid={parseError !== undefined || memory.validationError !== undefined}
      error={parseError ?? memory.error} onReset={() => {
        const next = recentChatsEditorValue(originalRecentChats)
        setValue(next)
        client.updateDraft(memory.snapshot, { recentChats: originalRecentChats })
        client.setValidationError('recentChats')
        setParseError(undefined)
      }} onSave={save} />
  </section>
}
