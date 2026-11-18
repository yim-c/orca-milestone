import assert from 'node:assert/strict'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { readSessionTabs, tabOfList } from '../src/claude-sessions.mjs'
import { createMilestoneWorker } from '../src/milestone-worker.mjs'
import { SESSION_A, SESSION_B, makeHome, markRunning, task, taskCalls, writeTasks, writeTranscript } from './helpers.mjs'

function fakeOrca() {
  const posts = []
  return {
    log: () => {},
    panels: { post: (event, payload) => posts.push({ event, payload }) },
    posts,
    shown: () => posts.at(-1).payload.html
  }
}

test('refresh posts the focused workspace tasks to the panel', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Build milestones' })
  await writeTasks(home, SESSION_A, [task(1, 'Read spec', 'completed'), task(2, 'Write code', 'in_progress')])
  await writeTranscript(home, SESSION_B, { cwd: '/work/other', prompt: 'Something else' })
  await writeTasks(home, SESSION_B, [task(1, 'Unrelated', 'pending')])

  let cliCalls = 0
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => {
      cliCalls += 1
      return { active: { path: '/work/app', displayName: 'app', agentStates: ['working'] }, agents: [] }
    },
    watchDir: () => {}
  })

  await worker.refresh(true)
  const first = orca.shown()
  assert.ok(first.includes('Build milestones'))
  assert.ok(first.includes('1 / 2'))
  assert.ok(!first.includes('Unrelated'))

  await writeTasks(home, SESSION_A, [task(2, 'Write code', 'completed'), task(3, 'Run tests', 'in_progress')])
  await worker.refresh()
  const second = orca.shown()
  assert.ok(second.includes('2 / 3'))
  assert.equal(cliCalls, 1, 'a task change alone does not ask the CLI again')
})

test('a list Claude deletes after finishing stays on screen as done; a cleared unfinished one goes', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Finish me' })
  await writeTranscript(home, SESSION_B, { cwd: '/work/app', prompt: 'Abandon me' })
  const doneDir = await writeTasks(home, SESSION_A, [task(1, 'Only step', 'completed')])
  const clearedDir = await writeTasks(home, SESSION_B, [task(1, 'Half step', 'in_progress')])
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  await rm(join(doneDir, '1.json'))
  await rm(join(clearedDir, '1.json'))
  await worker.refresh()
  const html = orca.shown()
  assert.ok(html.includes('Finish me'))
  assert.ok(html.includes('1 / 1'))
  assert.ok(!html.includes('Abandon me'))
})

test('a team lead\'s list, named session-<id prefix>, shows under its workspace', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Team goal' })
  await writeTasks(home, 'session-11111111', [task(1, 'Plan', 'completed'), task(2, 'Build', 'pending')])
  await writeTasks(home, 'session-22222222', [])
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  const html = orca.shown()
  assert.ok(html.includes('Team goal'))
  assert.ok(html.includes('1 / 2'))
})

test('the heading follows the goal of the current tasks, not the first prompt of the session', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'First goal' })
  const transcript = join(home, '.claude', 'projects', '-work-app', `${SESSION_A}.jsonl`)
  await appendFile(
    transcript,
    [
      { type: 'user', cwd: '/work/app', message: { role: 'user', content: 'Second goal' } },
      { type: 'assistant', cwd: '/work/app', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'Step two' } }] } }
    ].map((line) => JSON.stringify(line)).join('\n') + '\n'
  )
  await writeTasks(home, SESSION_A, [task(1, 'Step two', 'pending')])
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  let html = orca.shown()
  assert.ok(html.includes('Second goal'))
  assert.ok(!html.includes('First goal'))

  await writeTasks(home, SESSION_A, [
    task(1, 'Step two', 'completed'),
    task(2, 'Step three', 'pending', { metadata: { goal: 'Goal Claude wrote' } })
  ])
  await worker.refresh()
  html = orca.shown()
  assert.ok(html.includes('Goal Claude wrote'))
  assert.ok(html.includes('0 / 1'), 'tasks of the earlier goal are left out')
  assert.ok(!html.includes('Step two'))
})

