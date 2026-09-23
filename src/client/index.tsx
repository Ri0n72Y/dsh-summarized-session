export { SummaryPanel, RecentChatsPanel } from './memory-panel.tsx'
export type { MemoryPanelProps } from './memory-panel.tsx'
export type { EditableMemory, WorkingMemoryClient } from './model.ts'
export { parseRecentChatsEditor, recentChatsEditorValue } from './model.ts'
export { projectAssistantBlocks } from './response.ts'
export { RpcWorkingMemoryClient } from './transport.ts'
export { RECENT_KIND, SUMMARY_KIND } from './tabs.tsx'

import type { Context } from '@deepseek-ai/cordis'
import { registerClientSurfaces } from './tabs.tsx'

export const inject = ['connection', 'sidebarRight', 'sidebarRightTabs', 'slots']

export function apply(ctx: Context): void {
  registerClientSurfaces(ctx)
}
