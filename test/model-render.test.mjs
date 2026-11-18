import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildModel, isInside } from '../src/model.mjs'
import { renderBody } from '../src/render.mjs'
import { task } from './helpers.mjs'

const workspace = { path: '/work/app', displayName: 'app', agentStates: ['working'] }

test('isInside matches the root and its subfolders only', () => {
  assert.ok(isInside('/work/app', '/work/app'))
  assert.ok(isInside('/work/app/pkg', '/work/app'))
  assert.ok(!isInside('/work/app-2', '/work/app'))
})

test('buildModel keeps sessions with tasks inside the focused workspace', () => {
  const model = buildModel(workspace, [
    { listId: 'a', cwd: '/work/app/pkg', goal: 'Goal A', tasks: [task(1, 'x', 'completed'), task(2, 'y', 'pending')] },
    { listId: 'b', cwd: '/work/other', goal: 'Goal B', tasks: [task(1, 'z', 'pending')] },
    { listId: 'c', cwd: '/work/app', goal: 'Goal C', tasks: [] }
  ])
  assert.equal(model.kind, 'sessions')
  assert.equal(model.agent, 'working')
  assert.deepEqual(
    model.sessions.map((s) => [s.listId, s.done, s.total]),
    [['a', 1, 2]]
  )
})

const lists = (count) =>
  Array.from({ length: count }, (_, i) => ({ listId: `l${i}`, cwd: '/work/app', goal: `Goal ${i}`, tasks: [task(1, 'x', 'pending')] }))

test('sessions past the limit are counted and the panel says how many are left off', () => {
  const over = buildModel(workspace, lists(5))
  assert.equal(over.sessions.length, 3)
  assert.equal(over.moreSessions, 2)
  assert.ok(renderBody(over).includes('<p class="more">ほか 2 件</p>'))

  const exact = buildModel(workspace, lists(3))
  assert.equal(exact.moreSessions, 0)
  assert.ok(!renderBody(exact).includes('class="more"'))
})

test('other workspaces past the limit are counted and the panel says how many are left off', () => {
  const others = (count) => {
    const agents = Array.from({ length: count }, (_, i) => ({ workspace: `w${i}`, path: `/other/${i}`, focused: false, state: 'idle' }))
    const sessions = agents.map((agent, i) => ({ listId: `o${i}`, cwd: agent.path, goal: `Goal ${i}`, tasks: [task(1, 'x', 'pending')], updatedAt: i }))
    return buildModel(workspace, sessions, agents)
  }
  const over = others(10)
  assert.equal(over.others.rows.length, 8)
  assert.equal(over.others.more, 2)
  assert.ok(renderBody(over).includes('<p class="more">ほか 2 件</p>'))

  const exact = others(8)
  assert.equal(exact.others.more, 0)
  assert.ok(!renderBody(exact).includes('class="more"'))
})

test('the model carries the out of date mark and the header shows it only then', () => {
  assert.equal(buildModel(workspace, []).stale, false)
  const model = buildModel(workspace, [], [], [], null, true)
  assert.equal(model.stale, true)
  assert.ok(renderBody(model).includes('class="stale"'))
  assert.ok(!renderBody(buildModel(workspace, [])).includes('class="stale"'))
})

test('folding the other workspaces hides their rows but keeps the heading and the count of those needing the user', () => {
  const agents = [
    { workspace: 'w1', path: '/other/1', focused: false, state: 'waiting' },
    { workspace: 'w2', path: '/other/2', focused: false, state: 'idle' }
  ]
  const sessions = agents.map((agent, i) => ({ listId: `o${i}`, cwd: agent.path, goal: `Goal ${i}`, tasks: [task(1, 'x', 'pending')], updatedAt: i }))

  const open = renderBody(buildModel(workspace, sessions, agents))
  assert.ok(open.includes('aria-expanded="true"'))
  assert.ok(open.includes('class="rows"'))

  const model = buildModel(workspace, sessions, agents, [], null, false, true)
  assert.equal(model.others.collapsed, true)
  const folded = renderBody(model)
  assert.ok(folded.includes('aria-expanded="false"'))
  assert.ok(folded.includes('ほかのワークスペース'))
  assert.ok(folded.includes('要確認 1'), 'what needs the user is still counted')
  assert.ok(!folded.includes('class="rows"'))
  assert.ok(!folded.includes('class="row '))
})