test('a finished list comes back from the transcript after a restart, and goes with its session', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, {
    cwd: '/work/done',
    prompt: 'Do it',
    running: false,
    extra: taskCalls(
      [{ subject: 'Old step' }, { subject: 'New step', metadata: { goal: 'Second goal' } }],
      [{ taskId: '1', status: 'completed' }, { taskId: '2', status: 'completed' }]
    )
  })
  const running = await markRunning(home, SESSION_A)
  // Claude deleted the files of the finished list; only its high-water mark is left.
  const dir = await writeTasks(home, SESSION_A, [])
  await writeFile(join(dir, '.highwatermark'), '2')
  const options = {
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({
      active: { path: '/work/app', displayName: 'app', agentStates: [] },
      agents: [{ workspace: 'done', path: '/work/done', focused: false, state: 'done', since: 0 }]
    }),
    watchDir: () => {}
  }
  const worker = createMilestoneWorker(options)
  await worker.refresh(true)
  let html = orca.shown()
  assert.ok(html.includes('<span class="name">done</span>'))
  // Only the tasks of the newest goal show.
  assert.ok(html.includes('1 / 1'))
  assert.ok(html.includes('Second goal'))

  await rm(running)
  await worker.refresh()
  html = orca.shown()
  assert.ok(!html.includes('<span class="name">done</span>'), 'gone once the session ends')
})

test('a failing CLI leaves the panel showing that no workspace is known', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  const logs = []
  orca.log = (line) => logs.push(line)
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => {
      throw new Error('runtime unavailable')
    },
    watchDir: () => {}
  })
  await worker.refresh(true)
  assert.ok(orca.shown().includes('ワークスペースを開くと'))
  assert.match(logs.join('\n'), /runtime unavailable/)
})

test('a failed read keeps the last workspace on screen marked as out of date until a read succeeds', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  let fail = false
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => {
      if (fail) throw new Error('runtime unavailable')
      return { active: { path: '/work/app', displayName: 'app', agentStates: ['working'] }, agents: [] }
    },
    watchDir: () => {}
  })
  await worker.refresh(true)
  assert.ok(!orca.shown().includes('class="stale"'))

  fail = true
  await worker.refresh(true)
  assert.ok(orca.shown().includes('<h1>app</h1>'), 'the last workspace stays')
  assert.ok(orca.shown().includes('class="stale"'))

  fail = false
  await worker.refresh(true)
  assert.ok(!orca.shown().includes('class="stale"'), 'a successful read clears the mark')
})

test('a refresh that does not ask Orca does not change the out of date mark', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  let fail = false
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => {
      if (fail) throw new Error('runtime unavailable')
      return { active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }
    },
    watchDir: () => {}
  })
  await worker.refresh(true)
  fail = true
  await worker.refresh(true)
  await worker.refresh()
  assert.ok(orca.shown().includes('class="stale"'))
})

/** A worker whose workspace has two terminal tabs and whose selected tab, as Orca saved it, is set by the test. */
function followWorker({ orca, home, shown, clock = { now: 1000 }, calls = [] }) {
  return createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    now: () => clock.now,
    readOrca: async () => ({
      active: { path: '/work/app', displayName: 'app', agentStates: [], tabs: [{ tabId: 'tab-1', title: 'One' }, { tabId: 'tab-2', title: 'Two' }], uniqueAgentTabs: {} },
      agents: []
    }),
    readActive: async (path) => {
      calls.push(path)
      if (shown.error) throw new Error(shown.error)
      return shown.tab
    },
    runCli: async (_cli, args) =>
      args[1] === 'list'
        ? { ok: true, result: { terminals: [{ handle: 'h1', tabId: 'tab-1', leafId: 'a' }, { handle: 'h2', tabId: 'tab-2', leafId: 'b' }] } }
        : { ok: true, result: {} },
    watchDir: () => {}
  })
}

const activeChip = (html) => html.match(/class="tab active" data-tab="([^"]*)"/)?.[1]

test('the chips follow the tab Orca shows, from the first refresh on', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  const calls = []
  const shown = { tab: 'tab-2' }
  const worker = followWorker({ orca, home, shown, calls })
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => realSetInterval(...args).unref()
  try {
    await worker.refresh(true)
    assert.equal(activeChip(orca.shown()), 'tab-2')
    assert.deepEqual(calls, ['/work/app'])

    shown.tab = 'tab-1'
    await worker.followNow()
    assert.equal(activeChip(orca.shown()), 'tab-1')

    const posts = orca.posts.length
    await worker.followNow()
    assert.equal(orca.posts.length, posts, 'a look that finds the same tab posts nothing')
  } finally {
    globalThis.setInterval = realSetInterval
  }
})

