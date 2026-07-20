// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  ReportDownloadError,
  resolveReportDownloadTarget,
  suggestedReportFilename,
} from './report_download';

describe('report download', () => {
  it('resolves the audited export endpoint on the configured backend', () => {
    expect(
      resolveReportDownloadTarget(
        'http://127.0.0.1:3000/api/reports/report-1/',
        'http://127.0.0.1:3000',
      ),
    ).toEqual({
      exportUrl: 'http://127.0.0.1:3000/api/reports/report-1/export',
      reportId: 'report-1',
    });
  });

  it('preserves a configured backend path prefix', () => {
    expect(
      resolveReportDownloadTarget(
        '/api/reports/report-1',
        'https://example.test/smartperfetto/',
      ),
    ).toEqual({
      exportUrl:
        'https://example.test/smartperfetto/api/reports/report-1/export',
      reportId: 'report-1',
    });
    expect(
      resolveReportDownloadTarget(
        'https://example.test/smartperfetto/api/reports/report-2',
        'https://example.test/smartperfetto',
      ),
    ).toEqual({
      exportUrl:
        'https://example.test/smartperfetto/api/reports/report-2/export',
      reportId: 'report-2',
    });
  });

  it.each([
    ['cross-origin URL', 'http://example.com/api/reports/report-1'],
    ['non-report path', 'http://127.0.0.1:3000/api/traces/report-1'],
    [
      'existing export path',
      'http://127.0.0.1:3000/api/reports/report-1/export',
    ],
    ['query string', 'http://127.0.0.1:3000/api/reports/report-1?raw=1'],
    ['fragment', 'http://127.0.0.1:3000/api/reports/report-1#details'],
    ['encoded traversal', 'http://127.0.0.1:3000/api/reports/%2e%2e'],
  ])('rejects a %s', (_name, reportUrl) => {
    expect(() =>
      resolveReportDownloadTarget(reportUrl, 'http://127.0.0.1:3000'),
    ).toThrow();
  });

  it('returns a stable validation code for localized UI errors', () => {
    try {
      resolveReportDownloadTarget(
        'http://example.com/api/reports/report-1',
        'http://127.0.0.1:3000',
      );
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ReportDownloadError);
      expect((error as ReportDownloadError).code).toBe('backend_mismatch');
    }
  });

  it('uses a valid Content-Disposition filename and forces HTML output', () => {
    expect(
      suggestedReportFilename(
        'attachment; filename="analysis-result.htm"',
        'report-1',
      ),
    ).toBe('analysis-result.html');
    expect(
      suggestedReportFilename(
        "attachment; filename*=UTF-8''analysis%20result.txt",
        'report-1',
      ),
    ).toBe('analysis result.txt.html');
  });

  it('cleans path traversal, reserved characters, and control characters', () => {
    const filename = suggestedReportFilename(
      'attachment; filename="../../x\u0000:y.html"',
      'report-1',
    );

    expect(filename).toBe('_x_y.html');
    expect(filename).not.toMatch(/[\\/\u0000-\u001f\u007f]/u);
    expect(filename).not.toContain('..');
  });

  it.each([null, '', 'attachment; filename=""', 'attachment; filename*=%ZZ'])(
    'falls back to a forced .html filename for a missing or bad header',
    (contentDisposition) => {
      expect(suggestedReportFilename(contentDisposition, 'report:1')).toBe(
        'smartperfetto-report_1.html',
      );
    },
  );
});
