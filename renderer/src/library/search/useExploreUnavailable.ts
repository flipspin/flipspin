import { useCallback, useContext, useSyncExternalStore } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOffline } from "../../offline/useOffline";
import type { Provider } from "../../settings/data";
import { queryKeys } from "../../data/keys";

const noSubscription = () => () => {};
/** Observe existing state only: focusing or typing must never call a provider. */
export function useExploreUnavailable() {
  const { t } = useTranslation();
  const offline = useOffline();
  const client = useContext(QueryClientContext);
  const cache = client?.getQueryCache();
  const subscribe = useCallback((listener: () => void) => cache ? cache.subscribe(listener) : noSubscription(), [cache]);
  const snapshot = useCallback(() => {
    const providers = client?.getQueryData<Provider[]>(queryKeys.server.providers());
    if (providers && !providers.some(provider => provider.enabled && provider.available && provider.capabilities.some(cap => cap.startsWith("search:")))) {
      return providers.find(provider => provider.enabled && provider.unavailableReason)?.unavailableReason || t("No active source can answer.");
    }
    const latest = cache?.findAll({ queryKey: ["browse-search"] }).reverse().sort((a, b) => Math.max(b.state.errorUpdatedAt, b.state.dataUpdatedAt) - Math.max(a.state.errorUpdatedAt, a.state.dataUpdatedAt))[0];
    const error = latest?.state.error;
    if (error && "kind" in error && ["offline", "unavailable", "failed"].includes(String(error.kind))) return error.message;
    return null;
  }, [client, cache, t]);
  const reason = useSyncExternalStore(subscribe, snapshot);
  if (offline) return t("Unavailable offline");
  return reason;
}
