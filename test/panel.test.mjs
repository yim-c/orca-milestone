import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { scrollExpandedRows } from '../panel/expand.mjs'
import { closeOnPress, CONFIRM_MS, NOTE_MS } from '../panel/close.mjs'
import { openOnPress } from '../panel/open.mjs'
import { toggleOthersOnPress } from '../panel/others.mjs'
import { patchChildren } from '../panel/patch.mjs'
import { refreshOnPress } from '../panel/refresh.mjs'
import { selectTabOnPress } from '../panel/tabs.mjs'
import { buildModel } from '../src/model.mjs'
import { renderBody } from '../src/render.mjs'
import { task } from './helpers.mjs'

const panelDir = join(import.meta.dirname, '..', 'panel')

function body(html = '') {
  const { document } = new JSDOM('<!doctype html><body></body>').window
  document.body.innerHTML = html
  return document.body
}

test('patchChildren keeps the elements that stay and updates what differs', () => {
  const root = body('<main class="a"><p>old</p></main><div class="others"><ol><li>one</li></ol></div>')
  const [main, others] = root.children
  const list = others.querySelector('ol')
  const item = list.querySelector('li')

  patchChildren(root, '<main class="b"><p>new</p></main><div class="others"><ol><li>uno</li><li>two</li></ol></div>')

  assert.equal(root.children[0], main, 'the element is the same one')
  assert.equal(main.className, 'b')
  assert.equal(main.textContent, 'new')
  assert.equal(root.querySelector('ol'), list)
  assert.equal(list.children[0], item)
  assert.equal(item.textContent, 'uno')
  assert.equal(list.children[1].textContent, 'two')
})

test('patchChildren replaces other tags, drops extras and removes old attributes', () => {
  const root = body('<p id="x" class="y">text</p><span>a</span><span>b</span>')
  patchChildren(root, '<div class="y">text</div><span>a</span>')
  assert.equal(root.innerHTML, '<div class="y">text</div><span>a</span>')

  patchChildren(root, '<div>text</div>')
  assert.equal(root.innerHTML, '<div>text</div>')
})

test('patchChildren replaces an element whose data-key differs, and keeps one whose key is the same', () => {
  const root = body('<section data-key="a"><p>0 / 2</p></section>')
  const section = root.children[0]

  patchChildren(root, '<section data-key="a"><p>1 / 2</p></section>')
  assert.equal(root.children[0], section)
  assert.equal(section.textContent, '1 / 2')

  patchChildren(root, '<section data-key="b"><p>0 / 5</p></section>')
  assert.notEqual(root.children[0], section)
  assert.equal(root.children[0].textContent, '0 / 5')
})

test('patchChildren ends with exactly the wanted markup, from an empty panel too', () => {
  const root = body()
  const html = '<main><header><h1>app</h1></header></main><div class="others"><h2>x</h2></div>'
  patchChildren(root, html)
  assert.equal(root.innerHTML, html)
})

test('the panel document loads its stylesheet and script', async () => {
  const html = await readFile(join(panelDir, 'index.html'), 'utf8')
  assert.ok(html.includes('href="style.css"'))
  assert.ok(html.includes('src="main.mjs"'))
  await readFile(join(panelDir, 'style.css'), 'utf8')
  await readFile(join(panelDir, 'main.mjs'), 'utf8')
})

test('pressing a row head opens its workspace, also after a patch, but its detail does not', () => {
  const row = (path) =>
    `<li class="row"><div class="head" role="button" tabindex="0" data-open="${path}"><span class="name">app</span></div><div class="detail"><p>goal</p></div></li>`
  const root = body(`<ol>${row('/work/a')}</ol>`)
  const opened = []
  openOnPress(root, (path) => opened.push(path))
  const { MouseEvent, KeyboardEvent } = root.ownerDocument.defaultView
  const click = (selector) => root.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }))

  click('.name')
  assert.deepEqual(opened, ['/work/a'])

  click('.detail p')
  assert.equal(opened.length, 1)

  patchChildren(root, `<ol>${row('/work/b')}</ol>`)
  click('.head')
  assert.equal(opened.at(-1), '/work/b')

  const press = (key) => root.querySelector('.head').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  press('Enter')
  press(' ')
  press('a')
  assert.equal(opened.length, 4)
})

