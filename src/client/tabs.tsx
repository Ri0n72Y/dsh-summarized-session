import { createElement, useEffect, useMemo, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ChatNodeViewProps, PresentationInjected } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionMemorySnapshot } from '../types.ts'
import { RecentChatsPanel, SummaryPanel } from './memory-panel.tsx'
import { projectAssistantBlocks } from './response.ts'
import { RpcWorkingMemoryClient } from './transport.ts'

export const SUMMARY_KIND = 'summarized-working-memory.summary'
export const RECENT_KIND = 'summarized-working-memory.recent-chats'
const SUMMARY_ID = 'dsh-summarized-session/summary'
const RECENT_ID = 'dsh-summarized-session/recent-chats'

type TabProps = PropsRuntime<'sidebar.right.pane.tab'>
type HeaderProps = PropsRuntime<'conversation.session.header.actions'>
type AssistantProps = ChatNodeViewProps<'assistant-step'> & InjectFace<PresentationInjected>

function useRemoteMemory(ctx: Context, props: TabProps): {
  client: RpcWorkingMemoryClient
  initial?: SessionMemorySnapshot
  error?: string
  running: boolean
} {
  const client = useMemo(
    () => new RpcWorkingMemoryClient(ctx.connection.rpc, props.sessionId),
    [ctx, props.sessionId],
  )
  const running = props.useSession(value => value.running)
  const session = props.useSession(value => value)
  const [initial, setInitial] = useState<SessionMemorySnapshot>()
  const [error, setError] = useState<string>()
  useEffect(() => { client.setRunning(running) }, [client, running])
  useEffect(() => {
    let active = true
    void client.refresh().then(value => {
      if (active) { setInitial(value); setError(undefined) }
    }, cause => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [client, session])
  return { client, initial, error, running }
}

function MemoryBody({ ctx, mode, ...props }: TabProps & { ctx: Context; mode: 'summary' | 'recent' }): ReactNode {
  const remote = useRemoteMemory(ctx, props)
  if (remote.error !== undefined) return <div role="alert" style={{ padding: 12 }}>{remote.error}</div>
  if (remote.initial === undefined) return <div style={{ padding: 12, opacity: 0.65 }}>正在读取工作记忆…</div>
  if (!remote.initial.enabled) return <div style={{ padding: 12 }}>此 Session 未启用 Summarized Working Memory。</div>
  return mode === 'summary'
    ? <SummaryPanel client={remote.client} initial={remote.initial} running={remote.running} />
    : <RecentChatsPanel client={remote.client} initial={remote.initial} running={remote.running} />
}

function MemoryActions({ ctx, ...props }: HeaderProps & { ctx: Context }): ReactNode {
  const [enabled, setEnabled] = useState(false)
  const session = props.useSession(value => value)
  useEffect(() => {
    let active = true
    const client = new RpcWorkingMemoryClient(ctx.connection.rpc, props.sessionId)
    void client.read().then(value => { if (active) setEnabled(value.enabled) }, () => { if (active) setEnabled(false) })
    return () => { active = false }
  }, [ctx, props.sessionId, session])
  if (!enabled) return null
  return <div style={{ display: 'flex', gap: 6 }}>
    <button type="button" onClick={() => { ctx.sidebarRight.openTab(SUMMARY_KIND) }}>Summary</button>
    <button type="button" onClick={() => { ctx.sidebarRight.openTab(RECENT_KIND) }}>Recent Chats</button>
  </div>
}

function responseRenderer(ctx: Context, Native: ComponentType<AssistantProps>): ComponentType<AssistantProps> {
  return function SummarizedAssistant(props: AssistantProps): ReactNode {
    const [enabled, setEnabled] = useState<boolean>()
    const session = props.useSession(value => value)
    useEffect(() => {
      let active = true
      const client = new RpcWorkingMemoryClient(ctx.connection.rpc, props.sessionId)
      void client.read().then(value => { if (active) setEnabled(value.enabled) }, () => { if (active) setEnabled(false) })
      return () => { active = false }
    }, [props.sessionId, session])
    // Do not briefly expose the raw JSON envelope while the Session capability
    // check is in flight. Ordinary Sessions resume their native renderer as
    // soon as the Host reports `enabled: false`.
    if (enabled === undefined) return null
    if (!enabled || props.node.data.status === 'running') return createElement(Native, props)
    const blocks = projectAssistantBlocks(props.node.data.blocks)
    if (blocks === props.node.data.blocks) return createElement(Native, props)
    return createElement(Native, {
      ...props,
      node: { ...props.node, data: { ...props.node.data, blocks } },
    })
  }
}

export function registerClientSurfaces(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SUMMARY_ID, kind: SUMMARY_KIND, title: () => 'Summary', keepMounted: true,
  }), 'summarized-working-memory: Summary tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: RECENT_ID, kind: RECENT_KIND, title: () => 'Recent Chats', keepMounted: true,
  }), 'summarized-working-memory: Recent Chats tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', function* () {
    yield ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: SUMMARY_ID },
      (props: TabProps) => <MemoryBody {...props} ctx={ctx} mode="summary" />,
    )
    yield ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: RECENT_ID },
      (props: TabProps) => <MemoryBody {...props} ctx={ctx} mode="recent" />,
    )
  }), 'summarized-working-memory: tab bodies')

  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
    { name: 'conversation.session.header.actions', id: 'summarized-working-memory', order: 40 },
    (props: HeaderProps) => <MemoryActions {...props} ctx={ctx} />,
  )), 'summarized-working-memory: header actions')

  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => {
    const nativeEntry = ctx.slots.entries('conversation.chat.node')
      .find(entry => entry.options.key === 'assistant-step')
    const native = nativeEntry?.component
    if (typeof native !== 'function' && (typeof native !== 'object' || native === null)) {
      throw new Error('summarized-working-memory: native assistant renderer is unavailable')
    }
    const nativeInject = nativeEntry?.inject as unknown as
      ((sessionId: AssistantProps['sessionId']) => PresentationInjected) | undefined
    const nativeLocale = nativeEntry?.locale as 'chat' | undefined
    return ctx.slots.register(
      {
        name: 'conversation.chat.node',
        key: 'assistant-step',
        // Keyed slots are shadowed by the lowest priority. Keep the native
        // entry registered so unloading this plugin restores it automatically.
        priority: -100,
        ...(nativeLocale === undefined ? {} : { locale: nativeLocale }),
        ...(nativeInject === undefined ? {} : { inject: nativeInject }),
      },
      responseRenderer(ctx, native as ComponentType<AssistantProps>),
    )
  }), 'summarized-working-memory: response renderer')
}