test('following logs one line each time the selection moves to another tab, and nothing otherwise', async () => {
  const home = await makeHome()
  const logs = []
  const orca = { ...fakeOrca(), log: (line) => logs.push(line) }
  const shown = { tab: 'tab-2' }
  const worker = followWorker({ orca, home, shown })
  const lines = () => logs.filter((line) => line.includes('following tab'))

  await worker.refresh(true)
  assert.deepEqual(lines(), ['milestone: following tab tab-2'])

  await worker.followNow()
  await worker.refresh(true)
  assert.equal(lines().length, 1, 'the same tab again logs nothing')

  shown.tab = 'tab-1'
  await worker.followNow()
  assert.deepEqual(lines(), ['milestone: following tab tab-2', 'milestone: following tab tab-1'])

  await worker.selectTab('tab-2')
  shown.tab = 'tab-2'
  await worker.followNow()
  assert.equal(lines().length, 2, 'a chip pressed by hand is not following')

  shown.tab = 'browser-tab'
  await worker.followNow()
  assert.equal(lines().length, 2, 'a tab that is not a terminal tab is not followed')

  await worker.selectTab(null)
  shown.tab = 'tab-1'
  await worker.followNow()
  assert.equal(lines().length, 2, 'not following logs nothing')
})

test('the chip for all tabs stops following, and a chip for one tab follows again once Orca shows it', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  const clock = { now: 1000 }
  const shown = { tab: 'tab-2' }
  const worker = followWorker({ orca, home, shown, clock })
  await worker.refresh(true)
  assert.equal(activeChip(orca.shown()), 'tab-2')

  await worker.selectTab(null)
  assert.equal(activeChip(orca.shown()), '', 'all tabs')
  shown.tab = 'tab-1'
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), '', 'not following, so Orca switching tabs changes nothing')

  // Orca still has tab-1 saved right after the press: the pressed tab stays until it is shown or the grace is over.
  shown.tab = 'tab-1'
  await worker.selectTab('tab-2')
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), 'tab-2', 'the press is not undone by the old state')
  shown.tab = 'tab-2'
  await worker.followNow()
  shown.tab = 'tab-1'
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), 'tab-1', 'once Orca showed the pressed tab, it is followed again')

  // If Orca never shows the pressed tab, the chip goes back to the tab that is shown.
  await worker.selectTab('tab-2')
  shown.tab = 'tab-1'
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), 'tab-2')
  clock.now += 5000
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), 'tab-1')
})

test('a tab that is not a terminal tab of the workspace leaves the selection as it is', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  const shown = { tab: 'tab-2' }
  const worker = followWorker({ orca, home, shown })
  await worker.refresh(true)
  shown.tab = 'browser-tab'
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), 'tab-2')
  shown.tab = null
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), 'tab-2')
})

test('when the saved state cannot be read the chips stay as they are, with one log line until it works again', async () => {
  const home = await makeHome()
  const logs = []
  const orca = { ...fakeOrca(), log: (line) => logs.push(line) }
  const shown = { error: 'unable to open database file' }
  const worker = followWorker({ orca, home, shown })
  await worker.refresh(true)
  await worker.followNow()
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), '', 'no tab is selected on its own: all tabs stay')
  assert.equal(logs.filter((line) => line.includes('could not read the selected tab')).length, 1)
  assert.ok(logs[0].includes('unable to open database file'))

  await worker.selectTab('tab-2')
  assert.equal(activeChip(orca.shown()), 'tab-2', 'the chips still work by hand')

  shown.error = null
  shown.tab = 'tab-1'
  await worker.followNow()
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), 'tab-2', 'the pressed tab holds until its grace is over')

  shown.tab = 'tab-2'
  await worker.followNow()
  shown.tab = 'tab-1'
  await worker.followNow()
  assert.equal(activeChip(orca.shown()), 'tab-1', 'following works again')

  shown.error = 'unable to open database file'
  await worker.followNow()
  assert.equal(logs.filter((line) => line.includes('could not read the selected tab')).length, 2, 'a new failure is logged again')
})