test('the wheel over a head scrolls its tasks, and opening starts at what is left', () => {
  const root = body(
    '<li class="row"><div class="head"><span class="name">app</span></div><div class="detail"><div class="inner"><ol><li class="completed">a</li><li class="pending">b</li></ol></div></div></li><li class="row"><div class="head"><span class="name">bare</span></div></li>'
  )
  scrollExpandedRows(root)
  const { MouseEvent, WheelEvent } = root.ownerDocument.defaultView
  const inner = root.querySelector('.inner')
  root.querySelector('li.pending').getBoundingClientRect = () => ({ top: 300 })
  inner.getBoundingClientRect = () => ({ top: 100 })

  const enter = (from) => root.querySelector('.name').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }))
  enter(root.ownerDocument.body)
  assert.equal(inner.scrollTop, 176, 'the task left, with a little of what came before it')

  enter(inner)
  assert.equal(inner.scrollTop, 176, 'coming back from its own tasks does not jump')

  root.querySelector('.name').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))
  assert.equal(inner.scrollTop, 216)

  root.querySelectorAll('.name')[1].dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))
  assert.equal(inner.scrollTop, 216, 'a row with no tasks has nothing to scroll')
})

test('a pressed card is sent once, and a refusal says why and lets the cards be pressed again', async () => {
  const { sendOnPress } = await import('../panel/next.mjs')
  const root = body('<main><div class="next"><ol class="actions"><li><button data-next="o1" data-index="0">A</button></li><li><button data-next="o1" data-index="1">B</button></li></ol></div></main>')
  const requests = []
  let answer = { sent: false, reason: 'typing' }
  sendOnPress(root, async (request) => {
    requests.push(request)
    return answer
  })
  const [a, b] = root.querySelectorAll('[data-next]')
  b.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(requests, [{ offer: 'o1', index: 1 }])
  assert.match(root.querySelector('.status').textContent, /書きかけ/)
  assert.ok(!root.querySelector('.next').classList.contains('busy'))

  answer = { sent: true }
  a.click()
  a.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(requests.length, 2, 'a second click while one is on its way is ignored')
  assert.ok(a.classList.contains('sending'))
  assert.ok(root.querySelector('.next').classList.contains('busy'))
})

