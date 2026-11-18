import { Missing } from '../react/components/Missing';
import { useConnection } from '../../connection/connection';

/** Space for the actual content until a real listing answers. */
export function ContentPlaceholder({ count = 3, compact = false }: { count?: number; compact?: boolean }) {
  const connection = useConnection();
  const missing = <Missing kind={connection.state === 'connected' ? 'loading' : 'connecting'} />;
  if (compact) return <div role="status" className="flex items-center gap-2 py-1" aria-busy="true">
    <div aria-hidden="true" className="h-7 w-7 rounded bg-panel-2 opacity-50" />
    {missing}
  </div>;
  return <div role="status" className="flex gap-4 p-3 overflow-hidden" aria-busy="true">
    {Array.from({ length: count }, (_, i) => <div key={i} className="w-28 shrink-0 space-y-2">
      <div aria-hidden="true" className="aspect-square rounded-panel bg-panel-2 opacity-50" />
      {i === 0 ? missing : <div aria-hidden="true" className="h-3 rounded bg-panel-2" />}
    </div>)}
  </div>;
}