test('the follow timer runs only while the chips follow and the workspace has several tabs', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  const started = []
  const cleared = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args)
    started.push(timer)
    return timer
  }
  globalThis.clearInterval = (timer) => {
    cleared.push(timer)
    return realClearInterval(timer)
  }
  try {
    const worker = followWorker({ orca, home, shown: { tab: 'tab-1' } })
    await worker.refresh(true)
    await worker.refresh(true)
    assert.equal(started.length, 1, 'one timer, however often it refreshes')
    assert.equal(cleared.length, 0)

    await worker.selectTab(null)
    assert.deepEqual(cleared, started, 'all tabs stops it')
    await worker.selectTab('tab-1')
    assert.equal(started.length, 2, 'a chip for one tab starts it again')

    const single = createMilestoneWorker({
      orca: fakeOrca(),
      home,
      cli: 'orca',
      readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [], tabs: [{ tabId: 'tab-1', title: 'One' }] }, agents: [] }),
      readActive: async () => assert.fail('one tab has nothing to follow'),
      watchDir: () => {}
    })
    await single.refresh(true)
    assert.equal(started.length, 2, 'no timer for a workspace with one tab')
  } finally {
    started.forEach(realClearInterval)
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

test('a session that has waited for hours is badged from its session file and Orca\'s state, and the hours grow with time', async () => {
  const HOUR = 60 * 60 * 1000
  const home = await makeHome()
  const orca = fakeOrca()
  const clock = { now: 100 * HOUR }
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Old goal' })
  await writeTasks(home, SESSION_A, [task(1, 'Step', 'pending')])
  // The file Claude keeps for a running session: idle since 4.5 hours ago.
  await writeFile(join(home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION_A, status: 'idle', statusUpdatedAt: clock.now - 4.5 * HOUR }))
  let state = 'done'
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    now: () => clock.now,
    readTab: async () => 'tab-1',
    readOrca: async () => ({
      active: { path: '/work/app', displayName: 'app', agentStates: [state], tabs: [{ tabId: 'tab-1', title: 'One' }], uniqueAgentTabs: {} },
      agents: [{ workspace: 'app', repo: null, path: '/work/app', focused: true, state, background: false, since: 1, tabId: 'tab-1' }]
    }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  assert.ok(orca.shown().includes('待機 4時間'))

  clock.now += HOUR
  await worker.refresh(true)
  assert.ok(orca.shown().includes('待機 5時間'), 'an hour later')

  state = 'working'
  await worker.refresh(true)
  assert.ok(!orca.shown().includes('class="idle"'), 'Orca says it is at work')
})

/** What the worker needs to close a session: its file, the pane in Orca and the processes around it, all faked. */
async function closableWorker({ overrides = {}, since = 5000 } = {}) {
  const home = await makeHome()
  const orca = { ...fakeOrca(), logs: [] }
  orca.log = (line) => orca.logs.push(line)
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true })
  await writeFile(join(home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION_A, cwd: '/work/app', status: 'idle', statusUpdatedAt: since }))
  const calls = []
  const state = { exited: false, closed: false, clock: 0 }
  const rule = '─'.repeat(20)
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readTab: async () => 'tab-1',
    readOrca: async () => ({
      active: { path: '/work/app', displayName: 'app', agentStates: ['done'], tabs: [{ tabId: 'tab-1', title: 'One' }], uniqueAgentTabs: {} },
      agents: [{ workspace: 'app', repo: null, path: '/work/app', focused: true, state: 'done', background: false, since: 1, tabId: 'tab-1', paneKey: 'tab-1:leaf' }],
      offers: []
    }),
    runCli: async (_cli, args) => {
      calls.push(args.join(' '))
      if (args[1] === 'list') return { ok: true, result: { terminals: state.closed ? [] : [{ handle: 'h1', tabId: 'tab-1', leafId: 'leaf', ptyId: 'pty-1' }] } }
      if (args[1] === 'send') {
        if (args.includes('/exit')) state.exited = true
        return { ok: true, result: { send: { accepted: true } } }
      }
      if (args[1] === 'close') {
        state.closed = true
        return { ok: true, result: { close: {} } }
      }
      return { ok: true, result: {} }
    },
    closeDeps: {
      readScreen: async () => (state.exited ? 'me@host app %' : `${rule}\n❯ \n${rule}`),
      readOutput: async () => '',
      readProc: async (pid) => {
        if (pid === process.pid) return state.exited ? null : { pid, ppid: 50, pgid: pid, tpgid: pid, tty: 't', stat: 'R+', comm: 'claude' }
        return { pid: 50, ppid: 1, pgid: 50, tpgid: 50, tty: 't', stat: 'S+', comm: 'zsh' }
      },
      readChildren: async () => [],
      running: (pid) => !(pid === process.pid && state.exited),
      wait: async (ms) => {
        state.clock += ms
      },
      now: () => state.clock,
      ...overrides
    },
    watchDir: () => {}
  })
  return { worker, orca, calls }
}

