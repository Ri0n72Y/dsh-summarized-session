export { SummaryPanel, RecentChatsPanel } from './memory-panel.tsx'
export type { MemoryPanelProps } from './memory-panel.tsx'
export type { EditableMemory, WorkingMemoryClient } from './model.ts'
export { parseRecentChatsEditor, recentChatsEditorValue } from './model.ts'
export { isMemoryCommitEvent, responseFromCommit, responseFromSnapshot } from './response.ts'

/**
 * The alpha.1 DSH slot/RPC adapter belongs here once checked against the
 * installed declarations. Keeping it out of the view model prevents an
 * unverified client contract from leaking through the implementation.
 */
