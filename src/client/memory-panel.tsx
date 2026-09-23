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

function Footer({ revision, busy, dirty, error, onSave, onReset }: {
  revision: number
  busy: boolean
  dirty: boolean
  error?: string
  onSave(): void
  onReset(): void
}): ReactNode {
  return <div style={{ display: 'grid', gap: 8 }}>
    {error ? <div role="alert" style={{ color: 'var(--dsh-danger, #b42318)', fontSize: 12 }}>{error}</div> : null}
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ opacity: 0.65, fontSize: 12 }}>revision {revision}</span>
      <span style={{ flex: 1 }} />
      <button type="button" disabled={!dirty || busy} onClick={onReset}>撤销</button>
      <button type="button" disabled={!dirty || busy} onClick={onSave}>保存</button>
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
  const save = async (summary: string, recentChats: SessionMemorySnapshot['recentChats']) => {
    if (client.isRunning()) {
      setError('Agent 运行期间不能保存工作记忆。')
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      setSnapshot(await client.save(snapshot.revision, { summary, recentChats }))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return { snapshot, saving, error, save }
}

export function SummaryPanel({ client, initial, running }: MemoryPanelProps): ReactNode {
  const memory = useMemory(client, initial)
  const [value, setValue] = useState(memory.snapshot.summary)
  useEffect(() => setValue(memory.snapshot.summary), [memory.snapshot.revision, memory.snapshot.summary])
  const dirty = value !== memory.snapshot.summary
  return <section style={shell} aria-label="Summary">
    <div>
      <strong>Summary</strong>
      <div style={{ opacity: 0.65, fontSize: 12 }}>可编辑的总体工作状态；保存后从下一轮开始生效。</div>
    </div>
    <textarea aria-label="Summary 内容" style={editor} value={value} onChange={event => setValue(event.target.value)} />
    <Footer revision={memory.snapshot.revision} busy={memory.saving || running} dirty={dirty}
      error={memory.error} onReset={() => setValue(memory.snapshot.summary)}
      onSave={() => void memory.save(value, memory.snapshot.recentChats)} />
  </section>
}

export function RecentChatsPanel({ client, initial, running }: MemoryPanelProps): ReactNode {
  const memory = useMemory(client, initial)
  const canonical = useMemo(
    () => recentChatsEditorValue(memory.snapshot.recentChats),
    [memory.snapshot.revision, memory.snapshot.recentChats],
  )
  const [value, setValue] = useState(canonical)
  const [parseError, setParseError] = useState<string>()
  useEffect(() => {
    setValue(canonical)
    setParseError(undefined)
  }, [canonical])
  const dirty = value !== canonical
  const save = () => {
    try {
      const recentChats = parseRecentChatsEditor(value)
      setParseError(undefined)
      void memory.save(memory.snapshot.summary, recentChats)
    } catch (cause: unknown) {
      setParseError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return <section style={shell} aria-label="Recent Chats">
    <div>
      <strong>Recent Chats</strong>
      <div style={{ opacity: 0.65, fontSize: 12 }}>按时间升序保存最近几轮压缩交互，格式为 user / assistant。</div>
    </div>
    <textarea aria-label="Recent Chats JSON" spellCheck={false}
      style={{ ...editor, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 }}
      value={value} onChange={event => setValue(event.target.value)} />
    <Footer revision={memory.snapshot.revision} busy={memory.saving || running} dirty={dirty}
      error={parseError ?? memory.error} onReset={() => { setValue(canonical); setParseError(undefined) }} onSave={save} />
  </section>
}