const HOUR = 60 * 60 * 1000
const idleSession = (extra = {}) => ({ listId: 'idle', cwd: '/work/app', goal: 'Waiting', tasks: [task(1, 'x', 'pending')], tabId: 't1', idleMs: 5.5 * HOUR, updatedAt: 1, ...extra })
const doneAgent = (extra = {}) => ({ workspace: 'app', repo: null, path: '/work/app', focused: true, state: 'done', background: false, since: 1, tabId: 't1', ...extra })

test('a Claude session that has waited for the user for hours gets a badge with the whole hours, and only then', () => {
  const idle = (session, agents) => buildModel(workspace, [session], agents).sessions[0].idle
  assert.equal(idle(idleSession(), [doneAgent()]), 5)
  assert.equal(idle(idleSession({ idleMs: 3 * HOUR }), [doneAgent()]), 3, 'three hours is enough')
  assert.equal(idle(idleSession({ idleMs: 3 * HOUR - 1 }), [doneAgent()]), null, 'not yet three hours')
  assert.equal(idle(idleSession({ idleMs: undefined }), [doneAgent()]), null, 'a session with no waiting time, as a Codex one')
  assert.equal(idle(idleSession(), [doneAgent({ state: 'working' })]), null, 'Orca says it is at work')
  assert.equal(idle(idleSession(), [doneAgent({ background: true })]), null, 'work runs in the background')
  assert.equal(idle(idleSession(), [doneAgent(), doneAgent({ state: 'working' })]), null, 'another agent of the tab works')
  assert.equal(idle(idleSession(), [doneAgent({ tabId: 't2' })]), null, 'no agent of that tab')
  assert.equal(idle(idleSession({ tabId: null }), [doneAgent()]), null, 'a session whose tab is unknown cannot be matched')
  assert.equal(idle(idleSession(), []), null)
})

test('the badge shows on the session of the focused workspace and on the row of another workspace', () => {
  const focused = renderBody(buildModel(workspace, [idleSession()], [doneAgent()]))
  assert.ok(focused.includes('<span class="idle" title="入力待ちのまま5時間">待機 5時間</span>'))
  assert.ok(!renderBody(buildModel(workspace, [idleSession({ idleMs: HOUR })], [doneAgent()])).includes('class="idle"'))

  const other = idleSession({ listId: 'other', cwd: '/work/other', tabId: 't9', idleMs: 13.2 * HOUR })
  const agents = [doneAgent({ workspace: 'other', path: '/work/other', focused: false, tabId: 't9' })]
  const model = buildModel(workspace, [other], agents)
  assert.equal(model.others.rows[0].idle, 13)
  const html = renderBody(model)
  assert.equal(html.match(/待機 13時間/g).length, 1)
  assert.ok(html.indexOf('class="idle"') > html.indexOf('class="top"'), 'on the head of the row')

  const working = buildModel(workspace, [other], [{ ...agents[0], state: 'working' }])
  assert.ok(renderBody(working).includes('class="working"') && !renderBody(working).includes('class="idle"'), 'a row at work shows that, not the wait')
})

test('buildModel reports no workspace and no tasks', () => {
  assert.equal(buildModel(null, []).kind, 'no-workspace')
  const model = buildModel({ ...workspace, agentStates: [] }, [])
  assert.equal(model.kind, 'no-tasks')
  assert.equal(model.agent, 'none')
})

test('renderBody escapes text, shows progress and is deterministic', () => {
  const model = buildModel(workspace, [
    {
      listId: 'a',
      cwd: '/work/app',
      goal: 'Fix <script> injection',
      tasks: [task(1, 'Read spec', 'completed'), task(2, 'Write code', 'in_progress', { activeForm: 'Writing code' }), task(3, 'Run tests', 'pending')]
    }
  ])
  const html = renderBody(model)
  assert.ok(html.includes('Fix &lt;script&gt; injection'))
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('1 / 3'))
  assert.ok(html.includes('width:33%'))
  assert.ok(html.includes('Writing code'))
  assert.ok(html.includes('作業中'))
  assert.equal(renderBody(model), html)
})

