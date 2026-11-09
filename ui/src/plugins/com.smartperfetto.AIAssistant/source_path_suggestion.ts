// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * A source folder the user seems to be naming in the composer. This only offers
 * a card: the folder is authorized in the system dialog the card opens, never
 * from this text, and the question is sent unchanged either way.
 */

const SOURCE_WORD = /(?:源码|源代码|代码|工程|仓库|项目|source|code|repo|project)/i;
const PATH_TOKEN = /(?:^|[\s"'`“‘(（:：=])((?:~\/|\/|[A-Za-z]:\\)[^\s"'`”’)）,，;；。]*)/g;
const DESKTOP_ROOT = /^(?:~\/|\/Users\/|\/home\/|\/mnt\/|\/opt\/|\/srv\/|\/work|\/data\d*\/(?:home|code|src|work)|[A-Za-z]:\\)/;
const DEVICE_ROOT = /^\/(?:data\/(?:app|data|local|misc|user|vendor)|system|system_ext|vendor|product|apex|proc|sys|dev|storage|sdcard|odm)(?:\/|$)/;

function candidatePaths(input: string): string[] {
  const found: string[] = [];
  for (const match of input.matchAll(PATH_TOKEN)) {
    const value = match[1].replace(/[.:：]+$/, '');
    if (value.length > 1) found.push(value);
  }
  return found;
}

/** The first folder worth offering, or undefined. Device paths in trace questions never qualify. */
export function detectSourcePathSuggestion(input: string): string | undefined {
  if (input.length > 4000) return undefined;
  const paths = candidatePaths(input).filter(value => !DEVICE_ROOT.test(value));
  return paths.find(value => DESKTOP_ROOT.test(value)) ??
    (SOURCE_WORD.test(input) ? paths[0] : undefined);
}
