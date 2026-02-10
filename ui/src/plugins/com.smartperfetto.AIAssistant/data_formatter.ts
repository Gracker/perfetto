// Copyright (C) 2024 The Android Open Source Project
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

/**
 * Data formatting utilities for the AI Assistant plugin.
 *
 * This module contains pure functions for:
 * - Base64 encoding/decoding (Unicode safe)
 * - Time/duration formatting
 * - Markdown message formatting
 * - Value display formatting
 * - Data structure transformations
 * - Translation helpers
 */

import {
  FullAnalysis,
  ExpandableSections,
  isFrameDetailData,
} from './generated';

/**
 * Encode a Unicode string to Base64.
 * btoa() only supports latin1, so we convert via encodeURIComponent first.
 */
export function encodeBase64Unicode(input: string): string {
  return btoa(unescape(encodeURIComponent(input)));
}

/**
 * Decode a Base64 string to Unicode.
 */
export function decodeBase64Unicode(base64: string): string {
  return decodeURIComponent(escape(atob(base64)));
}

/**
 * Format a timestamp as a relative time string (e.g., "5 minutes ago").
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} 天前`;
  if (hours > 0) return `${hours} 小时前`;
  if (minutes > 0) return `${minutes} 分钟前`;
  return '刚刚';
}

/**
 * Format a timestamp (in nanoseconds) for human-readable display.
 */
export function formatTimestampForDisplay(timestampNs: number): string {
  if (timestampNs >= 1_000_000_000) {
    return (timestampNs / 1_000_000_000).toFixed(3) + 's';
  }
  if (timestampNs >= 1_000_000) {
    return (timestampNs / 1_000_000).toFixed(2) + 'ms';
  }
  if (timestampNs >= 1_000) {
    return (timestampNs / 1_000).toFixed(2) + 'us';
  }
  return timestampNs + 'ns';
}

/**
 * Format a scene timestamp (BigInt string from nanoseconds) to human readable.
 */
