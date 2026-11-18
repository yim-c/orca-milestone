/** Filters the focused workspace's milestones by terminal tab when a tab pill is pressed. */
export function selectTabOnPress(root, selectTab) {
  root.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-tab]')
    if (!button) return
    selectTab(button.dataset.tab || null)
  })
}
