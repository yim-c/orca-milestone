/** Folds the other workspaces away, or shows them again, when their heading is pressed. */
export function toggleOthersOnPress(root, toggle) {
  root.addEventListener('click', (event) => {
    if (event.target?.closest?.('[data-others-toggle]')) toggle()
  })
}
