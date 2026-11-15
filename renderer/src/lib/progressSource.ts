import { poll, startPoll } from '../data/poll'
/** Desktop progress uses the existing snapshot endpoint through authenticated fetch.
 * Browser development retains native SSE. No secret is needed in this adapter.
 */
export class PollingEventSource extends EventTarget {
  readonly url: string
  readyState = 0
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  private stop: (() => void) | undefined
  private abort = new AbortController()

  constructor(url: string) {
    super()
    this.url = url
    // Let callers install their handlers before the first snapshot.
    this.stop = startPoll(() => this.readyState === 2 ? false : poll('active', true, 1000), () => this.poll())
  }
  close() {
    this.readyState = 2
    this.stop?.()
    this.abort.abort()
  }
  private async poll() {
    if (this.readyState === 2) return
    try {
      const url = new URL(this.url)
      url.pathname = url.pathname.replace('/download-progress-stream/', '/download-progress/')
      url.searchParams.delete('token')
      url.searchParams.delete('api_token')
      url.searchParams.delete('access_token')
      const response = await fetch(url.toString(), { signal: this.abort.signal })
      if (this.readyState === 2) return
      if (response.status === 404) {
        this.close()
        this.dispatchEvent(new Event('end'))
        return
      }
      if (!response.ok) throw new Error('progress-unavailable')
      const snapshot: unknown = await response.json()
      if (this.readyState === 2) return
      if (this.readyState === 0) {
        this.readyState = 1
        const event = new Event('open')
        this.onopen?.(event)
        this.dispatchEvent(event)
      }
      const event = new MessageEvent('message', { data: JSON.stringify(snapshot) })
      this.onmessage?.(event)
      this.dispatchEvent(event)
      if (snapshot && typeof snapshot === 'object' && 'terminal' in snapshot && snapshot.terminal) this.close()
    } catch {
      if (this.readyState === 2) return
      this.close()
      const event = new Event('error')
      this.onerror?.(event)
      this.dispatchEvent(event)
    }
  }
}
