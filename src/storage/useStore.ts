import { useSyncExternalStore } from "react";
import { getSnapshotVersion, getState, subscribe } from "./stores";

// Components read the records; the version counter invalidates on any change.
export function useStoreVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshotVersion);
}

export function useStore() {
  useStoreVersion();
  return getState();
}
