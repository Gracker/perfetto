// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const SAFE_REPORT_ID_RE = /^[a-zA-Z0-9._:-]+$/;
const REPORT_PATH_RE = /^\/api\/reports\/([^/]+)\/?$/;
const UNSAFE_FILENAME_CHAR_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

export type ReportDownloadErrorCode =
  | 'invalid_backend'
  | 'backend_mismatch'
  | 'query_or_fragment'
  | 'unsafe_report_id';

export class ReportDownloadError extends Error {
  constructor(readonly code: ReportDownloadErrorCode) {
    super(code);
    this.name = 'ReportDownloadError';
  }
}

export interface ReportDownloadTarget {
  exportUrl: string;
  reportId: string;
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function parseBackend(expectedBackendBase: string): URL {
  let backend: URL;
  try {
    backend = new URL(expectedBackendBase);
  } catch {
    throw new ReportDownloadError('invalid_backend');
  }
  if (
    !isHttpUrl(backend) ||
    backend.username !== '' ||
    backend.password !== '' ||
    backend.search !== '' ||
    backend.hash !== ''
  ) {
    throw new ReportDownloadError('invalid_backend');
  }
  return backend;
}

function backendPathPrefix(backend: URL): string {
  return backend.pathname === '/' ? '' : backend.pathname.replace(/\/+$/u, '');
}

function reportApiPath(pathname: string, backendPrefix: string): string | null {
  if (REPORT_PATH_RE.test(pathname)) return pathname;
  if (backendPrefix && pathname.startsWith(`${backendPrefix}/`)) {
    const unprefixed = pathname.slice(backendPrefix.length);
    if (REPORT_PATH_RE.test(unprefixed)) return unprefixed;
  }
  return null;
}

export function resolveReportDownloadTarget(
  reportUrl: string,
  expectedBackendBase: string,
): ReportDownloadTarget {
  const backend = parseBackend(expectedBackendBase);

  let report: URL;
  try {
    report = new URL(reportUrl, backend.origin);
  } catch {
    throw new ReportDownloadError('unsafe_report_id');
  }
  if (
    !isHttpUrl(report) ||
    report.origin !== backend.origin ||
    report.username !== '' ||
    report.password !== ''
  ) {
    throw new ReportDownloadError('backend_mismatch');
  }
  if (report.search !== '' || report.hash !== '') {
    throw new ReportDownloadError('query_or_fragment');
  }

  const prefix = backendPathPrefix(backend);
  const apiPath = reportApiPath(report.pathname, prefix);
  const match = apiPath ? REPORT_PATH_RE.exec(apiPath) : null;
  const reportId = match?.[1] ?? '';
  if (
    reportId.includes('%') ||
    !SAFE_REPORT_ID_RE.test(reportId) ||
    reportId === '.' ||
    reportId === '..'
  ) {
    throw new ReportDownloadError('unsafe_report_id');
  }

  return {
    exportUrl: `${backend.origin}${prefix}/api/reports/${reportId}/export`,
    reportId,
  };
}

function contentDispositionFilename(
  contentDisposition: string | null,
): string | null {
  if (!contentDisposition) return null;

  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(
    contentDisposition,
  )?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      return null;
    }
  }

  return (
    /filename\s*=\s*"([^"]*)"/iu.exec(contentDisposition)?.[1] ??
    /filename\s*=\s*([^;]+)/iu.exec(contentDisposition)?.[1]?.trim() ??
    null
  );
}

function sanitizeHtmlFilename(value: string, fallbackStem: string): string {
  let stem = value
    .normalize('NFKC')
    .replace(UNSAFE_FILENAME_CHAR_RE, '_')
    .replace(/\.\.+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/u, '')
    .replace(/[ .]+$/u, '')
    .trim()
    .replace(/\.html?$/iu, '');

  if (!stem) stem = fallbackStem;
  stem = stem.slice(0, 116).replace(/[ .]+$/u, '');
  return `${stem || 'smartperfetto-report'}.html`;
}

export function suggestedReportFilename(
  contentDisposition: string | null,
  reportId: string,
): string {
  const safeFallbackId =
    SAFE_REPORT_ID_RE.test(reportId) && reportId !== '.' && reportId !== '..'
      ? reportId
      : 'report';
  return sanitizeHtmlFilename(
    contentDispositionFilename(contentDisposition) ?? '',
    `smartperfetto-${safeFallbackId}`.replace(UNSAFE_FILENAME_CHAR_RE, '_'),
  );
}
