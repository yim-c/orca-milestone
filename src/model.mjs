// Turns the focused workspace and the agent sessions found on disk into what the panel shows.

const MAX_SESSIONS = 3
const MAX_ROWS = 8

export function isInside(path, root) {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

function normalizeRoot(root) {
  return root.length > 1 ? root.replace(/\/+$/, '') : root
}

/**
 * Picks the most specific workspace root containing `cwd` so a parent folder workspace
 * (e.g. a home directory) does not claim sessions running in nested project workspaces.
 */
function ownerWorkspacePath(cwd, workspacePaths) {
  let best = null
  let bestLen = -1
  for (const root of workspacePaths) {
    if (!root || !isInside(cwd, root)) continue
    const len = normalizeRoot(root).length
    if (len > bestLen) {
      best = root
      bestLen = len
    }
  }
  return best
}

function progress(tasks) {
  const visible = tasks.filter((task) => task.status !== 'deleted')
  const done = visible.filter((task) => task.status === 'completed').length
  return { done, total: visible.length, tasks: visible }
}

// An agent needs the user when it asks for input or for a permission.
const NEEDS_USER = new Set(['waiting', 'blocked', 'permission'])

/**
 * The other workspaces where Claude needs the user or has a task list, each with the progress
 * of its newest list. Lists only reach here while their session runs. The focused workspace is
 * shown in full above. Whether Claude is at work flips every turn, so it shows on a row but does
 * not decide which rows show or their order, which would make them jump.
 */
function buildOthers(agents, sessions, workspacePaths) {
  const byWorkspace = new Map()
  for (const agent of agents) {
    const entry = byWorkspace.get(agent.path) ?? { ...agent, needsUser: false, working: false, background: false, since: 0 }
    if (NEEDS_USER.has(agent.state)) {
      entry.needsUser = true
      entry.since = Math.max(entry.since, agent.since ?? 0)
    }
    if (agent.state === 'working') entry.working = true
    if (agent.background) entry.background = true
    byWorkspace.set(agent.path, entry)
  }
  const rows = [...byWorkspace.values()].map((entry) => {
    const session = sessions.find(
      (s) => s.cwd && s.tasks.length > 0 && ownerWorkspacePath(s.cwd, workspacePaths) === entry.path
    )
    const counts = session ? progress(session.tasks) : { done: 0, total: 0, tasks: [] }
    return {
      workspace: entry.workspace,
      path: entry.path,
      repo: entry.repo ?? null,
      focused: entry.focused,
      kind: entry.needsUser ? 'attention' : 'idle',
      working: entry.working && !entry.needsUser,
      background: entry.background && !entry.working && !entry.needsUser,
      since: entry.since,
      updatedAt: session?.updatedAt ?? 0,
      goal: session?.goal ?? null,
      ...counts
    }
  })
  const rank = (row) =>
    row.kind === 'attention' ? 0 : row.done < row.total ? 1 : 2
  return {
    attention: rows.filter((row) => row.kind === 'attention').length,
    // Those needing the user first, longest waiting first; then unfinished and then finished
    // lists, most recently updated first.
    rows: rows
      .filter(
        (row) =>
          !row.focused &&
          (row.kind === 'attention' || row.total > 0)
      )
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (a.kind === 'attention' ? a.since - b.since : b.updatedAt - a.updatedAt)
      )
      .slice(0, MAX_ROWS)
  }
}

// `claimed` holds the tabs that another session already owns by an explicit mapping; a session
// without its own tab must not fall back onto them (it is an older list, not that tab's agent).
function sessionTabId(session, workspace, claimed = new Set()) {
  if (session.tabId) return session.tabId
  const fallback = session.source === 'mcp' ? workspace.uniqueAgentTabs?.mcp : workspace.uniqueAgentTabs?.claude
  return fallback && !claimed.has(fallback) ? fallback : null
}

/**
 * What the focused workspace offers. With a tab selected, only that tab's agent may offer. With
 * several agents and no tab selected, the one whose turn ended last, so the card shown is the newest.
 */
function nextOf(offers, path, activeTabId) {
  const here = offers.filter(
    (offer) => offer.path === path && (!activeTabId || offer.paneKey?.split(':')[0] === activeTabId)
  )
  return here.reduce((newest, offer) => (!newest || (offer.since ?? 0) > (newest.since ?? 0) ? offer : newest), null)
}

/**
 * @param workspace { path, displayName, agentStates, background, tabs, uniqueAgentTabs } of the focused workspace, or null
 * @param sessions  [{ listId, cwd, tabId, source, goal, tasks, updatedAt }] of every workspace, newest first
 * @param agents    [{ workspace, repo, path, focused, state, background, since }] Orca runs, one per Claude or Codex agent
 * @param offers    [{ kind, id, path, ... }] what agents offer to choose from, see next-actions.mjs
 * @param selectedTabId optional Orca tabId to filter the focused workspace's sessions
 */
export function buildModel(workspace, sessions, agents = [], offers = [], selectedTabId = null) {
  const workspacePaths = [...new Set([workspace?.path, ...agents.map((agent) => agent.path)].filter(Boolean))]
  const others = buildOthers(agents, sessions, workspacePaths)
  if (!workspace) return { kind: 'no-workspace', others }
  const tabs = workspace.tabs ?? []
  const activeTabId = selectedTabId && tabs.some((tab) => tab.tabId === selectedTabId) ? selectedTabId : null
  const workspaceSessions = sessions
    .filter((session) => session.cwd && ownerWorkspacePath(session.cwd, workspacePaths) === workspace.path)
    .filter((session) => session.tasks.length > 0)
    // A list whose tab is known but no longer open belongs to an agent left running after its
    // tab was closed. A list with no known tab stays, as there is nothing to tell it by.
    .filter((session) => tabs.length === 0 || !session.tabId || tabs.some((tab) => tab.tabId === session.tabId))
  const claimed = new Set(workspaceSessions.map((session) => session.tabId).filter(Boolean))
  const mine = (activeTabId
    ? workspaceSessions.filter((session) => sessionTabId(session, workspace, claimed) === activeTabId)
    : workspaceSessions
  )
    .slice(0, MAX_SESSIONS)
    .map((session) => ({ listId: session.listId, goal: session.goal, ...progress(session.tasks) }))
  const states = workspace.agentStates ?? []
  return {
    kind: mine.length > 0 ? 'sessions' : 'no-tasks',
    workspace: workspace.displayName,
    tabs: tabs.length > 1 ? tabs : [],
    selectedTabId: tabs.length > 1 ? activeTabId : null,
    agent: states.includes('working')
      ? 'working'
      : states.includes('blocked') || states.includes('waiting')
        ? 'waiting'
        : states.length > 0
          ? workspace.background ? 'background' : 'idle'
          : 'none',
    sessions: mine,
    next: nextOf(offers, workspace.path, activeTabId),
    others
  }
}
