// Copyright (C) 2024 SmartPerfetto
//
// Auto-upload trace to backend for AI analysis capabilities.
// This service uploads traces to the backend which starts a trace_processor_shell
// in HTTP RPC mode, allowing both frontend and backend to share the same trace processor.

import {TraceSource} from './trace_source';
import {fetchWithTimeout} from '../base/http_utils';
import {
  buildSmartPerfettoContextHeaders,
  buildSmartPerfettoTraceProcessorProxyTarget,
  buildSmartPerfettoWorkspaceApiUrl,
} from './smartperfetto_request_context';
import type {HttpRpcTarget} from '../trace_processor/http_rpc_engine';
import {getDefaultSmartPerfettoBackendUrl} from './smartperfetto_backend_url';
import {getSmartPerfettoRequestContext} from './smartperfetto_request_context';

const BACKEND_CHECK_TIMEOUT_MS = 1000; // Fast timeout for health check
const BACKEND_UPLOAD_MIN_TIMEOUT_MS = 60000;
const BACKEND_UPLOAD_THROUGHPUT_MB_PER_S = 50;
const BACKEND_URL_UPLOAD_TIMEOUT_MS = 300000; // URL fetches can be slow on first load

function computeUploadTimeoutMs(byteSize: number): number {
  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    return BACKEND_UPLOAD_MIN_TIMEOUT_MS;
  }
  const bytesPerMs = BACKEND_UPLOAD_THROUGHPUT_MB_PER_S * 1024;
  return Math.max(BACKEND_UPLOAD_MIN_TIMEOUT_MS, Math.ceil(byteSize / bytesPerMs));
}

let nextTraceSourceObjectId = 0;
const traceSourceObjectIds = new WeakMap<object, number>();

function getTraceSourceObjectId(value: object): number {
  let id = traceSourceObjectIds.get(value);
  if (id === undefined) {
    id = ++nextTraceSourceObjectId;
    traceSourceObjectIds.set(value, id);
  }
  return id;
}

function opaqueSourceKey(parts: readonly unknown[]): string {
  const text = parts.map((part) => String(part)).join('\0');
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `source-${hash.toString(16).padStart(16, '0')}`;
}

/** Stable, opaque identity for one frontend trace source during its lifetime. */
export function backendUploadSourceKey(traceSource: TraceSource): string {
  switch (traceSource.type) {
    case 'FILE':
      return opaqueSourceKey([
        traceSource.type,
        getTraceSourceObjectId(traceSource.file),
        traceSource.file.name,
        traceSource.file.size,
        traceSource.file.lastModified,
      ]);
    case 'ARRAY_BUFFER':
      return opaqueSourceKey([
        traceSource.type,
        getTraceSourceObjectId(traceSource.buffer),
        traceSource.fileName ?? '',
        traceSource.title ?? '',
        traceSource.buffer.byteLength,
      ]);
    case 'URL':
      return opaqueSourceKey([traceSource.type, traceSource.url]);
    case 'MULTIPLE_FILES':
      return opaqueSourceKey([
        traceSource.type,
        ...traceSource.files.flatMap((file) => [
          getTraceSourceObjectId(file),
          file.name,
          file.size,
          file.lastModified,
        ]),
      ]);
    case 'STREAM':
      return opaqueSourceKey([
        traceSource.type,
        getTraceSourceObjectId(traceSource.stream),
      ]);
    case 'HTTP_RPC':
      return opaqueSourceKey([traceSource.type]);
    default:
      return opaqueSourceKey([JSON.stringify(traceSource)]);
  }
}

export interface BackendUploadResult {
  success: boolean;
  traceId?: string;
  port?: number;
  leaseId?: string;
  leaseMode?: string;
  leaseModeReason?: string;
  leaseQueueLength?: number;
  rpcTarget?: HttpRpcTarget;
  error?: string;
  errorCode?:
    | 'STREAM_SOURCE_UNSUPPORTED'
    | 'MULTIPLE_FILES_SOURCE_UNSUPPORTED'
    | 'TRACE_SOURCE_CONVERSION_FAILED'
    | 'UPLOAD_FAILED';
}

export class BackendUploader {
  private backendUrl: string;
  private readonly apiKey: string;

  constructor(
    backendUrl: string = getDefaultSmartPerfettoBackendUrl(),
    apiKey = configuredBackendApiKey,
  ) {
    this.backendUrl = backendUrl;
    this.apiKey = apiKey.trim();
  }

  private requestHeaders(headers?: HeadersInit): Record<string, string> {
    const normalized = buildSmartPerfettoContextHeaders(headers);
    if (!this.apiKey) return normalized;
    return {
      ...normalized,
      Authorization: `Bearer ${this.apiKey}`,
      'x-api-key': this.apiKey,
    };
  }