test('closing a session through the worker checks it again, exits it and closes its tab', async () => {
  const { worker, calls } = await closableWorker()
  assert.deepEqual(await worker.closeSession({ sessionId: SESSION_A, since: 1 }), { closed: false, reason: 'stale' }, 'it started waiting again since it was shown')
  assert.deepEqual(calls, [], 'nothing was asked of Orca')

  assert.deepEqual(await worker.closeSession({ sessionId: SESSION_A, since: 5000 }), { closed: true })
  assert.ok(calls.indexOf('terminal send --terminal h1 --text /exit --enter --json') < calls.indexOf('terminal close --terminal h1 --tab --json'))
})

test('a close request names a session and the time it was shown, and one session is closed once at a time', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { worker } = await closableWorker({ overrides: { readSession: async () => { await gate; return null } } })
  for (const bad of [undefined, null, {}, { sessionId: 7, since: 1 }, { sessionId: SESSION_A, since: 'x' }]) {
    assert.deepEqual(await worker.closeSession(bad), { closed: false, reason: 'stale' })
  }
  const first = worker.closeSession({ sessionId: SESSION_A, since: 5000 })
  assert.deepEqual(await worker.closeSession({ sessionId: SESSION_A, since: 5000 }), { closed: false, reason: 'busy' })
  release()
  assert.deepEqual(await first, { closed: false, reason: 'stale' })
  assert.deepEqual(await worker.closeSession({ sessionId: SESSION_A, since: 5000 }), { closed: false, reason: 'stale' }, 'it can be asked again once it is done')
})

test('a step that fails is logged and reported as a failure, and the session can be asked again', async () => {
  let fail = true
  const { worker, orca } = await closableWorker({ overrides: { readSession: async () => { if (fail) throw new Error('boom'); return null } } })
  assert.deepEqual(await worker.closeSession({ sessionId: SESSION_A, since: 5000 }), { closed: false, reason: 'failed' })
  assert.ok(orca.logs.some((line) => line.includes('could not close the session: boom')))
  fail = false
  assert.deepEqual(await worker.closeSession({ sessionId: SESSION_A, since: 5000 }), { closed: false, reason: 'stale' })
})

test('toggling the other workspaces folds them away and shows them again, and a refresh keeps the choice', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_B, { cwd: '/work/other', prompt: 'Other goal' })
  await writeTasks(home, SESSION_B, [task(1, 'Other step', 'pending')])
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({
      active: { path: '/work/app', displayName: 'app', agentStates: [] },
      agents: [{ workspace: 'other', path: '/work/other', focused: false, state: 'idle' }]
    }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  assert.ok(orca.shown().includes('class="rows"'))
  assert.ok(orca.shown().includes('aria-expanded="true"'))

  assert.deepEqual(worker.toggleOthers(), { collapsed: true })
  assert.ok(!orca.shown().includes('class="rows"'))
  assert.ok(orca.shown().includes('aria-expanded="false"'))

  await worker.refresh(true)
  assert.ok(!orca.shown().includes('class="rows"'), 'a refresh does not unfold them')

  assert.deepEqual(worker.toggleOthers(), { collapsed: false })
  assert.ok(orca.shown().includes('class="rows"'))
})

test('a refresh posts only a real change, at once', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'App goal' })
  await writeTasks(home, SESSION_A, [task(1, 'One', 'pending'), task(2, 'Two', 'pending')])
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }),
    watchDir: () => {}
  })
  await worker.refresh(true)
  assert.equal(orca.posts.length, 1)
  assert.equal(orca.posts[0].event, 'view.changed')

  await worker.refresh(true)
  assert.equal(orca.posts.length, 1, 'the same view is not posted again')

  await writeTasks(home, SESSION_A, [task(1, 'One', 'completed')])
  await worker.refresh()
  assert.equal(orca.posts.length, 2)
  assert.ok(orca.shown().includes('1 / 2'))
})

