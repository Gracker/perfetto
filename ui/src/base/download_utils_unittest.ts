// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {download} from './download_utils';

function installFilePicker(options: {
  pickerError?: unknown;
  writeError?: unknown;
}): void {
  const writable = {
    write:
      options.writeError !== undefined
        ? vi.fn().mockRejectedValue(options.writeError)
        : vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const picker =
    options.pickerError !== undefined
      ? vi.fn().mockRejectedValue(options.pickerError)
      : vi.fn().mockResolvedValue({
          createWritable: vi.fn().mockResolvedValue(writable),
        });
  window.showSaveFilePicker =
    picker as unknown as typeof window.showSaveFilePicker;
}

afterEach(() => {
  delete (window as Partial<Window>).showSaveFilePicker;
  vi.restoreAllMocks();
});

describe('download file picker errors', () => {
  it('returns cancelled without logging when the user closes the picker', async () => {
    installFilePicker({
      pickerError: new DOMException('cancelled', 'AbortError'),
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await expect(
      download({
        content: 'report',
        fileName: 'report.html',
        filePicker: {throwOnError: true},
      }),
    ).resolves.toBe('cancelled');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('propagates a real write failure for strict callers', async () => {
    installFilePicker({writeError: new Error('disk full')});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      download({
        content: 'report',
        fileName: 'report.html',
        filePicker: {throwOnError: true},
      }),
    ).rejects.toThrow('disk full');
  });

  it('keeps the existing best-effort behavior for other callers', async () => {
    installFilePicker({writeError: new Error('permission denied')});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      download({
        content: 'trace',
        fileName: 'trace.pftrace',
        filePicker: {},
      }),
    ).resolves.toBe('failed');
  });
});
