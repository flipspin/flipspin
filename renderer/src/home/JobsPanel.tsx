import PanelHeader from "../ui/components/PanelHeader";
import { useOutbox } from "../offline/useOffline";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getState, subscribe } from "../downloads/downloadsStore";
import { ClearFinished, JobList } from "../downloads/DownloadsMenu";
import { useAcquisitionJobs, withoutAcquisitionStages } from '../downloads/acquisitionJobs';
import type { WorkExtensions } from '../downloads/AcquisitionRows';
import { useOfflineStorage } from '../offline/useOfflineStorage';

/** "Jobs" on Home: the same rows as the topbar menu, always open, scrolling inside its own box. */
export default function JobsPanel({ frameless = false, ...extensions }: WorkExtensions & { frameless?: boolean }) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(subscribe, getState);
  const acquisition = useAcquisitionJobs();
  const jobs = withoutAcquisitionStages(snapshot.jobs, acquisition);
  const offline = useOfflineStorage();
  const outbox = useOutbox();
  const count = outbox.length + jobs.length + acquisition.requests.length + (offline.data?.status.tracks.filter(track => track.pool === 'offline').length ?? 0);
  return (
    <section aria-label={t("Jobs")} className={frameless ? "home-jobs home-jobs--bare" : "h-full min-h-0 bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-hidden flex flex-col"}>
      {frameless ? <div className="home-jobs__heading">
        <h2>{t("Jobs")}</h2><span className="home-jobs__count">{count}</span><ClearFinished className="ml-auto" />
      </div> : <PanelHeader title={t("Jobs")} accent="var(--green)" count={count} actions={<ClearFinished />} />}
      <div className="home-jobs__rows flex-1 min-h-0 overflow-y-auto custom-scrollbar text-[var(--ink)]">
        <JobList {...extensions} />
      </div>
    </section>
  );
}
