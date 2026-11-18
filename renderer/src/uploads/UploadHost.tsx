/** The shared subscription also serves inline onboarding; toolbar uploads use the sheet. */
import { useEffect } from 'react'
import { UploadSheet } from './UploadSheet'
import { uploadActions, useUploads } from './uploadStore'

export function UploadHost() {
  const { batch, busy, problem, sheetOpen } = useUploads()
  useEffect(() => {
    const show = (event: Event) => uploadActions.openSheet((event as CustomEvent<string | undefined>).detail)
    window.addEventListener('krobi:open-upload', show)
    return () => window.removeEventListener('krobi:open-upload', show)
  }, [])
  return sheetOpen ? <UploadSheet batch={batch} busy={busy} problem={problem}
    onPick={kind => void uploadActions.pick(kind, 'sheet')}
    onStart={choice => void uploadActions.start(choice)} onStop={() => void uploadActions.stop()}
    onRetry={() => void uploadActions.retry()} onClose={uploadActions.closeSheet} /> : null
}