export function formatSceneTimestamp(tsNs: string): string {
  try {
    const ns = BigInt(tsNs);
    const ms = Number(ns / BigInt(1000000));
    const seconds = ms / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(3)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds.toFixed(3)}s`;
  } catch {
    return tsNs;
  }
}

/**
 * Universal value formatter for displaying any data type in tables.
 * Handles: null, undefined, numbers, bigints, objects, arrays, strings.
 *
 * @param val - The value to format
 * @param columnName - Optional column name for context-aware formatting
 * @returns Formatted string representation
 */
export function formatDisplayValue(val: any, columnName?: string): string {
  const col = (columnName || '').toLowerCase();
  const isIdentifierColumn = (name: string): boolean => {
    if (!name) return false;
    if (name.endsWith('_id')) return true;
    return [
      'id',
      'frame_id',
      'session_id',
      'scroll_id',
      'display_frame_token',
      'surface_frame_token',
      'token',
      'pid',
      'tid',
      'upid',
      'utid',
    ].includes(name);
  };

  const normalizeLooseNumericString = (input: string): string | null => {
    const compact = input.trim().replace(/[,\s，_]/g, '');
    if (!/^\d+$/.test(compact)) return null;
    return compact;
  };

  // Handle null/undefined
  if (val === null || val === undefined) {
    return '';
  }

  // Handle numbers with smart formatting
  if (typeof val === 'number') {
    if (isIdentifierColumn(col) && Number.isFinite(val)) {
      return Number.isInteger(val) ? String(Math.trunc(val)) : String(val);
    }

    // Percentage fields
    if (col.includes('rate') || col.includes('percent')) {
      // If value is already in percentage form (e.g., 6.07), don't multiply
      if (val > 1) {
        return `${val.toFixed(2)}%`;
      }
      return `${(val * 100).toFixed(1)}%`;
    }

    // Duration/time fields in nanoseconds
    if (col.includes('ns') || col.includes('_ns')) {
      if (val > 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}s`;
      if (val > 1_000_000) return `${(val / 1_000_000).toFixed(2)}ms`;
      if (val > 1000) return `${(val / 1000).toFixed(2)}µs`;
      return `${val}ns`;
    }

    // Duration/time fields in milliseconds
    if (col.includes('duration') || col.includes('time') || col.includes('ms') || col.includes('_ms')) {
      if (val > 1000) return `${(val / 1000).toFixed(2)}s`;
      return `${val.toFixed(1)}ms`;
    }

    // Large numbers get locale formatting
    if (Math.abs(val) >= 1000) {
      return val.toLocaleString();
    }

    // Small decimals
    if (!Number.isInteger(val)) {
      return val.toFixed(2);
    }

    return String(val);
  }

  // Handle bigint
  if (typeof val === 'bigint') {
    if (isIdentifierColumn(col)) {
      return val.toString();
    }

    const num = Number(val);
    if (num > 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}s`;
    if (num > 1_000_000) return `${(num / 1_000_000).toFixed(2)}ms`;
    if (num > 1000) return `${(num / 1000).toFixed(2)}µs`;
    return val.toString();
  }

  // Handle arrays
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    // For short arrays, show inline
    if (val.length <= 3) {
      return `[${val.map(v => formatDisplayValue(v)).join(', ')}]`;
    }
    return `[${val.length} items]`;
  }

  // Handle objects (nested data)
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    // For small objects, try to show key-value pairs
    if (keys.length <= 3) {
      const pairs = keys.map(k => `${k}: ${formatDisplayValue(val[k])}`);
      return `{${pairs.join(', ')}}`;
    }
    // For larger objects, use JSON
    try {
      return JSON.stringify(val);
    } catch {
      return `{${keys.length} fields}`;
    }
  }

  // Handle boolean
  if (typeof val === 'boolean') {
    return val ? '✓' : '✗';
  }

  if (typeof val === 'string' && isIdentifierColumn(col)) {
    const normalized = normalizeLooseNumericString(val);
    if (normalized !== null) return normalized;
  }

  // Default: convert to string
  return String(val);
}

/**
 * Format message content with Markdown-like syntax.
 * Processes clickable timestamps, tables, headers, links, lists, etc.
 *
 * @param content - The content string to format
 * @returns Formatted HTML string, or empty string if content is falsy
 */
export function formatMessage(content: string): string {
  // Defensive check for null/undefined/empty content
  if (!content) {
    return '';
  }

  // Process clickable timestamps: @ts[timestampNs|label]
  // Convert to clickable span elements with data attributes
  let processedContent = content.replace(
    /@ts\[(\d+)\|([^\]]+)\]/g,
    '<span class="ai-clickable-timestamp" data-ts="$1" title="点击跳转到此时间点">$2</span>'
  );

  // Process Markdown tables BEFORE other formatting
  // Match table blocks: header row, separator row, and data rows
  processedContent = processedContent.replace(
    /(\|[^\n]+\|\n\|[-:| ]+\|\n(?:\|[^\n]+\|\n?)+)/g,
    (tableBlock) => {
      const lines = tableBlock.trim().split('\n');
      if (lines.length < 2) return tableBlock;

      // Parse header
      const headerCells = lines[0]
        .split('|')
        .filter((cell) => cell.trim() !== '')
        .map((cell) => `<th>${cell.trim()}</th>`)
        .join('');

      // Skip separator line (line 1), parse data rows
      const dataRows = lines
        .slice(2)
        .map((line) => {
          const cells = line
            .split('|')
            .filter((cell) => cell.trim() !== '')
            .map((cell) => `<td>${cell.trim()}</td>`)
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');

      return `<table class="ai-md-table"><thead><tr>${headerCells}</tr></thead><tbody>${dataRows}</tbody></table>`;
    }
  );

  // Markdown-like formatting with extended support
  processedContent = processedContent
    .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
    .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
    // Image markdown: ![alt](url) - must be before link processing
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="ai-markdown-image" />')
    // Link markdown: [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/^> (.*?)$/gm, '<blockquote>$1</blockquote>')
    // Unordered list items
    .replace(/^- (.*?)$/gm, '<li class="ul-item">$1</li>')
    // Ordered list items (1. 2. 3. etc.)
    .replace(/^\d+\. (.*?)$/gm, '<li class="ol-item">$1</li>')
    .replace(/\n/g, '<br>');

  // Wrap consecutive unordered <li> elements in <ul>
  processedContent = processedContent.replace(
    /(<li class="ul-item">.*?<\/li>(?:<br>)?)+/g,
    (match) => '<ul>' + match.replace(/<br>/g, '').replace(/ class="ul-item"/g, '') + '</ul>'
  );

  // Wrap consecutive ordered <li> elements in <ol>
  processedContent = processedContent.replace(
    /(<li class="ol-item">.*?<\/li>(?:<br>)?)+/g,
    (match) => '<ol>' + match.replace(/<br>/g, '').replace(/ class="ol-item"/g, '') + '</ol>'
  );

  // Fix: Merge consecutive <br> tags to avoid excessive whitespace
  // Merge 3 or more consecutive <br> into 2
  processedContent = processedContent.replace(/(<br>){3,}/g, '<br><br>');

  return processedContent;
}

/**
 * Parse a summary string like "key1: value1, key2: value2" into table data.
 * Returns null if the string doesn't match the expected pattern.
 */
export function parseSummaryToTable(summary: string): { columns: string[], rows: string[][] } | null {
  if (!summary || typeof summary !== 'string') {
    return null;
  }

  // Try to parse formats like:
  // "key1: value1, key2: value2, key3: value3"
  // "key1: value1 | key2: value2 | key3: value3"

  // First, split by common delimiters
  const parts = summary.split(/[,|]/).map(p => p.trim()).filter(p => p);

  if (parts.length < 2) {
    // Not enough key-value pairs to make a table worthwhile
    return null;
  }

  const keyValuePairs: { key: string; value: string }[] = [];

  for (const part of parts) {
    // Match "key: value" pattern
    const match = part.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      keyValuePairs.push({
        key: match[1].trim(),
        value: match[2].trim(),
      });
    }
  }

  // Need at least 2 valid key-value pairs for a table
  if (keyValuePairs.length < 2) {
    return null;
  }

  // Create a single-row table with columns as keys
  const columns = keyValuePairs.map(kv => kv.key);
  const rows = [keyValuePairs.map(kv => formatDisplayValue(kv.value, kv.key))];

  return { columns, rows };
}

/**
 * Convert backend frame detail data to sections format expected by renderExpandableContent.
 *
 * Backend returns: FrameDetailData { diagnosis_summary, full_analysis: FullAnalysis }
 * Frontend expects: ExpandableSections { [sectionId]: { title, data: unknown[] } }
 *
 * @see generated/frame_analysis.types.ts for type definitions
 */
export function convertToExpandableSections(data: unknown): ExpandableSections {
  // Type guard: validate input format
  console.log('[convertToExpandableSections] Input data:', {
    type: typeof data,
    isNull: data === null,
    isUndefined: data === undefined,
    keys: data && typeof data === 'object' ? Object.keys(data) : [],
  });

  if (!isFrameDetailData(data)) {
    console.warn('[convertToExpandableSections] Invalid data format - failing isFrameDetailData check:', data);
    return {};
  }

  const sections: ExpandableSections = {};

  // Title mapping for each analysis type (matches FullAnalysis keys)
  const titleMap: Record<keyof FullAnalysis, string> = {
    'quadrants': '四象限分析',
    'binder_calls': 'Binder 调用',
    'cpu_frequency': 'CPU 频率',
    'main_thread_slices': '主线程耗时操作',
    'render_thread_slices': 'RenderThread 耗时操作',
    'cpu_freq_timeline': 'CPU 频率时间线',
    'lock_contentions': '锁竞争',
  };

  // Handle diagnosis_summary as a special section
  if (data.diagnosis_summary) {
    sections['diagnosis'] = {
      title: '🎯 根因诊断',
      data: [{ diagnosis: data.diagnosis_summary }],
    };
  }

  // Handle full_analysis object with typed access
  const analysis = data.full_analysis;
  if (analysis) {
    // Process quadrants - convert nested object to display array
    if (analysis.quadrants) {
      const quadrantData: Array<{ thread: string; quadrant: string; percentage: number }> = [];
      const { main_thread, render_thread } = analysis.quadrants;

      // Convert main_thread quadrants
      for (const [qKey, qValue] of Object.entries(main_thread)) {
        if (qValue > 0) {
          quadrantData.push({
            thread: '主线程',
            quadrant: qKey.toUpperCase(),
            percentage: qValue,
          });
        }
      }

      // Convert render_thread quadrants
      for (const [qKey, qValue] of Object.entries(render_thread)) {
        if (qValue > 0) {
          quadrantData.push({
            thread: 'RenderThread',
            quadrant: qKey.toUpperCase(),
            percentage: qValue,
          });
        }
      }

      if (quadrantData.length > 0) {
        sections['quadrants'] = { title: titleMap['quadrants'], data: quadrantData };
      }
    }

    // Process cpu_frequency - convert object to display array
    if (analysis.cpu_frequency) {
      const freqData: Array<{ core_type: string; avg_freq_mhz: number }> = [];
      const { big_avg_mhz, little_avg_mhz } = analysis.cpu_frequency;

      if (big_avg_mhz > 0) {
        freqData.push({ core_type: '大核', avg_freq_mhz: big_avg_mhz });
      }
      if (little_avg_mhz > 0) {
        freqData.push({ core_type: '小核', avg_freq_mhz: little_avg_mhz });
      }

      if (freqData.length > 0) {
        sections['cpu_frequency'] = { title: titleMap['cpu_frequency'], data: freqData };
      }
    }

    // Process array fields directly
    const arrayFields: Array<keyof FullAnalysis> = [
      'binder_calls',
      'main_thread_slices',
      'render_thread_slices',
      'cpu_freq_timeline',
      'lock_contentions',
    ];

    for (const field of arrayFields) {
      const value = analysis[field];
      if (Array.isArray(value) && value.length > 0) {
        sections[field] = { title: titleMap[field], data: value };
      }
    }
  }

  return sections;
}

/**
 * Format layer data key name to human-readable label.
 */
export function formatLayerName(key: string): string {
  // Common layer name mappings
  const nameMap: Record<string, string> = {
    'jank_frames': '卡顿帧',
    'scrolling_sessions': '滑动会话',
    'frame_details': '帧详情',
    'frame_analysis': '帧分析',
    'slow_frames': '慢帧',
    'blocked_frames': '阻塞帧',
    'sessions': '会话',
    'frames': '帧数据',
    'metrics': '指标',
    'overview': '概览',
    'summary': '摘要',
  };

  // Check for exact match
  const lowerKey = key.toLowerCase();
  if (nameMap[lowerKey]) {
    return nameMap[lowerKey];
  }

  // Format snake_case to readable string
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Extract conclusion from overview layer data (Phase 4).
 * Maps the root_cause_classification step output to conclusion format.
 */
export function extractConclusionFromOverview(overview: Record<string, any> | undefined): any {
  if (!overview) return null;

  // Check for conclusion data in various locations
  const conclusion = overview.conclusion || overview.root_cause_classification;
  if (conclusion && typeof conclusion === 'object') {
    // Direct conclusion object
    if (conclusion.problem_category || conclusion.category) {
      return {
        category: conclusion.problem_category || conclusion.category,
        component: conclusion.problem_component || conclusion.component,
        confidence: conclusion.confidence || 0.5,
        summary: conclusion.root_cause_summary || conclusion.summary || '',
        evidence: parseEvidence(conclusion.evidence),
        suggestion: conclusion.suggestion,
      };
    }
  }

  // Check if conclusion fields are at the top level of overview
  if (overview.problem_category) {
    return {
      category: overview.problem_category,
      component: overview.problem_component,
      confidence: overview.confidence || 0.5,
      summary: overview.root_cause_summary || '',
      evidence: parseEvidence(overview.evidence),
      suggestion: overview.suggestion,
    };
  }

  return null;
}

/**
 * Parse evidence field which may be JSON string or array.
 */
export function parseEvidence(evidence: any): string[] {
  if (!evidence) return [];
  if (Array.isArray(evidence)) return evidence;
  if (typeof evidence === 'string') {
    try {
      const parsed = JSON.parse(evidence);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [evidence];
    }
  }
  return [];
}

/**
 * Translate problem category to Chinese (Phase 4).
 */
export function translateCategory(category: string): string {
  const translations: Record<string, string> = {
    'APP': '应用问题',
    'SYSTEM': '系统问题',
    'MIXED': '混合问题',
    'UNKNOWN': '未知',
  };
  return translations[category] || category;
}

/**
 * Translate problem component to Chinese (Phase 4).
 */
export function translateComponent(component: string): string {
  const translations: Record<string, string> = {
    'MAIN_THREAD': '主线程',
    'RENDER_THREAD': '渲染线程',
    'SURFACE_FLINGER': 'SurfaceFlinger',
    'BINDER': 'Binder 跨进程调用',
    'CPU_SCHEDULING': 'CPU 调度',
    'CPU_AFFINITY': 'CPU 亲和性',
    'GPU': 'GPU',
    'MEMORY': '内存',
    'IO': 'IO',
    'MAIN_THREAD_BLOCKING': '主线程阻塞',
    'UNKNOWN': '未知',
  };
  return translations[component] || component;
}

/**
 * DataFormatter class providing convenient access to all formatting functions.
 * Can be used as a singleton or instantiated for testing.
 */
export class DataFormatter {
  encodeBase64Unicode = encodeBase64Unicode;
  decodeBase64Unicode = decodeBase64Unicode;
  formatRelativeTime = formatRelativeTime;
  formatTimestampForDisplay = formatTimestampForDisplay;
  formatSceneTimestamp = formatSceneTimestamp;
  formatDisplayValue = formatDisplayValue;
  formatMessage = formatMessage;
  parseSummaryToTable = parseSummaryToTable;
  convertToExpandableSections = convertToExpandableSections;
  formatLayerName = formatLayerName;
  extractConclusionFromOverview = extractConclusionFromOverview;
  parseEvidence = parseEvidence;
  translateCategory = translateCategory;
  translateComponent = translateComponent;
}
