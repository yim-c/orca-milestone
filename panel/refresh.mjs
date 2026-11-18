/** Refreshes the panel when the header refresh button is pressed, showing a brief spin while running. */
export function refreshOnPress(root, refresh) {
  root.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-refresh]')
    if (!button || button.disabled) return
    button.disabled = true
    button.classList.add('spinning')
    try {
      await refresh()
    } finally {
      button.disabled = false
      button.classList.remove('spinning')
    }
  })
}
