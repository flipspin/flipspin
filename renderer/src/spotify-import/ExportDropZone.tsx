import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileInput } from '../ui/react/components/FileInput';
import { formatBytes } from './importStyles';
import './spotify-import.css';
import { SpotifyDataHelp } from './SpotifyDataHelp';

type ExportDropZoneProps = {
  file?: { name: string; size: number } | null;
  parsing: boolean;
  onFile: (file: File) => void;
};

/** Read the archive immediately; keep long-running work in the existing store. */
export default function ExportDropZone({ file, parsing, onFile }: ExportDropZoneProps) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState(0);
  return <div className="spotify-export-start">
    <FileInput key={selection}
      ariaLabel={t("Choose Spotify file")}
      accept=".zip,.json,application/zip,application/json"
      disabled={parsing}
      hint={t("Spotify ZIP or JSON file")}
      onChange={(files) => {
        if (parsing || !files[0]) return;
        // Reset the native picker so the same archive can be retried after an error.
        setSelection((previous) => previous + 1);
        onFile(files[0]);
      }} />
    {parsing && <p className="z-say" role="status">{t("Reading the file…")}</p>}
    {file && <p className="spotify-export-file"><span>{file.name}</span><span className="z-mono">{formatBytes(file.size)}</span></p>}
    <SpotifyDataHelp />
  </div>;
}