test('a card that just came in the place of the answered one takes no presses for a moment', async () => {
  const { sendOnPress } = await import('../panel/next.mjs')
  const { patchChildren } = await import('../panel/patch.mjs')
  const cards = (offer) => `<main><div class="next" data-key="next\n${offer}"><ol class="actions"><li><button data-next="${offer}" data-index="0">許可</button></li><li><button data-next="${offer}" data-index="1">拒否</button></li></ol></div></main>`
  const root = body('')
  let time = 0
  const timers = []
  const requests = []
  const presses = sendOnPress(root, async (request) => {
    requests.push(request)
    return { sent: true }
  }, { now: () => time, settleMs: 1500, later: (run) => timers.push(run) })
  const show = (offer) => {
    patchChildren(root, cards(offer))
    presses.restore()
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  show('first')
  assert.ok(root.querySelector('.next').classList.contains('settling'))
  root.querySelector('[data-next]').click()
  await flush()
  assert.deepEqual(requests, [], 'a card is not pressed before it can be read')

  time = 1500
  timers.splice(0).forEach((run) => run())
  assert.ok(!root.querySelector('.next').classList.contains('settling'))
  root.querySelector('[data-next]').click()
  await flush()
  assert.deepEqual(requests, [{ offer: 'first', index: 0 }])

  time = 2000
  show('second')
  assert.ok(root.querySelector('.next').classList.contains('settling'), 'the mark survives the patch')
  root.querySelector('[data-next]').click()
  await flush()
  assert.equal(requests.length, 1, 'a quick second click does not answer the next one')

  time = 2400
  show('second')
  assert.ok(root.querySelector('.next').classList.contains('settling'), 'another patch does not restart or lose the wait')
  time = 3500
  timers.splice(0).forEach((run) => run())
  root.querySelectorAll('[data-next]')[1].click()
  await flush()
  assert.deepEqual(requests[1], { offer: 'second', index: 1 })
})

test('pressing a tab pill selects that tab or clears the filter for all', () => {
  const root = body('<nav class="tabs"><button class="tab active" data-tab="">すべて</button><button class="tab" data-tab="tab-2">Tab 2</button></nav>')
  const selected = []
  selectTabOnPress(root, (tabId) => selected.push(tabId))
  root.querySelector('[data-tab="tab-2"]').click()
  root.querySelector('[data-tab=""]').click()
  assert.deepEqual(selected, ['tab-2', null])
})

test('pressing the heading of the other workspaces asks to fold them, and nothing else does', () => {
  const root = body('<div class="others"><h2><button type="button" class="fold" data-others-toggle aria-expanded="true"><span class="chev">▾</span>ほか</button></h2><ol class="rows"><li class="row">w</li></ol></div>')
  let toggled = 0
  toggleOthersOnPress(root, () => { toggled += 1 })
  root.querySelector('.rows li').click()
  assert.equal(toggled, 0)
  root.querySelector('.chev').click()
  root.querySelector('[data-others-toggle]').click()
  assert.equal(toggled, 2)
})

test('folding the other workspaces patches their rows away and back, keeping the heading button in place', () => {
  const agents = [{ workspace: 'w1', path: '/other/1', focused: false, state: 'idle' }]
  const sessions = [{ listId: 'o1', cwd: '/other/1', goal: 'Goal', tasks: [task(1, 'x', 'pending')], updatedAt: 1 }]
  const workspace = { path: '/work/app', displayName: 'app', agentStates: [] }
  const root = body()
  patchChildren(root, renderBody(buildModel(workspace, sessions, agents)))
  const fold = root.querySelector('.fold')
  assert.ok(root.querySelector('.rows'))

  patchChildren(root, renderBody(buildModel(workspace, sessions, agents, [], null, false, true)))
  assert.equal(root.querySelector('.rows'), null)
  assert.equal(root.querySelector('.fold'), fold, 'the same button, so its arrow can turn')
  assert.equal(fold.getAttribute('aria-expanded'), 'false')

  patchChildren(root, renderBody(buildModel(workspace, sessions, agents)))
  assert.ok(root.querySelector('.rows'))
  assert.equal(fold.getAttribute('aria-expanded'), 'true')
})

/** Timers the test runs by hand, in the order they were set. */
function timers() {
  const pending = []
  return {
    later: (fn, ms) => {
      const timer = { fn, ms, live: true }
      pending.push(timer)
      return timer
    },
    cancel: (timer) => {
      if (timer) timer.live = false
    },
    run: (ms) => pending.filter((timer) => timer.live && timer.ms === ms).forEach((timer) => {
      timer.live = false
      timer.fn()
    }),
    count: (ms) => pending.filter((timer) => timer.live && timer.ms === ms).length
  }
}

const closeButton = (id, since = 5000, unfinished = 3) => `<button type="button" class="close-session" data-close="${id}" data-since="${since}" data-unfinished="${unfinished}">閉じる</button>`
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('closing takes two presses: the first asks, the second sends what the worker checks again', async () => {
  const root = body(closeButton('s1'))
  const clock = timers()
  const requests = []
  closeOnPress(root, async (request) => {
    requests.push(request)
    return { closed: true }
  }, clock)
  const button = root.querySelector('[data-close]')

  button.click()
  assert.deepEqual(requests, [], 'the first press only asks')
  assert.equal(button.textContent, '本当に閉じる？（未完了 3）')
  assert.ok(button.classList.contains('armed'))

  button.click()
  assert.deepEqual(requests, [{ sessionId: 's1', since: 5000 }])
  assert.equal(button.textContent, '閉じています…')
  assert.ok(button.disabled)
  await settle()
  assert.equal(button.textContent, '閉じる')
  assert.ok(!button.disabled)
  assert.equal(root.ownerDocument.querySelector('.note').textContent, 'セッションを閉じました。')
})

test('without unfinished tasks the question does not count them', () => {
  const root = body(closeButton('s1', 5000, 0))
  closeOnPress(root, async () => ({ closed: true }), timers())
  root.querySelector('[data-close]').click()
  assert.equal(root.querySelector('[data-close]').textContent, '本当に閉じる？')
})

test('the question goes back by itself, and then needs two presses again', () => {
  const root = body(closeButton('s1'))
  const clock = timers()
  const requests = []
  closeOnPress(root, async (request) => requests.push(request), clock)
  const button = root.querySelector('[data-close]')
  button.click()
  clock.run(CONFIRM_MS)
  assert.equal(button.textContent, '閉じる')
  assert.ok(!button.classList.contains('armed'))
  button.click()
  assert.deepEqual(requests, [], 'a press after the question went away only asks again')
  assert.equal(button.textContent, '本当に閉じる？（未完了 3）')
})

test('pressing another close button asks about that one and drops the first question', () => {
  const root = body(`${closeButton('s1')}${closeButton('s2', 6000, 1)}`)
  const requests = []
  closeOnPress(root, async (request) => requests.push(request), timers())
  const [first, second] = root.querySelectorAll('[data-close]')
  first.click()
  second.click()
  assert.equal(first.textContent, '閉じる')
  assert.equal(second.textContent, '本当に閉じる？（未完了 1）')
  assert.deepEqual(requests, [])
  second.click()
  assert.deepEqual(requests, [{ sessionId: 's2', since: 6000 }])
})

test('while a session is being closed another press sends nothing', async () => {
  const root = body(closeButton('s1'))
  const requests = []
  let release
  closeOnPress(root, (request) => {
    requests.push(request)
    return new Promise((resolve) => {
      release = resolve
    })
  }, timers())
  const button = root.querySelector('[data-close]')
  button.click()
  button.click()
  button.click()
  button.click()
  assert.equal(requests.length, 1)
  release({ closed: true })
  await settle()
})

test('the panel says why nothing was closed, or why the tab stayed, and the note goes away', async () => {
  const cases = [
    [{ closed: false, reason: 'draft' }, '入力欄に書きかけの文字があるため、閉じませんでした。'],
    [{ closed: false, reason: 'working' }, 'エージェントが作業中のため、閉じませんでした。'],
    [{ closed: false, reason: 'stale' }, 'セッションの状態が変わったため、閉じませんでした。'],
    [{ closed: false, exited: true, reason: 'shell-busy' }, 'セッションは終了しました。タブでほかの処理が動いているため、タブは残しました。'],
    [{ closed: false, exited: true, reason: 'shell-input' }, 'セッションは終了しました。タブに入力中の文字があるかもしれないため、タブは残しました。'],
    [{ closed: false, exited: true, reason: 'remains' }, 'セッションは終了しました。タブは残っています。'],
    [{ closed: false, reason: 'something-new' }, '閉じられませんでした。']
  ]
  for (const [result, text] of cases) {
    const root = body(closeButton('s1'))
    const clock = timers()
    closeOnPress(root, async () => result, clock)
    const button = root.querySelector('[data-close]')
    button.click()
    button.click()
    await settle()
    assert.equal(root.ownerDocument.querySelector('.note').textContent, text)
    assert.equal(button.textContent, '閉じる', 'the button is ready again')
    clock.run(NOTE_MS)
    assert.equal(root.ownerDocument.querySelector('.note'), null, 'the note goes away')
  }
})

test('a request that fails is reported as a failure, and the button is ready again', async () => {
  const root = body(closeButton('s1'))
  closeOnPress(root, async () => {
    throw new Error('no connection')
  }, timers())
  const button = root.querySelector('[data-close]')
  button.click()
  button.click()
  await settle()
  assert.equal(root.ownerDocument.querySelector('.note').textContent, '閉じられませんでした。')
  assert.ok(!button.disabled)
})

test('the pressed button keeps its question across the patches of the body', () => {
  const html = `<div class="row">${closeButton('s1')}</div>`
  const root = body(html)
  const presses = closeOnPress(root, async () => ({ closed: true }), timers())
  root.querySelector('[data-close]').click()
  patchChildren(root, html)
  assert.equal(root.querySelector('[data-close]').textContent, '閉じる', 'a patch brings the worker\'s label back')
  presses.restore()
  assert.equal(root.querySelector('[data-close]').textContent, '本当に閉じる？（未完了 3）')
  assert.ok(root.querySelector('[data-close]').classList.contains('armed'))
  // The question is about that session at that time; the same session waiting again is another one.
  patchChildren(root, `<div class="row">${closeButton('s1', 9000)}</div>`)
  presses.restore()
  assert.equal(root.querySelector('[data-close]').textContent, '閉じる')
})

test('pressing the close button inside a row head does not open the workspace', () => {
  const root = body(`<div class="head" data-open="/work/app"><span class="name">app</span>${closeButton('s1')}</div>`)
  const opened = []
  openOnPress(root, (path) => opened.push(path))
  root.querySelector('[data-close]').click()
  assert.deepEqual(opened, [])
  root.querySelector('.name').click()
  assert.deepEqual(opened, ['/work/app'])
})

test('pressing the refresh button spins while running and ignores double clicks until done', async () => {
  const root = body('<header><h1>app</h1><button type="button" class="refresh" data-refresh>↻</button></header>')
  let finish
  let calls = 0
  refreshOnPress(root, () => {
    calls += 1
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const button = root.querySelector('[data-refresh]')
  button.click()
  button.click()
  assert.equal(calls, 1)
  assert.ok(button.disabled)
  assert.ok(button.classList.contains('spinning'))
  finish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(button.disabled, false)
  assert.ok(!button.classList.contains('spinning'))
})
