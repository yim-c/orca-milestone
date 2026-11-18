// Which terminal tab Orca shows in a workspace. Orca does not tell plugins, but it saves its tab state
// to a SQLite file as the person switches tabs. Only the rows of the tab groups and the tabs of that
// workspace are read, and the file is opened read-only. Anything that goes wrong throws, and the
// caller then leaves the tab chips to the person.
import { join } from 'node:path'

/** Where Orca keeps the state of its default profile on macOS. */
export function profileStatePath(home) {
  return join(home, 'Library', 'Application Support', 'orca', 'profiles', 'local-default', 'profile-state.db')
}

async function openReadOnly(path) {
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(path, { readOnly: true })
}

// A part's key is a JSON array: the kind of part and the workspace id, `<repo id>::<path>`.
const ROWS = `select part_key, payload from profile_state_document_parts
  where domain = 'workspaceSession'
    and (part_key like '["tabGroups",%' or part_key like '["unifiedTabs",%')
    and instr(part_key, ?) > 0`

/**
 * The id of the tab Orca shows in the workspace at `worktreePath`, or null when it saved none. A
 * workspace can be split into several tab groups, each with its own selected tab; the one whose tab
 * was focused last is the one the person is in.
 */
export async function readActiveTab(dbPath, worktreePath, openDb = openReadOnly) {
  const suffix = `::${worktreePath}`
  const db = await openDb(dbPath)
  let rows
  try {
    rows = db.prepare(ROWS).all(`${suffix}"]`)
  } finally {
    db.close()
  }
  const groups = []
  const focusedAt = new Map()
  for (const { part_key: key, payload } of rows) {
    const [kind, worktreeId] = JSON.parse(key)
    if (!worktreeId?.endsWith(suffix)) continue
    const list = JSON.parse(payload)
    if (!Array.isArray(list)) continue
    if (kind === 'tabGroups') groups.push(...list)
    else for (const tab of list) focusedAt.set(tab.id, tab.lastFocusedAt ?? 0)
  }
  let active = null
  let latest = -1
  for (const group of groups) {
    if (!group.activeTabId) continue
    const at = focusedAt.get(group.activeTabId) ?? 0
    if (at > latest) {
      active = group.activeTabId
      latest = at
    }
  }
  return active
}
