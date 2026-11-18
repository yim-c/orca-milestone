// Turns the focused workspace and the agent sessions found on disk into what the panel shows.

const MAX_SESSIONS = 3
const MAX_ROWS = 8
// A Claude session that has waited for the user this long gets a badge saying so.
const IDLE_BADGE_MS = 3 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/**
 * The whole hours a Claude session has waited for the user, or null. Only a session that has
 * waited long enough, in a tab whose agents Orca all calls done with nothing running in the
 * background, counts: Orca's state is what says it is not at work, and a session whose tab is
 * unknown cannot be matched with it.
 */
function idleHours(session, agents) {
  if (!(session.idleMs >= IDLE_BADGE_MS) || !session.tabId) return null
  const inTab = agents.filter((agent) => agent.tabId === session.tabId)
  if (inTab.length === 0 || !inTab.every((agent) => agent.state === 'done' && !agent.background)) return null
  return Math.floor(session.idleMs / HOUR_MS)
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * What the panel needs to offer closing a session that wears the badge: its id, the time it started
 * waiting, which the worker checks again when the button is pressed, and how many tasks are
 * unfinished. Only a Claude session of its own can be closed, not a team's list or another agent.
 */
function closeOf(session, idle, counts) {
  if (!idle || session.source !== 'claude' || !SESSION_ID.test(session.listId) || !Number.isFinite(session.idleAt)) return null
  return { sessionId: session.listId, since: session.idleAt, unfinished: counts.total - counts.done }
}

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
    const idle = session ? idleHours(session, agents) : null
    return {
      workspace: entry.workspace,
      path: entry.path,
      repo: entry.repo ?? null,
      focused: entry.focused,
      kind: entry.needsUser ? 'attention' : 'idle',
      working: entry.working && !entry.needsUser,
      background: entry.background && !entry.working && !entry.needsUser,
      since: entry.since,
      idle,
      close: closeOf(session, idle, counts),
      updatedAt: session?.updatedAt ?? 0,
      goal: session?.goal ?? null,
      ...counts
    }
  })
  const rank = (row) =>
    row.kind === 'attention' ? 0 : row.done < row.total ? 1 : 2
  // Those needing the user first, longest waiting first; then unfinished and then finished
  // lists, most recently updated first.
  const shown = rows
    .filter((row) => !row.focused && (row.kind === 'attention' || row.total > 0))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.kind === 'attention' ? a.since - b.since : b.updatedAt - a.updatedAt)
    )
  return {
    attention: rows.filter((row) => row.kind === 'attention').length,
    rows: shown.slice(0, MAX_ROWS),
    // How many rows the limit leaves off, so the panel can say they exist.
    more: Math.max(0, shown.length - MAX_ROWS)
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
 * @param stale true when the workspace and agents come from an earlier read, as the latest failed
 * @param othersCollapsed true when the person folded the other workspaces away
 */
export function buildModel(workspace, sessions, agents = [], offers = [], selectedTabId = null, stale = false, othersCollapsed = false) {
  const workspacePaths = [...new Set([workspace?.path, ...agents.map((agent) => agent.path)].filter(Boolean))]
  // `collapsed` is the person's choice to fold the other workspaces away; the count of those
  // needing the user stays in the heading either way.
  const others = { ...buildOthers(agents, sessions, workspacePaths), collapsed: othersCollapsed }
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
  const matching = activeTabId
    ? workspaceSessions.filter((session) => sessionTabId(session, workspace, claimed) === activeTabId)
    : workspaceSessions
  const mine = matching
    .slice(0, MAX_SESSIONS)
    .map((session) => {
      const counts = progress(session.tasks)
      const idle = idleHours(session, agents)
      return { listId: session.listId, goal: session.goal, idle, close: closeOf(session, idle, counts), ...counts }
    })
  // With a tab selected, the status is that tab's agents'; Orca names the tab of each in agentsByTab.
  const inTab = activeTabId && workspace.agentsByTab ? workspace.agentsByTab.filter((entry) => entry.tabId === activeTabId) : null
  const states = inTab ? inTab.map((entry) => entry.state) : (workspace.agentStates ?? [])
  const background = inTab ? inTab.some((entry) => entry.background) : workspace.background
  return {
    kind: mine.length > 0 ? 'sessions' : 'no-tasks',
    workspace: workspace.displayName,
    tabs: tabs.length > 1 ? tabs : [],
    selectedTabId: tabs.length > 1 ? activeTabId : null,
    stale,
    agent: states.includes('working')
      ? 'working'
      : states.includes('blocked') || states.includes('waiting')
        ? 'waiting'
        : states.length > 0
          ? background ? 'background' : 'idle'
          : 'none',
    sessions: mine,
    moreSessions: Math.max(0, matching.length - MAX_SESSIONS),
    next: nextOf(offers, workspace.path, activeTabId),
    others
  }
}