  /**
   * Check if the AI backend is available (fast timeout)
   */
  async checkAvailable(): Promise<boolean> {
    try {
      const resp = await fetchWithTimeout(
        buildSmartPerfettoWorkspaceApiUrl(this.backendUrl, 'traces', '/health'),
        {
          method: 'GET',
          cache: 'no-cache',
          headers: this.requestHeaders(),
        },
        BACKEND_CHECK_TIMEOUT_MS,
      );
      if (resp.status === 200) {
        const data = await resp.json();
        return data.available === true;
      }
      return false;
    } catch (err) {
      console.log('[BackendUploader] Backend not available:', err);
      return false;
    }
  }

  /**
   * Convert TraceSource to a Blob for upload
   */
  async getTraceBlob(source: TraceSource): Promise<Blob | null> {
    switch (source.type) {
      case 'FILE':
        return source.file;

      case 'ARRAY_BUFFER':
        return new Blob([source.buffer], {type: 'application/octet-stream'});

      case 'URL':
        // URL traces are uploaded through /upload-url so the backend can fetch
        // them without browser CORS restrictions.
        console.log('[BackendUploader] URL traces are uploaded by backend fetch');
        return null;

      case 'HTTP_RPC':
        // Already in RPC mode, no upload needed
        console.log('[BackendUploader] Already in HTTP_RPC mode');
        return null;

      case 'MULTIPLE_FILES':
        // TODO: Could combine files, but complex - skip for now
        console.log('[BackendUploader] Multiple files not supported for auto-upload');
        return null;

      case 'STREAM':
        // Stream needs to be consumed, complex - skip for now
        console.log('[BackendUploader] Stream traces not supported for auto-upload');
        return null;

      default:
        console.log('[BackendUploader] Unknown trace source type');
        return null;
    }
  }

  /**
   * Get filename from TraceSource
   * Note: Use || instead of ?? to also handle empty strings
   */
  getFilename(source: TraceSource): string {
    let filename: string;
    switch (source.type) {
      case 'FILE':
        filename = source.file.name;
        break;
      case 'ARRAY_BUFFER':
        // Use || to handle empty strings, not just null/undefined
        filename = source.fileName || source.title || 'trace.perfetto';
        break;
      case 'URL':
        const urlPath = new URL(source.url).pathname;
        filename = urlPath.split('/').pop() || 'trace.perfetto';
        break;
      default:
        filename = 'trace.perfetto';
    }
    // Ensure we never return an empty filename
    return filename || 'trace.perfetto';
  }

  /**
   * Upload trace to backend and return the RPC port
   */
  async upload(source: TraceSource): Promise<BackendUploadResult> {
    if (source.type === 'URL') {
      return this.uploadUrl(source.url, this.getFilename(source));
    }
    if (source.type === 'STREAM') {
      return {
        success: false,
        errorCode: 'STREAM_SOURCE_UNSUPPORTED',
        error: 'Streaming traces cannot be uploaded for AI analysis. Reopen the captured trace as a file.',
      };
    }
    if (source.type === 'MULTIPLE_FILES') {
      return {
        success: false,
        errorCode: 'MULTIPLE_FILES_SOURCE_UNSUPPORTED',
        error: 'Multi-file traces cannot be uploaded for AI analysis as one trace.',
      };
    }

    const blob = await this.getTraceBlob(source);
    if (!blob) {
      return {
        success: false,
        errorCode: 'TRACE_SOURCE_CONVERSION_FAILED',
        error: 'Cannot convert trace source to blob for upload',
      };
    }

    const filename = this.getFilename(source);
    const formData = new FormData();
    formData.append('file', blob, filename);

    console.log(`[BackendUploader] Uploading ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB)...`);

    try {
      const resp = await fetchWithTimeout(
        buildSmartPerfettoWorkspaceApiUrl(this.backendUrl, 'traces', '/upload'),
        {
          method: 'POST',
          headers: this.requestHeaders(),
          body: formData,
        },
        computeUploadTimeoutMs(blob.size),
      );

      if (resp.status !== 200) {
        const errorText = await resp.text();
        console.error('[BackendUploader] Upload failed:', resp.status, errorText);
        return {
          success: false,
          error: `Upload failed: ${resp.status} ${resp.statusText}`,
        };
      }

      const data = await resp.json();

      if (!data.success || !data.trace) {
        return {
          success: false,
          error: data.error ?? 'Unknown upload error',
        };
      }

      return this.buildUploadResult(data.trace, 'Upload');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[BackendUploader] Upload error:', errorMsg);
      return {
        success: false,
        error: `Upload error: ${errorMsg}`,
      };
    }
  }

