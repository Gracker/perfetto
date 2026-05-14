import type {HttpRpcTarget} from '../trace_processor/http_rpc_engine';

export type BackendUploadPhase = 'idle' | 'uploading' | 'ready' | 'failed';

export interface BackendUploadSnapshot {
  traceId?: string;
  uploadToken?: string;
  sourceKey?: string;
  port?: number;
  leaseId?: string;
  leaseMode?: string;
  leaseModeReason?: string;
  leaseQueueLength?: number;
  rpcTarget?: HttpRpcTarget;
  state: BackendUploadPhase;
  error?: string;
}

type Listener = (snapshot: BackendUploadSnapshot) => void;

let snapshot: BackendUploadSnapshot = {
  state: 'idle',
};

const listeners = new Set<Listener>();

function notify(): void {
  const current = getBackendUploadState();
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (error) {
      console.warn('[BackendUploadState] listener failed:', error);
    }
  }
}

export function getBackendUploadState(): BackendUploadSnapshot {
  return { ...snapshot };
}

export function setBackendUploadState(next: BackendUploadSnapshot): void {
  snapshot = {
    traceId: next.traceId,
    uploadToken: next.uploadToken,
    sourceKey: next.sourceKey,
    port: next.port,
    leaseId: next.leaseId,
    leaseMode: next.leaseMode,
    leaseModeReason: next.leaseModeReason,
    leaseQueueLength: next.leaseQueueLength,
    rpcTarget: next.rpcTarget,
    state: next.state,
    error: next.error,
  };
  notify();
}

export function subscribeBackendUploadState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