test('view answers with what the panel should show, even when Orca could not be read', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  const timers = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args)
    timers.push(timer)
    return timer
  }
  try {
    const worker = createMilestoneWorker({
      orca,
      home,
      cli: 'orca',
      readOrca: async () => {
        throw new Error('runtime unavailable')
      },
      watchDir: () => {}
    })
    const { html } = await worker.view()
    assert.ok(html.includes('ワークスペースを開くと'))
    assert.equal(timers.length, 1, 'one slow sync; the rest is driven by events')
  } finally {
    globalThis.setInterval = realSetInterval
    timers.forEach(clearInterval)
  }
})

test('a start that failed is tried again by the next caller, and a start that worked is not repeated', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  const timers = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args)
    timers.push(timer)
    return timer
  }
  try {
    let watched = 0
    const worker = createMilestoneWorker({
      orca,
      home,
      cli: 'orca',
      readOrca: async () => ({ active: { path: '/work/app', displayName: 'app', agentStates: [] }, agents: [] }),
      watchDir: () => {
        watched += 1
        if (watched === 1) throw new Error('watch failed')
      }
    })
    await assert.rejects(worker.start(), /watch failed/)
    const { html } = await worker.view()
    assert.ok(html.includes('<h1>app</h1>'), 'the second caller starts the worker')
    const watchedAfterStart = watched
    await worker.start()
    assert.equal(watched, watchedAfterStart, 'a worker that started is not started again')
  } finally {
    globalThis.setInterval = realSetInterval
    timers.forEach(clearInterval)
  }
})

test('an agent event asks Orca again only when that pane changed state', async () => {
  const home = await makeHome()
  let asked = 0
  const worker = createMilestoneWorker({
    orca: fakeOrca(),
    home,
    cli: 'orca',
    readOrca: async () => {
      asked += 1
      return { active: null, agents: [] }
    },
    watchDir: () => {}
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

  worker.agentChanged({ paneKey: 'a', state: 'working' })
  await settle()
  assert.equal(asked, 1)

  worker.agentChanged({ paneKey: 'a', state: 'working' })
  await settle()
  assert.equal(asked, 1, 'the same state again')

  worker.agentChanged({ paneKey: 'a', state: 'waiting' })
  worker.agentChanged({ paneKey: 'b', state: 'working' })
  await settle()
  assert.equal(asked, 2, 'changes close together make one refresh')

  worker.agentChanged({ paneKey: 'b', state: 'working', mainAgent: { state: 'waiting' } })
  await settle()
  assert.equal(asked, 3, 'the main agent of a pane counts too')
})

test('openWorkspace opens the listed workspace at the path, and only logs a miss or a failure', async () => {
  const orca = fakeOrca()
  const logs = []
  orca.log = (line) => logs.push(line)
  const calls = []
  let fail = false
  orca.host = {
    call: async (method, params) => {
      calls.push([method, params])
      if (fail) throw new Error('refused')
      return {
        workspaces: [
          { id: 'identity:a', path: '/work/a' },
          { id: 'identity:b', path: '/work/b' }
        ]
      }
    }
  }
  const worker = createMilestoneWorker({ orca, home: await makeHome(), cli: 'orca', watchDir: () => {} })

  assert.deepEqual(await worker.openWorkspace('/work/b'), { opened: true })
  assert.deepEqual(calls.at(-1), ['workspace.open', { workspaceId: 'identity:b' }])

  calls.length = 0
  assert.deepEqual(await worker.openWorkspace('/work/gone'), { opened: false })
  assert.deepEqual(calls.map(([method]) => method), ['workspace.list'])
  assert.match(logs.join('\n'), /no workspace to open at \/work\/gone/)

  fail = true
  assert.deepEqual(await worker.openWorkspace('/work/a'), { opened: false })
  assert.match(logs.join('\n'), /could not open the workspace: refused/)
})

// Registers a session as running with its own pid (the test process or its parent), as two real ones differ.
async function runAs(home, sessionId, pid, startedAt) {
  const dir = join(home, '.claude', 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, startedAt }))
}

