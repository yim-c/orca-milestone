import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { profileStatePath, readActiveTab } from '../src/active-tab.mjs'

const WORKTREE = 'repo-1::/work/app'

/** A state file shaped like Orca's: parts of the workspace session, one row per kind and workspace. */
async function makeState(parts) {
  const dir = await mkdtemp(join(tmpdir(), 'milestone-state-'))
  const path = join(dir, 'profile-state.db')
  const db = new DatabaseSync(path)
  db.exec('create table profile_state_document_parts (domain TEXT, part_key TEXT, ordinal INTEGER, payload TEXT, content_hash TEXT)')
  const insert = db.prepare('insert into profile_state_document_parts values (?, ?, 0, ?, null)')
  for (const [domain, kind, worktreeId, payload] of parts) {
    insert.run(domain, JSON.stringify([kind, worktreeId]), JSON.stringify(payload))
  }
  db.close()
  return path
}

const group = (id, activeTabId) => ({ id, activeTabId, tabOrder: [activeTabId] })
const tabs = (...pairs) => pairs.map(([id, lastFocusedAt]) => ({ id, lastFocusedAt }))

test('the saved profile state sits in the default profile of Orca on macOS', () => {
  assert.equal(profileStatePath('/Users/me'), '/Users/me/Library/Application Support/orca/profiles/local-default/profile-state.db')
})

test('the selected tab of the workspace is read, and another workspace is not mistaken for it', async () => {
  const path = await makeState([
    ['workspaceSession', 'tabGroups', WORKTREE, [group('g1', 'tab-2')]],
    ['workspaceSession', 'unifiedTabs', WORKTREE, tabs(['tab-1', 1], ['tab-2', 2])],
    ['workspaceSession', 'tabGroups', 'repo-2::/work/other/app', [group('g2', 'tab-9')]],
    ['workspaceSession', 'tabGroups', 'repo-3::/work/app-2', [group('g3', 'tab-8')]]
  ])
  assert.equal(await readActiveTab(path, '/work/app'), 'tab-2')
  assert.equal(await readActiveTab(path, '/work/other/app'), 'tab-9')
  assert.equal(await readActiveTab(path, '/work/missing'), null)
})

test('with several tab groups, the group whose selected tab was focused last is the one the person is in', async () => {
  const path = await makeState([
    ['workspaceSession', 'tabGroups', WORKTREE, [group('left', 'tab-1'), group('right', 'tab-5')]],
    ['workspaceSession', 'unifiedTabs', WORKTREE, tabs(['tab-1', 100], ['tab-5', 200], ['tab-6', 900])]
  ])
  assert.equal(await readActiveTab(path, '/work/app'), 'tab-5', 'tab-6 is focused last but is not a group\'s selected tab')

  const swapped = await makeState([
    ['workspaceSession', 'tabGroups', WORKTREE, [group('left', 'tab-1'), group('right', 'tab-5')]],
    ['workspaceSession', 'unifiedTabs', WORKTREE, tabs(['tab-1', 300], ['tab-5', 200])]
  ])
  assert.equal(await readActiveTab(swapped, '/work/app'), 'tab-1')
})

test('only the rows of the tab groups and the tabs are read, and the file is opened read-only', async () => {
  const path = await makeState([
    ['workspaceSession', 'tabGroups', WORKTREE, [group('g1', 'tab-1')]],
    ['workspaceSession', 'unifiedTabs', WORKTREE, tabs(['tab-1', 1])],
    ['workspaceSession', 'activeTabIdByWorktree', WORKTREE, 'tab-other'],
    ['settings', 'tabGroups', WORKTREE, [group('g9', 'tab-settings')]]
  ])
  const statements = []
  const opened = []
  const openDb = async (file) => {
    opened.push(file)
    const db = new DatabaseSync(file, { readOnly: true })
    return {
      prepare: (sql) => {
        statements.push(sql)
        return db.prepare(sql)
      },
      close: () => db.close()
    }
  }
  assert.equal(await readActiveTab(path, '/work/app', openDb), 'tab-1')
  assert.deepEqual(opened, [path])
  assert.equal(statements.length, 1)
  assert.ok(statements[0].includes('tabGroups') && statements[0].includes('unifiedTabs'))
  assert.ok(statements[0].includes("domain = 'workspaceSession'"))
  assert.ok(!statements[0].includes('activeTabIdByWorktree'))
})

test('a file that cannot be opened rejects, so the caller can leave the chips to the person', async () => {
  await assert.rejects(readActiveTab(join(tmpdir(), 'milestone-no-such-dir', 'profile-state.db'), '/work/app'))
})
