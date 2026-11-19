// Closes a session that waits for the user, from the button on its list or row. Closing takes two
// presses: the first only asks for the second, and goes back by itself after a few seconds. The
// worker checks again when the second comes. A refusal is told on the button that was pressed, in
// place of its label for a few seconds: it is where the person looks, and a closed session needs
// nothing said as its row goes. A session that ended with its tab left is told in a note outside
// the body, as its button is gone by then, and a patch does not touch the note.
// The listener sits on the root and the state is kept here, so both survive the patches of the body;
// `restore` puts the label of the pressed button back after each one.

export const CONFIRM_MS = 5000
export const NOTE_MS = 6000

// What a refusal says in place of the label of the button: short, as the button is small.
const REFUSALS = {
  stale: '状態が変わったため中止',
  working: '作業中のため中止',
  asking: '確認待ちのため中止',
  draft: '入力中の文字があるため中止',
  'no-tab': 'タブが見つかりません',
  'no-terminal': 'タブが見つかりません',
  'not-exited': '終了しなかったため中止',
  busy: 'すでに閉じています',
  failed: '閉じられませんでした'
}

// The session ended but its tab was left; its button is gone, so this is told in a note.
const LEFT_OPEN = {
  'shell-busy': 'セッションは終了しました。タブでほかの処理が動いているため、タブは残しました。',
  'shell-input': 'セッションは終了しました。タブに入力中の文字があるかもしれないため、タブは残しました。',
  remains: 'セッションは終了しました。タブは残っています。'
}

const keyOf = (button) => `${button.getAttribute('data-close')}:${button.getAttribute('data-since')}`

export function closeOnPress(root, close, { later = setTimeout, cancel = clearTimeout, confirmMs = CONFIRM_MS, noteMs = NOTE_MS } = {}) {
  let armed = null
  let armTimer = null
  let sending = null
  // What a refusal told, and for which button, until it goes by itself.
  let refused = null
  let refusedTimer = null
  let noteTimer = null

  function label(button) {
    const key = keyOf(button)
    if (sending === key) return '閉じています…'
    if (refused?.key === key) return refused.text
    if (armed !== key) return '閉じる'
    const unfinished = Number(button.getAttribute('data-unfinished'))
    return unfinished > 0 ? `本当に閉じる？（未完了 ${unfinished}）` : '本当に閉じる？'
  }

  function restore() {
    for (const button of root.querySelectorAll('[data-close]')) {
      const key = keyOf(button)
      button.classList.toggle('armed', armed === key)
      button.classList.toggle('refused', refused?.key === key)
      button.disabled = sending === key
      button.textContent = label(button)
    }
  }

  function disarm() {
    armed = null
    cancel(armTimer)
    restore()
  }

  function refuse(key, text) {
    refused = { key, text }
    cancel(refusedTimer)
    refusedTimer = later(() => {
      refused = null
      restore()
    }, noteMs)
    restore()
  }

  function note(text) {
    const doc = root.ownerDocument
    let element = doc.querySelector('.note')
    if (!element) {
      element = doc.createElement('p')
      element.className = 'note'
      element.setAttribute('role', 'status')
      doc.documentElement.appendChild(element)
    }
    element.textContent = text
    cancel(noteTimer)
    noteTimer = later(() => element.remove(), noteMs)
  }

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-close]')
    if (!button || sending) return
    const key = keyOf(button)
    if (armed !== key) {
      refused = null
      armed = key
      cancel(armTimer)
      armTimer = later(disarm, confirmMs)
      restore()
      return
    }
    const request = { sessionId: button.getAttribute('data-close'), since: Number(button.getAttribute('data-since')) }
    armed = null
    cancel(armTimer)
    sending = key
    restore()
    let result
    try {
      result = await close(request)
    } catch {
      result = { closed: false, reason: 'failed' }
    }
    sending = null
    restore()
    if (result?.closed) return
    // A session that exited leaves no button to tell it on.
    if (result?.exited && LEFT_OPEN[result.reason]) note(LEFT_OPEN[result.reason])
    else refuse(key, REFUSALS[result?.reason] ?? REFUSALS.failed)
  })

  return { restore }
}
