// Closes a Claude session the person left waiting, and the terminal tab it ran in. Orca starts the
// agent inside a shell, so when the agent exits the tab stays with a prompt: closing is two steps,
// and the tab is closed only when what is left in it is a shell at a bare prompt. Everything that
// could lose something refuses before `/exit` is sent, and what is left after it keeps the tab.
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { isPane } from './next-actions.mjs'
import { inputText, isInputEmpty, readOutputTail, suggestionFrom } from './restart.mjs'

const EXIT_WAIT_MS = 20_000
const SHELL_WAIT_MS = 1_000
const GONE_WAIT_MS = 5_000
const POLL_MS = 500
// The offers that wait for the person: a question, a form of questions, a call for permission.
const ASKS = new Set(['question', 'form', 'permission'])
const SHELLS = /^-?(zsh|bash|fish|sh|dash|ksh)$/
// A shell prompt ends in one of these. Text typed after the prompt makes the last line end in
// something else, though a line typed to end in one of them cannot be told apart.
const PROMPT_END = /[%$#>❯➜»]$/
const PS_ROW = /^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+)$/

/** Whether the last line of a terminal screen is a bare shell prompt. */
export function atBarePrompt(screen) {
  const last = screen.split('\n').map((line) => line.trimEnd()).filter(Boolean).at(-1)
  return Boolean(last) && PROMPT_END.test(last)
}

/** A process as `ps` sees it, or null once it is gone. */
export function readProcess(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,ppid=,pgid=,tpgid=,tty=,stat=,comm=', '-p', String(pid)], (error, stdout) => {
      const match = error ? null : PS_ROW.exec(stdout.trim())
      resolve(match ? { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]), tty: match[5], stat: match[6], comm: basename(match[7]) } : null)
    })
  })
}

/** The pids of the processes a process started and that still run. */
export function readChildPids(pid) {
  return new Promise((resolve) => {
    execFile('pgrep', ['-P', String(pid)], (error, stdout) => {
      resolve(error ? [] : stdout.split('\n').map((line) => Number(line.trim())).filter(Boolean))
    })
  })
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const refuse = (reason) => ({ closed: false, reason })
// The session ended, but the tab was left as it was.
const leftOpen = (reason) => ({ closed: false, exited: true, reason })

/**
 * @param readSession  resolves a session id to `{ pid, status, statusUpdatedAt }`, or null when it does not run
 * @param readTab      resolves a pid to the Orca tab of its process, or null
 * @param readOrca     resolves to what Orca says now: `{ agents, offers }`, see readWorkspaces
 * @param run          runs the Orca CLI with arguments and resolves to its JSON reply
 * @param readScreen   resolves a terminal handle to what it shows now
 * @returns a function that takes `{ sessionId, since }`, `since` being the time the person saw it
 *   start waiting, and resolves to `{ closed: true }` or `{ closed: false, reason }`, with
 *   `exited: true` when the session ended but the tab was left. The reasons: `stale` (it changed
 *   since it was shown), `no-tab`, `no-terminal`, `working`, `asking`, `draft`, `not-exited`,
 *   `shell-busy`, `shell-input` and `remains`. It throws when a step fails.
 */
export function createSessionCloser({ home, run, readSession, readTab, readOrca, readScreen, readOutput = readOutputTail, readProc = readProcess, readChildren = readChildPids, running = isRunning, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  async function until(check, ms) {
    const end = now() + ms
    while (now() < end) {
      if (await check()) return true
      await wait(POLL_MS)
    }
    return check()
  }

  async function send(handle, text, enter) {
    const args = ['terminal', 'send', '--terminal', handle, '--text', text, ...(enter ? ['--enter'] : []), '--json']
    if (!(await run(args)).result?.send?.accepted) throw new Error('the terminal did not accept the text')
  }

  const terminalsNow = async () => (await run(['terminal', 'list', '--json'])).result.terminals

  return async function close({ sessionId, since }) {
    // What was shown must still be true: a session that worked since is not left waiting.
    const session = await readSession(sessionId)
    if (!session || session.status !== 'idle' || session.statusUpdatedAt !== since) return refuse('stale')
    const tabId = await readTab(session.pid)
    if (!tabId) return refuse('no-tab')

    const { agents, offers = [] } = await readOrca()
    const inTab = agents.filter((agent) => agent.tabId === tabId)
    if (inTab.length === 0) return refuse('no-tab')
    if (inTab.some((agent) => agent.state !== 'done' || agent.background)) return refuse('working')
    // Only what waits for an answer counts; a proposal of next steps is there after every turn.
    if (offers.some((offer) => ASKS.has(offer.kind) && offer.paneKey?.split(':')[0] === tabId)) return refuse('asking')

    const terminals = await terminalsNow()
    const terminal = inTab.map((agent) => terminals.find((candidate) => isPane(candidate, agent.paneKey))).find(Boolean)
    if (!terminal) return refuse('no-terminal')
    const alone = terminals.filter((candidate) => candidate.tabId === tabId).length === 1

    const typed = inputText(await readScreen(terminal.handle))
    if (typed === null) return refuse('stale')
    const suggestion = typed && terminal.ptyId ? suggestionFrom(await readOutput(home, terminal.ptyId).catch(() => '')) : null
    if (!isInputEmpty(typed, suggestion)) return refuse('draft')

    // The shell is the parent of the session; it is found now, as it is gone from the session once that exits.
    const own = await readProc(session.pid)
    const parent = own ? await readProc(own.ppid) : null
    const shellPid = parent && SHELLS.test(parent.comm) ? parent.pid : null

    await send(terminal.handle, '/exit', true)
    if (!(await until(() => !running(session.pid), EXIT_WAIT_MS))) {
      // A dialog, such as the one for work in the background, keeps it open: leave it as it was.
      await send(terminal.handle, '\u001b', false).catch(() => {})
      return refuse('not-exited')
    }

    const listed = async () => (await terminalsNow()).some((candidate) => candidate.handle === terminal.handle)
    if (shellPid !== null) {
      await wait(SHELL_WAIT_MS)
      // Orca may close the tab itself.
      if (!(await listed())) return { closed: true }
      const shell = await readProc(shellPid)
      if (shell) {
        // Something runs in the foreground, or in the background, in what is left of the tab.
        if (shell.tpgid !== shell.pgid || (await readChildren(shellPid)).length > 0) return leftOpen('shell-busy')
        if (!atBarePrompt(await readScreen(terminal.handle))) return leftOpen('shell-input')
      }
      const closed = await run(['terminal', 'close', '--terminal', terminal.handle, ...(alone ? ['--tab'] : []), '--json'])
      if (!closed?.ok) throw new Error('could not close the tab')
    }
    return (await until(async () => !(await listed()), GONE_WAIT_MS)) ? { closed: true } : leftOpen('remains')
  }
}
