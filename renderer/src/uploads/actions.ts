/** Library and Jobs share the app-level sheet through one upload event. */
export function openUpload(id?: string) {
  window.dispatchEvent(new CustomEvent('krobi:open-upload', { detail: id }))
}