  private async uploadUrl(url: string, filename: string): Promise<BackendUploadResult> {
    console.log(`[BackendUploader] Asking backend to fetch URL trace: ${url}`);

    try {
      const resp = await fetchWithTimeout(
        buildSmartPerfettoWorkspaceApiUrl(
          this.backendUrl,
          'traces',
          '/upload-url',
        ),
        {
          method: 'POST',
          headers: this.requestHeaders({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({url, filename}),
        },
        BACKEND_URL_UPLOAD_TIMEOUT_MS,
      );

      if (resp.status !== 200) {
        const errorText = await resp.text();
        console.error('[BackendUploader] URL upload failed:', resp.status, errorText);
        return {
          success: false,
          error: `URL upload failed: ${resp.status} ${resp.statusText}`,
        };
      }

      const data = await resp.json();

      if (!data.success || !data.trace) {
        return {
          success: false,
          error: data.error ?? 'Unknown URL upload error',
        };
      }

      return this.buildUploadResult(data.trace, 'URL upload');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[BackendUploader] URL upload error:', errorMsg);
      return {
        success: false,
        error: `URL upload error: ${errorMsg}`,
      };
    }
  }

  private buildUploadResult(trace: {
    id?: string;
    port?: number;
    leaseId?: string;
    leaseMode?: string;
    leaseModeReason?: string;
    leaseQueueLength?: number;
    websocketCapability?: {
      protocol?: string;
      expiresAt?: number;
    };
  }, label: string): BackendUploadResult {
    const {
      id: traceId,
      port,
      leaseId,
      leaseMode,
      leaseModeReason,
      leaseQueueLength,
      websocketCapability,
    } = trace;
    if (!port && !leaseId) {
      return {
        success: false,
        error: 'Backend did not return an HTTP RPC port or lease',
      };
    }

    let rpcTarget: HttpRpcTarget | undefined;
    if (leaseId) {
      rpcTarget = buildSmartPerfettoTraceProcessorProxyTarget(this.backendUrl, leaseId, {
        leaseMode,
        leaseModeReason,
        leaseQueueLength,
        websocketCapability,
      }, this.requestHeaders());
    } else if (port) {
      rpcTarget = this.buildBackendDirectPortTarget(port);
    }
    console.log(
      `[BackendUploader] ${label} successful! traceId=${traceId}, `
        + `port=${port ?? 'n/a'}, leaseId=${leaseId ?? 'n/a'}, `
        + `leaseMode=${leaseMode ?? 'n/a'}, queue=${leaseQueueLength ?? 'n/a'}`,
    );

    return {
      success: true,
      traceId,
      port,
      leaseId,
      leaseMode,
      leaseModeReason,
      leaseQueueLength,
      rpcTarget,
    };
  }

  private buildBackendDirectPortTarget(port: number): HttpRpcTarget {
    const host = '127.0.0.1';
    return {
      mode: 'direct-port',
      targetOwner: 'smartperfetto-backend',
      host,
      port: String(port),
      statusUrl: `http://${host}:${port}/status`,
      websocketUrl: `ws://${host}:${port}/websocket`,
      displayName: `${host}:${port}`,
    };
  }
}

// Singleton instance with configurable backend URL
let uploaderInstance: BackendUploader | undefined;
let configuredBackendUrl: string | undefined;
let configuredBackendApiKey = '';
let backendCredentialGeneration = 0;

function normalizeBackendUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Set the default backend URL BEFORE any trace is loaded (call at module init). */
export function setDefaultBackendUrl(url: string) {
  const normalized = normalizeBackendUrl(url);
  if (configuredBackendUrl !== undefined && configuredBackendUrl !== normalized) {
    backendCredentialGeneration += 1;
    uploaderInstance = undefined;
  }
  configuredBackendUrl = normalized;
}

/** Configure the API credential used by upload and lease-proxy HTTP calls. */
export function setDefaultBackendCredential(apiKey?: string): void {
  const normalized = (apiKey ?? '').trim();
  if (configuredBackendApiKey === normalized) return;
  configuredBackendApiKey = normalized;
  backendCredentialGeneration += 1;
  uploaderInstance = undefined;
}

/** Invalidate upload identity after an API credential changes without retaining the secret. */
export function invalidateBackendUploaderCredentials(): void {
  backendCredentialGeneration += 1;
  uploaderInstance = undefined;
}

export function getBackendUploadIdentityKey(
  backendUrl?: string,
  sourceKey?: string,
): string {
  const url = normalizeBackendUrl(
    backendUrl ?? configuredBackendUrl ?? getDefaultSmartPerfettoBackendUrl(),
  );
  const context = getSmartPerfettoRequestContext();
  const sourcePartition = opaqueSourceKey(['upload-identity', sourceKey ?? 'no-source']);
  return [
    url,
    `credential-generation-${backendCredentialGeneration}`,
    context.tenantId,
    context.userId,
    context.workspaceId,
    context.windowId,
    sourcePartition,
  ].join('::');
}

export function getBackendUploader(backendUrl?: string): BackendUploader {
  const url = normalizeBackendUrl(
    backendUrl ?? configuredBackendUrl ?? getDefaultSmartPerfettoBackendUrl(),
  );
  if (!uploaderInstance || uploaderInstance['backendUrl'] !== url) {
    uploaderInstance = new BackendUploader(url, configuredBackendApiKey);
  }
  return uploaderInstance;
}
