// SPDX-License-Identifier: AGPL-3.0-or-later

export type ProviderCatalogChangeReason =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'activated'
  | 'deactivated'
  | 'runtime-switched';

export interface ProviderCatalogChange {
  readonly reason: ProviderCatalogChangeReason;
  readonly source: string;
}

type ProviderCatalogChangeListener = (
  change: ProviderCatalogChange,
) => void;

const providerCatalogChangeListeners =
  new Set<ProviderCatalogChangeListener>();

let nextProviderCatalogEventSourceId = 0;

export function createProviderCatalogEventSource(prefix: string): string {
  nextProviderCatalogEventSourceId += 1;
  return `${prefix}:${nextProviderCatalogEventSourceId}`;
}

export function subscribeProviderCatalogChanged(
  listener: ProviderCatalogChangeListener,
): () => void {
  providerCatalogChangeListeners.add(listener);
  return () => {
    providerCatalogChangeListeners.delete(listener);
  };
}

export function notifyProviderCatalogChanged(
  change: ProviderCatalogChange,
): void {
  for (const listener of [...providerCatalogChangeListeners]) {
    listener(change);
  }
}
