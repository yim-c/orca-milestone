// Closes a session that waits for the user, from the button on its list or row. Closing takes two
// presses: the first only asks for the second, and goes back by itself after a few seconds. The
// worker checks again when the second comes, and says why when it closed nothing or left the tab.
// The listener sits on the root and the state is kept here, so both survive the patches of the body;
// `restore` puts the label of the pressed button back after each one. What came of a press is told
// in a note outside the body, which a patch does not touch.

export const CONFIRM_MS = 5000
export const NOTE_MS = 6000

const MESSAGES = {
  closed: 'セッションを閉じました。',
  stale: 'セッションの状態が変わったため、閉じませんでした。',
  working: 'エージェントが作業中のため、閉じませんでした。',
  asking: '質問や許可の確認を待っているため、閉じませんでした。',
  draft: '入力欄に書きかけの文字があるため、閉じませんでした。',
  'no-tab': 'ターミナルのタブが見つからないため、閉じませんでした。',
  'no-terminal': 'ターミナルのタブが見つからないため、閉じませんでした。',
  'not-exited': 'セッションが終了しなかったため、そのままにしました。バックグラウンドの作業があるかもしれません。',
  'shell-busy': 'セッションは終了しました。タブでほかの処理が動いているため、タブは残しました。',
  'shell-input': 'セッションは終了しました。タブに入力中の文字があるかもしれないため、タブは残しました。',
  remains: 'セッションは終了しました。タブは残っています。',
  busy: 'すでに閉じています。',
  failed: '閉じられませんでした。'
}

const keyOf = (button) => `${button.getAttribute('data-close')}:${button.getAttribute('data-since')}`

export function closeOnPress(root, close, { later = setTimeout, cancel = clearTimeout, confirmMs = CONFIRM_MS, noteMs = NOTE_MS } = {}) {
  let armed = null
  let armTimer = null
  let sending = null
  let noteTimer = null

  function label(button) {
    const key = keyOf(button)
    if (sending === key) return '閉じています…'
    if (armed !== key) return '閉じる'
    const unfinished = Number(button.getAttribute('data-unfinished'))
    return unfinished > 0 ? `本当に閉じる？（未完了 ${unfinished}）` : '本当に閉じる？'
  }

  function restore() {
    for (const button of root.querySelectorAll('[data-close]')) {
      const key = keyOf(button)
      button.classList.toggle('armed', armed === key)
      button.disabled = sending === key
      button.textContent = label(button)
    }
  }

  function disarm() {
    armed = null
    cancel(armTimer)
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
    note(MESSAGES[result?.closed ? 'closed' : result?.reason] ?? MESSAGES.failed)
  })

  return { restore }
}