test('other workspaces list those needing the user first, then unfinished and finished lists', () => {
  const agent = (name, state, since, extra = {}) => ({ workspace: name, repo: 'repo-x', path: `/work/${name}`, focused: false, state, since, ...extra })
  const list = (name, done, total, updatedAt, running = false) => ({
    listId: name,
    cwd: `/work/${name}/pkg`,
    goal: `Goal ${name}`,
    updatedAt,
    tasks: Array.from({ length: total }, (_, i) => task(i + 1, `t${i}`, i < done ? 'completed' : running && i === done ? 'in_progress' : 'pending'))
  })
  const lists = [list('question', 1, 2, 50), list('older', 0, 1, 10), list('newer', 2, 3, 40, true), list('finished', 1, 1, 60)]
  const model = buildModel(workspace, lists, [
    agent('question', 'waiting', 1),
    agent('question', 'working', 2),
    agent('allow', 'blocked', 5),
    agent('older', 'done', 9),
    agent('newer', 'working', 8),
    agent('finished', 'done', 8),
    agent('busy', 'working', 7),
    agent('app', 'waiting', 6, { focused: true })
  ])
  assert.equal(model.others.attention, 3)
  assert.deepEqual(
    model.others.rows.map((row) => [row.workspace, row.kind, row.done, row.total]),
    [
      ['question', 'attention', 1, 2],
      ['allow', 'attention', 0, 0],
      ['newer', 'idle', 2, 3],
      ['older', 'idle', 0, 1],
      ['finished', 'idle', 1, 1]
    ]
  )

  const html = renderBody(model)
  assert.ok(html.includes('ほかのワークスペース'))
  assert.ok(html.includes('要確認 3'))
  assert.equal(html.match(/class="badge"/g).length, 2)
  assert.ok(html.includes('width:67%'))
  assert.ok(!html.includes('busy'))
  // Only the finished row gets a check; the others keep a dot.
  assert.equal(html.match(/<span class="check">✓<\/span><span class="name">finished/g).length, 1)
  assert.equal(html.match(/class="check"/g).length, 1)
  // Only the row with a task in progress gets the orange dot.
  assert.equal(html.match(/<span class="dot running"><\/span><span class="name">newer/g).length, 1)
  assert.equal(html.match(/class="dot running"/g).length, 1)
  assert.ok(html.includes('<span class="name">question<span class="repo">repo-x</span></span>'))
  // Every row, with a list or without, opens its workspace; the path is escaped into the attribute.
  assert.equal(html.match(/role="button"/g).length, 5)
  assert.ok(html.includes('data-open="/work/allow"'))
  assert.ok(renderBody(buildModel(workspace, [], [agent('a"b', 'waiting', 1)])).includes('data-open="/work/a&quot;b"'))
  // Rows with tasks expand to their goal and tasks on hover; rows without have nothing to expand.
  assert.equal(html.match(/<div class="detail">/g).length, 4)
  assert.ok(html.includes('<div class="detail"><div class="inner"><p class="goal">Goal question</p><ol>'))
  assert.ok(html.includes('<p class="goal">Goal question</p>'))
  assert.ok(!html.includes('CLAUDE_CODE_ENABLE_TODO_TOOLS'))
  // At work: only the row with an agent working that needs nothing from the user.
  assert.deepEqual(model.others.rows.filter((row) => row.working).map((row) => row.workspace), ['newer'])
  assert.equal(html.match(/<span class="working">作業中<\/span>/g).length, 1)
  assert.equal(renderBody(model), html)
})

test('a list keeps its key while its tasks progress, and gets another with a new goal', () => {
  const keyOf = (html) => html.match(/<section data-key="([^"]*)"/)[1]
  const render = (goal, status) =>
    renderBody(buildModel(workspace, [{ listId: 'a', cwd: '/work/app', goal, tasks: [task(1, 'x', status)] }]))
  assert.equal(keyOf(render('Goal', 'pending')), keyOf(render('Goal', 'completed')))
  assert.notEqual(keyOf(render('Goal', 'pending')), keyOf(render('Other goal', 'pending')))
  assert.ok(render('"quoted" <goal>', 'pending').includes('&quot;quoted&quot; &lt;goal&gt;'))
})

test('an expanded row shows every task, and only a long list lets the pointer in', () => {
  const row = (count) => renderBody(buildModel(workspace, [
    { listId: 'x', cwd: '/work/x', goal: 'G', updatedAt: 1, tasks: Array.from({ length: count }, (_, i) => task(i + 1, `t${i}.`, 'completed')) }
  ], [{ workspace: 'x', path: '/work/x', focused: false, state: 'working', since: 1 }]))
  assert.ok(row(8).includes('t7.'))
  assert.ok(!row(8).includes('has-detail long'))
  assert.ok(row(40).includes('t39.'))
  assert.ok(row(40).includes('has-detail long'))
})

