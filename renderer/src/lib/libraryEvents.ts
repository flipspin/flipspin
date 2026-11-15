/** One renderer-wide invalidation signal, shared by jobs and user actions. */
export function announceLibraryChanged(source = 'otro') {
  // `source` only names the sender in the reload log line.
  window.dispatchEvent(new CustomEvent('library-changed', { detail: { source } }));
}

const completed = new Map<string, string>();
/** Repeated terminal snapshots must not turn progress reporting into polling. */
export function announceLibraryJob(id: string, state: string, attempt: string | number = 1) {
  if (!['succeeded', 'partial', 'completo', 'parcial', 'terminado'].includes(state)) {
    completed.delete(id);
    return;
  }
  const signature = `${state}:${attempt}`;
  if (completed.get(id) === signature) return;
  completed.set(id, signature);
  announceLibraryChanged(`trabajo ${id} ${signature}`);
}
export function resetLibraryJobs() { completed.clear(); }
