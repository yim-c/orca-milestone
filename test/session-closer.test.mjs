import assert from 'node:assert/strict'
import { test } from 'node:test'
import { atBarePrompt, createSessionCloser } from '../src/session-closer.mjs'

const RULE = '─'.repeat(20)
const claudeScreen = (typed = '') => `${RULE}\n❯ ${typed}\n${RULE}\n  ⏵⏵ bypass permissions on`
const shellScreen = (line = 'me@host app %') => `Last login: today\n${line}`
// What Claude Code paints for its gray suggestion in the input box.
const suggestionOutput = (text) => `\x1b[H\r\x1b[2C\x1b[3B\x1b[2m${text}\x1b[22m\x1b[4;1H\x1b[4;3H`

/**
 * A session that waits in a tab of its own, in a shell. `change` sets what differs; the test then
 * reads what the closer asked of Orca from `calls`.
 */
function harness(change = {}) {
  const env = {
    session: { pid: 100, status: 'idle', statusUpdatedAt: 5000 },
    tab: 'tab-1',
    agents: [{ tabId: 'tab-1', paneKey: 'tab-1:leaf', state: 'done', background: false }],
    offers: [],
    terminals: [{ handle: 'h1', tabId: 'tab-1', leafId: 'leaf', ptyId: 'pty-1' }],
    claudeScreen: claudeScreen(),
    shellScreen: shellScreen(),
    output: '',
    procs: {
      100: { pid: 100, ppid: 50, pgid: 100, tpgid: 100, tty: 'ttys1', stat: 'R+', comm: 'claude' },
      50: { pid: 50, ppid: 40, pgid: 50, tpgid: 50, tty: 'ttys1', stat: 'S+', comm: 'zsh' }
    },
    children: [],
    exitWorks: true,
    accept: true,
    closeOk: true,
    closeEndsTab: true,
    tabGoneOnExit: false,
    shellGone: false,
    ...change
  }
  const calls = []
  let exited = false
  let closed = false
  let clock = 0
  const run = async (args) => {
    calls.push(args.join(' '))
    if (args[1] === 'list') {
      const gone = closed || (exited && env.tabGoneOnExit)
      return { ok: true, result: { terminals: gone ? env.terminals.filter((terminal) => terminal.handle !== 'h1') : env.terminals } }
    }
    if (args[1] === 'send') {
      if (args.includes('/exit') && env.exitWorks) exited = true
      return { ok: true, result: { send: { accepted: env.accept } } }
    }
    if (args[1] === 'close') {
      if (env.closeEndsTab) closed = true
      return { ok: env.closeOk, result: { close: {} } }
    }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  const close = createSessionCloser({
    home: '/home',
    run,
    readSession: async () => (env.session ? { sessionId: 's1', cwd: '/work/app', ...env.session } : null),
    readTab: async () => env.tab,
    readOrca: async () => ({ agents: env.agents, offers: env.offers }),
    readScreen: async () => (exited ? env.shellScreen : env.claudeScreen),
    readOutput: async () => env.output,
    readProc: async (pid) => {
      calls.push(`proc ${pid}`)
      if (pid === 100 && exited) return null
      if (pid === 50 && exited && env.shellGone) return null
      return env.procs[pid] ?? null
    },
    readChildren: async () => env.children,
    running: (pid) => !(pid === 100 && exited),
    wait: async (ms) => {
      clock += ms
    },
    now: () => clock
  })
  return { close: () => close({ sessionId: 's1', since: 5000 }), calls }
}

const sent = (calls) => calls.some((call) => call.includes('terminal send'))
const closedTab = (calls) => calls.some((call) => call.includes('terminal close'))

test('a session at rest is exited, and then its tab is closed when only a shell at a bare prompt is left', async () => {
  const { close, calls } = harness()
  assert.deepEqual(await close(), { closed: true })
  const exit = calls.indexOf('terminal send --terminal h1 --text /exit --enter --json')
  const closing = calls.indexOf('terminal close --terminal h1 --tab --json')
  assert.ok(exit >= 0 && closing > exit, 'the tab is closed after the exit')
  assert.ok(calls.indexOf('proc 50') >= 0 && calls.indexOf('proc 50') < exit, 'the shell is found before the session exits')
  assert.ok(!calls.some((call) => call.includes('\u001b')), 'no Escape was needed')
})

test('only the pane is closed when the tab holds other terminals', async () => {
  const { close, calls } = harness({
    terminals: [
      { handle: 'h1', tabId: 'tab-1', leafId: 'leaf', ptyId: 'pty-1' },
      { handle: 'h2', tabId: 'tab-1', leafId: 'other', ptyId: 'pty-2' }
    ]
  })
  assert.deepEqual(await close(), { closed: true })
  assert.ok(calls.includes('terminal close --terminal h1 --json'))
  assert.ok(!calls.some((call) => call.includes('--tab')))
})

test('a tab that Orca closes by itself is not closed again', async () => {
  const { close, calls } = harness({ tabGoneOnExit: true })
  assert.deepEqual(await close(), { closed: true })
  assert.ok(!closedTab(calls))
})

test('a proposal of next steps, or what another tab asks, does not keep a session at rest from closing', async () => {
  const proposal = harness({ offers: [{ paneKey: 'tab-1:leaf', kind: 'proposal' }] })
  assert.deepEqual(await proposal.close(), { closed: true })
  assert.ok(sent(proposal.calls) && closedTab(proposal.calls))

  const other = harness({ offers: [{ paneKey: 'tab-2:leaf', kind: 'question' }] })
  assert.deepEqual(await other.close(), { closed: true }, 'a question in another tab')
})

test('a session that did not start in a shell leaves the tab to Orca, and says so when it stays', async () => {
  const noShell = { 50: { pid: 50, ppid: 40, pgid: 50, tpgid: 50, tty: 'ttys1', stat: 'Ss', comm: 'login' } }
  const procs = (extra) => ({ 100: { pid: 100, ppid: 50, pgid: 100, tpgid: 100, tty: 'ttys1', stat: 'R+', comm: 'claude' }, ...extra })
  const gone = harness({ procs: procs(noShell), tabGoneOnExit: true })
  assert.deepEqual(await gone.close(), { closed: true })
  assert.ok(!closedTab(gone.calls))

  const stays = harness({ procs: procs(noShell) })
  assert.deepEqual(await stays.close(), { closed: false, exited: true, reason: 'remains' })
  assert.ok(!closedTab(stays.calls), 'the plugin does not close a tab it does not know holds only a shell')
})

test('a suggestion in the input box is not text the person wrote', async () => {
  const { close } = harness({ claudeScreen: claudeScreen('Try this next'), output: suggestionOutput('Try this next') })
  assert.deepEqual(await close(), { closed: true })
})

// Everything that refuses does so before `/exit` is sent, so nothing was changed.
const REFUSALS = [
  ['the session does not run any more', { session: null }, 'stale'],
  ['the session is at work', { session: { pid: 100, status: 'busy', statusUpdatedAt: 5000 } }, 'stale'],
  ['the session waited again since it was shown', { session: { pid: 100, status: 'idle', statusUpdatedAt: 9000 } }, 'stale'],
  ['the screen has no input box', { claudeScreen: 'a dialog asks something' }, 'stale'],
  ['its tab is not known', { tab: null }, 'no-tab'],
  ['Orca has no agent in the tab', { agents: [] }, 'no-tab'],
  ['Orca calls the agent working', { agents: [{ tabId: 'tab-1', paneKey: 'tab-1:leaf', state: 'working', background: false }] }, 'working'],
  ['work runs in the background', { agents: [{ tabId: 'tab-1', paneKey: 'tab-1:leaf', state: 'done', background: true }] }, 'working'],
  ['another agent of the tab works', { agents: [{ tabId: 'tab-1', paneKey: 'tab-1:leaf', state: 'done', background: false }, { tabId: 'tab-1', paneKey: 'tab-1:two', state: 'working', background: false }] }, 'working'],
  ['it asks a question', { offers: [{ paneKey: 'tab-1:leaf', kind: 'question' }] }, 'asking'],
  ['it asks a form of questions', { offers: [{ paneKey: 'tab-1:leaf', kind: 'form' }] }, 'asking'],
  ['it waits for a permission', { offers: [{ paneKey: 'tab-1:leaf', kind: 'permission' }] }, 'asking'],
  ['no terminal has its pane', { terminals: [{ handle: 'h1', tabId: 'tab-1', leafId: 'elsewhere', ptyId: 'pty-1' }] }, 'no-terminal'],
  ['text is typed in the input box', { claudeScreen: claudeScreen('half written') }, 'draft']
]

for (const [name, change, reason] of REFUSALS) {
  test(`nothing is closed and nothing is sent when ${name}`, async () => {
    const { close, calls } = harness(change)
    assert.deepEqual(await close(), { closed: false, reason })
    assert.ok(!sent(calls) && !closedTab(calls))
  })
}

test('a session that does not exit is left as it was, with Escape sent for any dialog', async () => {
  const { close, calls } = harness({ exitWorks: false })
  assert.deepEqual(await close(), { closed: false, reason: 'not-exited' })
  assert.ok(calls.includes('terminal send --terminal h1 --text /exit --enter --json'))
  assert.ok(calls.includes('terminal send --terminal h1 --text \u001b --json'))
  assert.ok(!closedTab(calls))
})

test('the tab is left open, the session already ended, when the shell is busy or has text typed', async () => {
  const busy = { 50: { pid: 50, ppid: 40, pgid: 50, tpgid: 999, tty: 'ttys1', stat: 'S', comm: 'zsh' } }
  const procs = (shell) => ({ 100: { pid: 100, ppid: 50, pgid: 100, tpgid: 100, tty: 'ttys1', stat: 'R+', comm: 'claude' }, ...shell })

  const foreground = harness({ procs: procs(busy) })
  assert.deepEqual(await foreground.close(), { closed: false, exited: true, reason: 'shell-busy' })
  assert.ok(!closedTab(foreground.calls), 'a job runs in the foreground')

  const background = harness({ children: [4242] })
  assert.deepEqual(await background.close(), { closed: false, exited: true, reason: 'shell-busy' })
  assert.ok(!closedTab(background.calls), 'a job runs in the background')

  const typed = harness({ shellScreen: shellScreen('me@host app % rm -rf build') })
  assert.deepEqual(await typed.close(), { closed: false, exited: true, reason: 'shell-input' })
  assert.ok(!closedTab(typed.calls), 'text is typed after the prompt')
})

test('a shell that is gone from a tab that is still listed leaves nothing to check', async () => {
  const { close, calls } = harness({ shellGone: true })
  assert.deepEqual(await close(), { closed: true })
  assert.ok(closedTab(calls))
})

test('the closer throws when the terminal does not take /exit, or the tab cannot be closed', async () => {
  await assert.rejects(harness({ accept: false }).close(), /did not accept/)
  const failing = harness({ closeOk: false })
  await assert.rejects(failing.close(), /could not close the tab/)
})

test('a bare prompt is a last line that ends in a prompt character', () => {
  for (const screen of ['me@host app %', 'me@host app $ ', 'root#', '❯', 'a\n\nme@host %\n\n']) assert.equal(atBarePrompt(screen), true, screen)
  for (const screen of ['me@host app % ls', 'echo "hi"', '', '   \n\n']) assert.equal(atBarePrompt(screen), false, screen)
})