test('an agent waiting while its shells run in the background says so, here and on its row', () => {
  const tasks = [task(1, 'Run it', 'pending')]
  const focused = buildModel({ ...workspace, agentStates: ['done'], background: true }, [{ listId: 'l', cwd: '/work/app', goal: 'g', tasks }])
  assert.equal(focused.agent, 'background')
  assert.ok(renderBody(focused).includes('<span class="agent background">待機中（裏で実行中）</span>'))
  assert.equal(buildModel({ ...workspace, agentStates: ['done'] }, []).agent, 'idle')
  const other = { workspace: 'juiz', repo: null, path: '/work/juiz', focused: false, state: 'done', background: true, since: 1 }
  const model = buildModel(workspace, [{ listId: 'j', cwd: '/work/juiz', goal: 'g', tasks }], [other])
  assert.equal(model.others.rows[0].background, true)
  assert.ok(renderBody(model).includes('<span class="background">裏で実行中</span>'))
})

test('a parent workspace does not claim sessions belonging to a nested child workspace', () => {
  const parent = { path: '/Users/dev', displayName: 'dev', agentStates: ['done'] }
  const sessions = [
    { listId: 'child-list', cwd: '/Users/dev/orca/app/sub', goal: 'Child goal', updatedAt: 20, tasks: [task(1, 'child task', 'in_progress')] },
    { listId: 'parent-list', cwd: '/Users/dev/notes', goal: 'Parent goal', updatedAt: 10, tasks: [task(1, 'parent task', 'pending')] }
  ]
  const agents = [
    { workspace: 'dev', repo: null, path: '/Users/dev', focused: true, state: 'done', since: 1 },
    { workspace: 'app', repo: 'app', path: '/Users/dev/orca/app', focused: false, state: 'working', since: 2 }
  ]
  const model = buildModel(parent, sessions, agents)
  assert.deepEqual(model.sessions.map((s) => s.listId), ['parent-list'])
  assert.deepEqual(
    model.others.rows.map((r) => [r.workspace, r.done, r.total, r.goal]),
    [['app', 0, 1, 'Child goal']]
  )

  // When the child workspace is focused, the parent in others does not steal the child's session either.
  const childFocused = buildModel(
    { path: '/Users/dev/orca/app', displayName: 'app', agentStates: ['working'] },
    [sessions[0]],
    agents.map((a) => ({ ...a, focused: a.path === '/Users/dev/orca/app' }))
  )
  assert.deepEqual(childFocused.sessions.map((s) => s.listId), ['child-list'])
  assert.equal(childFocused.others.rows.length, 0)
})

test('tab bar renders when multiple tabs exist and filters sessions by tabId', () => {
  const tabbedWorkspace = {
    ...workspace,
    tabs: [
      { tabId: 'tab-1', title: 'Claude Fix' },
      { tabId: 'tab-2', title: 'Codex Test' }
    ],
    uniqueAgentTabs: { claude: 'tab-1', mcp: 'tab-2' }
  }
  const sessions = [
    { listId: 's1', cwd: '/work/app', source: 'claude', tabId: null, goal: 'Claude goal', tasks: [task(1, 'c1', 'in_progress')] },
    { listId: 's2', cwd: '/work/app', source: 'mcp', tabId: 'tab-2', goal: 'Codex goal', tasks: [task(1, 'm1', 'pending')] }
  ]

  const all = buildModel(tabbedWorkspace, sessions)
  assert.deepEqual(all.sessions.map((s) => s.listId), ['s1', 's2'])
  const allHtml = renderBody(all)
  assert.ok(allHtml.includes('<nav class="tabs"'))
  assert.ok(allHtml.includes('data-tab=""'))
  assert.ok(allHtml.includes('data-tab="tab-1"'))
  assert.ok(allHtml.includes('data-tab="tab-2"'))

  // Tab 1 uses uniqueAgentTabs.claude fallback when session.tabId is null.
  const tab1 = buildModel(tabbedWorkspace, sessions, [], [], 'tab-1')
  assert.deepEqual(tab1.sessions.map((s) => s.listId), ['s1'])
  assert.equal(tab1.selectedTabId, 'tab-1')

  // Tab 2 filters to s2.
  const tab2 = buildModel(tabbedWorkspace, sessions, [], [], 'tab-2')
  assert.deepEqual(tab2.sessions.map((s) => s.listId), ['s2'])

  // A single-tab workspace does not render the tab bar.
  const single = buildModel({ ...workspace, tabs: [{ tabId: 'tab-1', title: 'Only' }] }, sessions)
  assert.equal(single.tabs.length, 0)
  assert.ok(!renderBody(single).includes('<nav class="tabs"'))
})