test('readSessionTabs asks each process once, drops the gone ones and finds a team lead by its prefix', async () => {
  const home = await makeHome()
  const root = join(home, '.claude', 'sessions')
  await runAs(home, SESSION_A, process.pid, 1)
  await runAs(home, SESSION_B, process.ppid, 2)
  const asked = []
  const cache = new Map()
  const readTab = async (pid) => {
    asked.push(pid)
    return pid === process.pid ? 'tab-a' : null
  }

  const tabs = await readSessionTabs(root, cache, readTab)
  assert.deepEqual([...tabs], [[SESSION_A, 'tab-a']], 'a process outside Orca has no tab')
  await readSessionTabs(root, cache, readTab)
  assert.equal(asked.length, 2, 'the second read is answered from the cache')

  assert.equal(tabOfList(SESSION_A, tabs), 'tab-a')
  assert.equal(tabOfList(`session-${SESSION_A.slice(0, 8)}`, tabs), 'tab-a')
  assert.equal(tabOfList(SESSION_B, tabs), null)

  await rm(join(root, `${process.ppid}.json`))
  await readSessionTabs(root, cache, readTab)
  assert.equal(cache.size, 1, 'a process that ended leaves the cache')
})

test('a list keeps its tab from the process environment with no agent event, so a closed tab hides it', async () => {
  const home = await makeHome()
  const orca = fakeOrca()
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Now', running: false })
  await writeTasks(home, SESSION_A, [task(1, 'Current step', 'in_progress')])
  await writeTranscript(home, SESSION_B, { cwd: '/work/app', prompt: 'Left behind', running: false })
  await writeTasks(home, SESSION_B, [task(1, 'Old step', 'completed')])
  await runAs(home, SESSION_A, process.pid, 1)
  await runAs(home, SESSION_B, process.ppid, 2)

  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readTab: async (pid) => (pid === process.pid ? 'tab-1' : 'tab-closed'),
    readOrca: async () => ({
      active: { path: '/work/app', displayName: 'app', agentStates: ['idle'], tabs: [{ tabId: 'tab-1', title: 'Now' }, { tabId: 'tab-2', title: 'Shell' }], uniqueAgentTabs: { claude: null, mcp: null } },
      agents: []
    }),
    watchDir: () => {}
  })

  await worker.refresh(true)
  const shown = orca.shown()
  assert.ok(shown.includes('Current step'))
  assert.ok(!shown.includes('Old step'), 'the list of the closed tab is hidden without any agent event')
})

test('pressing a tab chip filters the panel and brings that tab to the front in Orca', async () => {
  const home = await makeHome()
  const logs = []
  const orca = { ...fakeOrca(), log: (line) => logs.push(line) }
  const calls = []
  let failing = false
  const terminals = [
    { handle: 'h1', tabId: 'tab-1', leafId: 'a' },
    { handle: 'h2', tabId: 'tab-2', leafId: 'b' }
  ]
  const worker = createMilestoneWorker({
    orca,
    home,
    cli: 'orca',
    readOrca: async () => ({
      active: { path: '/work/app', displayName: 'app', agentStates: ['idle'], tabs: [{ tabId: 'tab-1', title: 'A' }, { tabId: 'tab-2', title: 'B' }], uniqueAgentTabs: {} },
      agents: []
    }),
    runCli: async (_cli, args) => {
      calls.push(args.join(' '))
      if (failing) throw new Error('orca is gone')
      return args[1] === 'list' ? { ok: true, result: { terminals } } : { ok: true, result: {} }
    },
    watchDir: () => {}
  })
  await worker.refresh(true)

  assert.deepEqual(await worker.selectTab('tab-2'), { selectedTabId: 'tab-2' })
  assert.deepEqual(calls, ['terminal list --json', 'terminal switch --terminal h2 --json'])

  calls.length = 0
  assert.deepEqual(await worker.selectTab(null), { selectedTabId: null })
  assert.deepEqual(calls, [], 'showing all tabs switches nothing')

  assert.deepEqual(await worker.selectTab('tab-gone'), { selectedTabId: null })
  assert.deepEqual(calls, [], 'a tab that is not open switches nothing')

  terminals.length = 0
  assert.deepEqual(await worker.selectTab('tab-1'), { selectedTabId: 'tab-1' })
  assert.deepEqual(calls, ['terminal list --json'], 'a tab with no terminal is not switched to')

  failing = true
  assert.deepEqual(await worker.selectTab('tab-2'), { selectedTabId: 'tab-2' }, 'the filter stays when Orca fails')
  assert.ok(logs.some((line) => line.includes('could not show the tab: orca is gone')))
})
