// Global stack for managing overlay back-navigation.
// Each overlay pushes a fake history entry on open and registers its close fn.
// Pressing back calls only the topmost close fn, not all listeners.

const stack = [];
let ignoreNextPop = false;
let nextId = 0;

function writeEntry(id, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({ overlay: id }, '');
}

window.addEventListener('popstate', () => {
  if (ignoreNextPop) {
    ignoreNextPop = false;
    const top = stack.at(-1);
    if (top && history.state?.overlay !== top.id) {
      // cleanup의 비동기 back보다 새 시트가 먼저 열렸으면 새 시트의 항목을 복구한다.
      const staleEntry = history.state?.overlay && !stack.some((entry) => entry.id === history.state.overlay);
      writeEntry(top.id, !!staleEntry);
    }
    return;
  }
  const entry = stack.pop();
  if (entry && entry.fn() === false) pushOverlay(entry.fn);
});

export function pushOverlay(fn) {
  const id = ++nextId;
  writeEntry(id);
  stack.push({ fn, id });
}

export function removeOverlay(fn, wasClosedByPop) {
  const idx = stack.findLastIndex((entry) => entry.fn === fn);
  const entry = idx === -1 ? null : stack.splice(idx, 1)[0];
  // If closed by button, pop the fake history entry we pushed.
  // Guard with history.state check to avoid going back past the app's origin.
  if (!wasClosedByPop && entry && history.state?.overlay === entry.id) {
    ignoreNextPop = true;
    history.back();
  }
}