test('a list without its own tab does not fall onto a tab another list already owns', () => {
  const tabbedWorkspace = {
    ...workspace,
    tabs: [
      { tabId: 'tab-1', title: 'Current' },
      { tabId: 'tab-2', title: 'Old' }
    ],
    // The old agent is not counted as a main agent, so tab-1 looks like the only Claude tab.
    uniqueAgentTabs: { claude: 'tab-1', mcp: null }
  }
  const sessions = [
    { listId: 'now', cwd: '/work/app', source: 'claude', tabId: 'tab-1', goal: 'Now', tasks: [task(1, 'a', 'in_progress')] },
    { listId: 'old', cwd: '/work/app', source: 'claude', tabId: null, goal: 'Old', tasks: [task(1, 'b', 'completed')] }
  ]
  const tab1 = buildModel(tabbedWorkspace, sessions, [], [], 'tab-1')
  assert.deepEqual(tab1.sessions.map((s) => s.listId), ['now'])
})

test('next offer follows the selected tab', () => {
  const tabbedWorkspace = {
    ...workspace,
    tabs: [
      { tabId: 'tab-1', title: 'A' },
      { tabId: 'tab-2', title: 'B' }
    ]
  }
  const offers = [
    { kind: 'next', id: 'o2', path: workspace.path, paneKey: 'tab-2:leaf' },
    { kind: 'next', id: 'o1', path: workspace.path, paneKey: 'tab-1:leaf' }
  ]
  assert.equal(buildModel(tabbedWorkspace, [], [], offers, 'tab-1').next.id, 'o1')
  assert.equal(buildModel(tabbedWorkspace, [], [], [offers[0]], 'tab-1').next, null)
  assert.equal(buildModel(tabbedWorkspace, [], [], offers).next.id, 'o2')
})

test('a list whose tab is closed is hidden, one with no known tab stays', () => {
  const open = { ...workspace, tabs: [{ tabId: 'tab-1', title: 'Open' }] }
  const sessions = [
    { listId: 'open', cwd: '/work/app', source: 'claude', tabId: 'tab-1', goal: 'Open', tasks: [task(1, 'a', 'in_progress')] },
    { listId: 'closed', cwd: '/work/app', source: 'claude', tabId: 'tab-gone', goal: 'Closed', tasks: [task(1, 'b', 'completed')] },
    { listId: 'unknown', cwd: '/work/app', source: 'claude', tabId: null, goal: 'Unknown', tasks: [task(1, 'c', 'pending')] }
  ]
  assert.deepEqual(buildModel(open, sessions).sessions.map((s) => s.listId), ['open', 'unknown'])
  // Without a tab list (Orca could not read it) nothing is hidden.
  assert.deepEqual(buildModel({ ...workspace, tabs: [] }, sessions).sessions.map((s) => s.listId), ['open', 'closed', 'unknown'])
})

test('the status follows the selected tab: its own agents only', () => {
  const tabbed = {
    ...workspace,
    agentStates: ['working', 'done'],
    background: true,
    tabs: [{ tabId: 'tab-1', title: 'A' }, { tabId: 'tab-2', title: 'B' }, { tabId: 'tab-3', title: 'Shell' }],
    agentsByTab: [
      { tabId: 'tab-1', state: 'working', background: false },
      { tabId: 'tab-2', state: 'done', background: true }
    ]
  }
  assert.equal(buildModel(tabbed, []).agent, 'working', 'all tabs: the whole workspace')
  assert.equal(buildModel(tabbed, [], [], [], 'tab-1').agent, 'working')
  assert.equal(buildModel(tabbed, [], [], [], 'tab-2').agent, 'background', 'only the tab with shells in the background')
  assert.equal(buildModel(tabbed, [], [], [], 'tab-3').agent, 'none', 'a tab without an agent')
  // Without agentsByTab the whole workspace's status stays.
  const { agentsByTab, ...plain } = tabbed
  assert.equal(buildModel(plain, [], [], [], 'tab-3').agent, 'working')
})
