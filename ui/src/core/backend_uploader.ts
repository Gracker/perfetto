// Copyright (C) 2024 SmartPerfetto
//
// Auto-upload trace to backend for AI analysis capabilities.
// This service uploads traces to the backend which starts a trace_processor_shell
// in HTTP RPC mode, allowing both frontend and backend to share the same trace processor.

import {TraceSource} from './trace_source';
import {fetchWithTimeout} from '../base/http_utils';
import {buildSmartPerfettoContextHeaders} from './smartperfetto_request_context';

const BACKEND_CHECK_TIMEOUT_MS = 1000; // Fast timeout for health check
const BACKEND_UPLOAD_TIMEOUT_MS = 60000; // 60s timeout for upload
const BACKEND_URL_UPLOAD_TIMEOUT_MS = 300000; // URL fetches can be slow on first load

export interface BackendUploadResult {
  success: boolean;
  traceId?: string;
  port?: number;
  error?: string;
}

export class BackendUploader {
  private backendUrl: string;

  constructor(backendUrl: string = 'http://localhost:3000') {
    this.backendUrl = backendUrl;
  }

  /**
   * Check if the AI backend is available (fast timeout)
   */
  async checkAvailable(): Promise<boolean> {
    try {
      const resp = await fetchWithTimeout(
        `${this.backendUrl}/api/traces/health`,
        {
          method: 'GET',
          cache: 'no-cache',
          headers: buildSmartPerfettoContextHeaders(),
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

    const blob = await this.getTraceBlob(source);
    if (!blob) {
      return {
        success: false,
        error: 'Cannot convert trace source to blob for upload',
      };
    }

    const filename = this.getFilename(source);
    const formData = new FormData();
    formData.append('file', blob, filename);

    console.log(`[BackendUploader] Uploading ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB)...`);

    try {
      const resp = await fetchWithTimeout(
        `${this.backendUrl}/api/traces/upload`,
        {
          method: 'POST',
          headers: buildSmartPerfettoContextHeaders(),
          body: formData,
        },
        BACKEND_UPLOAD_TIMEOUT_MS,
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

      const {id: traceId, port} = data.trace;

      if (!port) {
        return {
          success: false,
          error: 'Backend did not return a port for HTTP RPC',
        };
      }

      console.log(`[BackendUploader] Upload successful! traceId=${traceId}, port=${port}`);

      return {
        success: true,
        traceId,
        port,
      };
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
        `${this.backendUrl}/api/traces/upload-url`,
        {
          method: 'POST',
          headers: buildSmartPerfettoContextHeaders({
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

      const {id: traceId, port} = data.trace;

      if (!port) {
        return {
          success: false,
          error: 'Backend did not return a port for HTTP RPC',
        };
      }

      console.log(`[BackendUploader] URL upload successful! traceId=${traceId}, port=${port}`);

      return {
        success: true,
        traceId,
        port,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[BackendUploader] URL upload error:', errorMsg);
      return {
        success: false,
        error: `URL upload error: ${errorMsg}`,
      };
    }
  }
}

// Singleton instance with configurable backend URL
let uploaderInstance: BackendUploader | undefined;
let configuredBackendUrl: string | undefined;

/** Set the default backend URL BEFORE any trace is loaded (call at module init). */
export function setDefaultBackendUrl(url: string) {
  configuredBackendUrl = url;
}

export function getBackendUploader(backendUrl?: string): BackendUploader {
  const url = backendUrl ?? configuredBackendUrl ?? 'http://localhost:3000';
  if (!uploaderInstance || uploaderInstance['backendUrl'] !== url) {
    uploaderInstance = new BackendUploader(url);
  }
  return uploaderInstance;
}
