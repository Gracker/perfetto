// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {Engine} from 'syntaqlite';

export interface PerfettoSqlFormatResult {
  ok: boolean;
  text: string;
  error?: string;
}

const FORMAT_OPTIONS = {
  lineWidth: 80,
  indentWidth: 2,
  keywordCase: 1 as const,
  semicolons: true,
};

let formatterEnginePromise: Promise<Engine> | undefined;

function getFormatterEngine(): Promise<Engine> {
  if (formatterEnginePromise === undefined) {
    const engine = new Engine({
      runtimeJsPath: 'assets/syntaqlite-runtime.js',
      runtimeWasmPath: 'assets/syntaqlite-runtime.wasm',
    });
    formatterEnginePromise = (async () => {
      await engine.load();
      const binding = await engine.loadDialectFromUrl(
        'assets/syntaqlite-perfetto.wasm',
        'syntaqlite_perfetto_dialect_template',
      );
      engine.setDialectPointer(binding.ptr);
      return engine;
    })();
  }
  return formatterEnginePromise;
}

export async function formatPerfettoSql(
  sql: string,
): Promise<PerfettoSqlFormatResult> {
  const trimmed = sql.trim();
  if (!trimmed) return {ok: true, text: ''};

  try {
    const engine = await getFormatterEngine();
    const result = engine.runFmt(trimmed, FORMAT_OPTIONS);
    if (result.ok) {
      return {ok: true, text: result.text};
    }
    return {
      ok: false,
      text: trimmed,
      error: result.text || 'SQL formatting failed',
    };
  } catch (e) {
    return {
      ok: false,
      text: trimmed,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
