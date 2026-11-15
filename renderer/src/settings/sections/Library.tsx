/** Keep folder jobs and disk usage together so imports show where their files will land. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import '../marked.css'
import { ImportPanel } from '../../import'
import { useSettings } from '../context'
import { isOlderNest, useLibrarySummary, useServerStorage } from '../data'
import { formatBytes, formatCount } from '../format'
import { Empty, ErrorAlt, Modal, OldNest, Skel, Tipped } from '../parts'
import { DiskBar, diskSlices } from './Overview'
import { Page } from './Head'
import { Missing } from '../../ui/react/components/Missing'
import { takeLanding } from '../landing'
import { LibraryScanControls } from './LibraryScans'
import { useLibraryScan } from '../libraryScansData'

function Folderjob(): React.JSX.Element {
  const { t } = useTranslation()
  const { surface, server, host } = useSettings()
  const summary = useLibrarySummary()
  const scan = useLibraryScan()
  const [folderOptions, setFolderOptions] = useState(false)
  const local = surface === 'app' && server.kind === 'ready' && server.value?.mode === 'child' && host.chooseMusicFolder !== undefined

  if (summary.isPending) {
    return (
      <div className="settings-job ks-group">
        <Skel rows={3} label={t("Loading the library")} />
      </div>
    )
  }
  if (summary.isError) {
    return (
      <div className="settings-job ks-group">
        {isOlderNest(summary.error) ? (
          <OldNest>{t("Update the nest to see its library.")}</OldNest>
        ) : (
          <ErrorAlt what={t("the library")} onRetry={() => void summary.refetch()} />
        )}
      </div>
    )
  }
  const data = summary.data
  return <div className="settings-block ks-group">
    <div className="settings-block__head"><h3>{t("Music folder")}</h3></div>
    <div className="ks-row"><div className="ks-l">
      <b className="z-mono"><button className="settings-label-action" type="button" onClick={() => setFolderOptions(true)} title={data.folder}>{data.folder}</button></b>
      <span title={data.songs === 0 ? t("The folder is empty.") : undefined}>{t("{{n}} songs", { count: data.songs, n: formatCount(data.songs) })} · {t("{{n}} albums", { count: data.albums, n: formatCount(data.albums) })} · {t("{{n}} artists", { count: data.artists, n: formatCount(data.artists) })}</span>
    </div></div>
    <LibraryScanControls scan={scan} />
    {folderOptions ? <Modal title={t("Music folder")} onClose={() => setFolderOptions(false)}><span className="z-mono">{data.folder}</span>{local ? <button className="ks-btn" type="button" onClick={host.chooseMusicFolder}>{t("Choose folder")}</button> : null}</Modal> : null}
  </div>

}

function Disk(): React.JSX.Element {
  const { t } = useTranslation()
  const storage = useServerStorage(true)
  const data = storage.data
  return (
    <div className="settings-block ks-group">
      <div className="settings-block__head">
        <h3>{t("Storage")}</h3>
        {data ? (
          <span className="settings-count">
            <b className="z-mono">{t('Flipspin {{size}}', { size: formatBytes(data.music + data.stems) })}</b>
          </span>
        ) : null}
      </div>
      {storage.isPending ? (
        <Skel rows={2} label={t("Loading storage")} />
      ) : storage.isError ? (
        isOlderNest(storage.error) ? (
          <OldNest>{t("Update the nest to see storage.")}</OldNest>
        ) : (
          <ErrorAlt what={t("storage")} onRetry={() => void storage.refetch()} />
        )
      ) : data ? (
        <div className="settings-block__body">
          <DiskBar storage={data} big />
          <div className="settings-legend">
            {diskSlices(data).map((slice) => (
              <span key={slice.key} style={{ '--_c': slice.hue } as React.CSSProperties}>
                <span className="z-dot" />
                {slice.key === 'stems' ? (
                  <Tipped tip={t("Stems: vocals, drums, bass and others. About 18 MB per 3-minute song.")}>{t(slice.label)}</Tipped>
                ) : (
                  t(slice.label)
                )}{' '}
                <b className="z-mono">{formatBytes(slice.bytes)}</b>
              </span>
            ))}
            <span style={{ '--_c': 'var(--color-bg-surface-dim)' } as React.CSSProperties}>
              <span className="z-dot" />
              {t("Disk · {{free}} free of {{total}}", { free: formatBytes(data.disk.free), total: formatBytes(data.disk.total) })}
            </span>
          </div>
        </div>
      ) : (
        <Empty><Missing kind="nodata" reason={t("The nest didn't send its storage")} /></Empty>
      )}
    </div>
  )
}

function Importar(): React.JSX.Element {
  const { t } = useTranslation()
  const { host } = useSettings()
  // "Spotify's limits" in Fuentes lands here with the data-file import open.
  const [open, setOpen] = useState<'link' | 'spotify' | null>(() => (takeLanding('spotify-export') ? 'spotify' : null))
  const Spotify = host.SpotifyImport
  return (
    <div className="settings-block ks-group" id="settings-library-import">
      <div className="settings-block__head">
        <h3>{t("Import_verb")}</h3>
      </div>
      <div className="settings-block__body settings-imports">
        <button className="settings-import" type="button" onClick={() => setOpen('link')}>
          <b>{t("Link or search")}</b>
          <span>{t("Spotify · audio sources")}</span>
        </button>
        {Spotify ? (
          <button className="settings-import" type="button" onClick={() => setOpen('spotify')}>
            <b>{t("Spotify data file")}</b>
            <span>{t("ZIP or JSON · you review before downloading")}</span>
          </button>
        ) : null}
      </div>
      {open === 'link' ? (
        <Modal title={t("Link or search")} onClose={() => setOpen(null)} className="settings-modal--wide">
          <div className="mk">
            <ImportPanel />
          </div>
        </Modal>
      ) : null}
      {open === 'spotify' && Spotify ? (
        <Modal title={t("Spotify data file")} onClose={() => setOpen(null)} className="settings-modal--wide">
          <Spotify />
        </Modal>
      ) : null}
    </div>
  )
}

export function Library(): React.JSX.Element {
  const { t } = useTranslation()
  const { go } = useSettings()
  return (
    <Page id="biblioteca">
      <Folderjob />
      <div className="ks-row"><div className="ks-l"><b>{t("Possible duplicates")}</b></div><button className="ks-btn" type="button" onClick={() => go('duplicates')}>{t("Review duplicates")}</button></div>
      <button className="ks-row settings-label-action" type="button" onClick={() => go('missing')}>{t("Missing files_translated")} <span aria-hidden>›</span></button>
      <Disk />
      <Importar />
    </Page>
  )
}
