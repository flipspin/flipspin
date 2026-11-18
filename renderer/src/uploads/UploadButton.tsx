import { useTranslation } from 'react-i18next'
import { Upload } from 'lucide-react'
import { useConnection } from '../connection/connection'
import { openUpload } from './actions'

export function UploadButton({ signedIn }: { signedIn: boolean }) {
  const { t } = useTranslation()
  const connection = useConnection()
  return <button type="button" className="library-icon-btn library-icon-btn--text" disabled={!signedIn || connection.state !== 'connected'} title={!signedIn ? t("Sign in to upload music") : connection.state !== 'connected' ? t("Offline") : undefined} onClick={() => openUpload()}><Upload size={13} strokeWidth={2.5} aria-hidden />{t("Upload music")}</button>
}
