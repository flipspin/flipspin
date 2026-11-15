import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '../ui/react/components/Tooltip'
import { accuracyData, calibration } from './calibration'
import './accuracy.css'
import { AnalysisValue } from './AnalysisValue'

const pct = (value: number) => `${Math.round(value)} %`
const range = (values: readonly number[], scale = 1) => values.map(value => Math.round(value * scale)).join('–')
function Tip({ text, children }: { text: string; children: ReactNode }) {
  return <Tooltip label={text} content={text}>{children}</Tooltip>
}
function Block({ title, subtitle, wide = false, children }: { title: string; subtitle: ReactNode; wide?: boolean; children: ReactNode }) {
  return <section className={`accuracy-block${wide ? ' accuracy-block--wide' : ''}`} aria-label={title}><h3>{title}<span>{subtitle}</span></h3>{children}</section>
}

export function AccuracyPage() {
  const { t } = useTranslation()
  const { giantsteps: g, library: l } = accuracyData
  const tempo = g.tempo.v2
  const libraryRows = [
    { label: 'BPM ±2', labels: l.bpm.all_labels.all.exact.n, hand: false, tip: t("AcousticBrainz and Deezer agree within ±2, plus 37 checked by hand"), confident: l.bpm.all_labels.confident.exact, estimated: l.bpm.all_labels.estimated.exact },
    { label: t('BPM incl. ½/×2'), labels: l.bpm.all_labels.all.exact_or_octave.n, hand: false, tip: t("AcousticBrainz and Deezer agree within ±2, plus 37 checked by hand"), confident: l.bpm.all_labels.confident.exact_or_octave, estimated: l.bpm.all_labels.estimated.exact_or_octave },
    { label: t("Key exact"), labels: l.key.gold.all.exact.n, hand: true, tip: t("Checked by hand against Hooktheory and two web sources"), confident: l.key.gold.confident.exact, estimated: l.key.gold.estimated.exact },
    { label: t("Key incl. relative"), labels: l.key.gold.all.exact_or_relative.n, hand: true, tip: t("Checked by hand against Hooktheory and two web sources"), confident: l.key.gold.confident.exact_or_relative, estimated: l.key.gold.estimated.exact_or_relative },
  ]
  return <div className="accuracy-grid">
    {(['key', 'bpm'] as const).map(field => <Block key={field} title={field === 'key' ? t("Key_tone") : 'BPM'} subtitle={`${field === 'key' ? 'GiantSteps Key' : 'GiantSteps Tempo'} · ${t("{{n}} songs", { count: field === 'key' ? g.key.all.n : tempo.all.n, n: field === 'key' ? g.key.all.n : tempo.all.n })}`}>
      <table><thead><tr><th>{t("Band")}</th><th>{t("Share")}</th><th>{field === 'key' ? t("Exact") : '±4 %'}</th><th>{t("95 % range")}</th><th>{field === 'key' ? <Tip text={t("MIREX weighted score: fifth 0.5 · relative 0.3 · parallel 0.2")}>{t("Weighted")}</Tip> : t('incl. ½/×2')}</th></tr></thead>
      <tbody>{(['confident', 'estimated', 'all'] as const).map(kind => {
        const key = g.key[kind], bpm = tempo[kind]
        const accuracy = field === 'key' ? key.exact : bpm.accuracy1
        const share = kind === 'all' ? 100 : field === 'key' ? g.key[`share_${kind}`].pct : tempo[`share_${kind}`].pct
        return <tr key={kind}><td>{kind === 'all' ? t("All") : <span className={`accuracy-band${kind === 'estimated' ? ' accuracy-estimate' : ''}`}><AnalysisValue track={{ [field]: field === 'key' ? '3A' : kind === 'estimated' ? 94 : 123, [`${field}Source`]: 'computed', [`${field}Estimated`]: kind === 'estimated' }} field={field} />{field === 'key' ? 'c' : 'p'} {kind === 'confident' ? '≥' : '<'} {calibration.cutoffs[field]}</span>}</td><td>{pct(share)}</td><td>{pct(accuracy.pct)}</td><td>{range(accuracy.ci95)}</td><td>{field === 'key' ? Math.round(key.mirex_weighted) : pct(bpm.accuracy2.pct)}</td></tr>
      })}</tbody></table>
    </Block>)}
    <Block title={t("Your library")} subtitle={t("{{n}} songs · labels from MusicBrainz, AcousticBrainz, Deezer and hand checks", { n: l.coverage.songs })} wide>
      <table><thead><tr><th>{t("Measure")}</th><th>{t("Labels")}</th><th>{t("Confident")}</th><th>{t("95 % range")}</th><th>{t("Estimate")}</th><th>{t("95 % range")}</th></tr></thead><tbody>
        {libraryRows.map(row => <tr key={row.label}><td>{row.label}</td><td><Tip text={row.tip}>{t("{{n}} songs", { count: row.labels, n: row.labels })}{row.hand ? ` · ${t("by hand")}` : ''}</Tip></td>{[row.confident, row.estimated].map((metric, index) => <Fragment key={index}><td>{pct(metric.rate * 100)}</td><td>{range(metric.ci95, 100)}</td></Fragment>)}</tr>)}
        {(['regional-mexican', 'latin-urban'] as const).map(family => {
          const data = l.per_family[family]
          const counts = t("{{key}} key and {{bpm}} BPM labels", { key: data.key_labels, bpm: data.bpm_labels })
          return <tr key={family}><td>{t(family === 'regional-mexican' ? "Regional Mexican" : "Latin urban")}</td><td>{t("{{n}} songs", { count: data.songs, n: data.songs })} · {t("{{n}} labels", { count: data.key_labels + data.bpm_labels, n: data.key_labels + data.bpm_labels })}</td>{[0, 1].map(index => <td colSpan={2} key={index}><Tip text={counts}><span className="accuracy-missing">{t("Not enough labels")}</span></Tip></td>)}</tr>
        })}
      </tbody></table>
    </Block>
    {(['key', 'bpm'] as const).map(field => <Block key={field} title={`${field === 'key' ? t("Key_tone") : 'BPM'} · ${t("by score")}`} subtitle={t(field === 'key' ? "exact, per tenth of songs" : "±4 %, per tenth of songs")}>
      <div className="accuracy-bars">{calibration[field].map(band => <Tip key={band.decile} text={`n = ${band.n} · ${t("95 % range")} ${range(band.ci95)}`}><span className="accuracy-bar-row"><span>{field === 'key' ? 'c' : 'p'} {band.conf_min.toFixed(field === 'key' ? 4 : 2)}–{band.conf_max.toFixed(field === 'key' ? 4 : 2)}</span><span className={`accuracy-bar${band.conf_max < calibration.cutoffs[field] ? ' accuracy-bar--estimated' : ''}`}><i style={{ width: `${band.pct}%` }} /></span><b>{pct(band.pct)}</b></span></Tip>)}</div>
    </Block>)}
    <Block title={t("Test sets")} subtitle={t("where the numbers come from")}>
      <table><thead><tr><th>{t("Set")}</th><th>{t("Songs")}</th><th>{t("Music")}</th><th>{t("Measured")}</th></tr></thead><tbody>
        <tr><td>GiantSteps Key</td><td>{g.key.all.n}</td><td>{t("electronic dance · 2-min previews")}</td><td>{g.measured}</td></tr>
        <tr><td>GiantSteps Tempo</td><td>{tempo.all.n}</td><td><Tip text={t("2018 corrected labels")}>{t("electronic dance · 2-min previews")}</Tip></td><td>{g.measured}</td></tr>
        <tr><td>{t("Your library")} · BPM</td><td>{l.bpm.all_labels.all.exact.n}</td><td><Tip text={libraryRows[0].tip}>{t("mixed · labelled from the web")}</Tip></td><td>{l.generated}</td></tr>
        <tr><td>{t("Your library")} · {t("Key_tone")}</td><td>{l.key.all_labels.all.exact.n}</td><td><Tip text={t("AcousticBrainz and 38 checked by hand")}>{t("mixed · weak labels")}</Tip></td><td>{l.generated}</td></tr>
      </tbody></table>
    </Block>
  </div>
}
