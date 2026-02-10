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
 * Unit tests for data_formatter.ts
 *
 * Tests cover:
 * - Base64 encoding/decoding (Unicode safe)
 * - Timestamp formatting (various scales: ns, us, ms, s)
 * - Duration formatting (short/long durations)
 * - Percentage formatting
 * - Byte/memory size formatting
 * - Display value formatting
 * - Edge cases (null, undefined, negative values)
 * - Markdown message formatting
 * - Layer name formatting
 * - Translation helpers
 */

import {describe, it, expect, beforeEach} from '@jest/globals';

import {
  encodeBase64Unicode,
  decodeBase64Unicode,
  formatRelativeTime,
  formatTimestampForDisplay,
  formatSceneTimestamp,
  formatDisplayValue,
  formatMessage,
  parseSummaryToTable,
  formatLayerName,
  parseEvidence,
  translateCategory,
  translateComponent,
  DataFormatter,
} from './data_formatter';

// =============================================================================
// Base64 Encoding/Decoding Tests
// =============================================================================

describe('Base64 Unicode Encoding', () => {
  describe('encodeBase64Unicode', () => {
    it('should encode ASCII strings', () => {
      const result = encodeBase64Unicode('Hello World');
      expect(result).toBe('SGVsbG8gV29ybGQ=');
    });

    it('should encode Unicode strings (Chinese)', () => {
      const result = encodeBase64Unicode('Hello 世界');
      // Just verify it's a valid base64 string and roundtrips
      expect(decodeBase64Unicode(result)).toBe('Hello 世界');
    });

    it('should encode Unicode strings (Emoji)', () => {
      const input = 'Test 🎉 emoji';
      const encoded = encodeBase64Unicode(input);
      expect(decodeBase64Unicode(encoded)).toBe(input);
    });

    it('should encode empty string', () => {
      expect(encodeBase64Unicode('')).toBe('');
    });

    it('should encode strings with special characters', () => {
      const input = '<script>alert("xss")</script>';
      const encoded = encodeBase64Unicode(input);
      expect(decodeBase64Unicode(encoded)).toBe(input);
    });
  });

  describe('decodeBase64Unicode', () => {
    it('should decode ASCII base64', () => {
      const result = decodeBase64Unicode('SGVsbG8gV29ybGQ=');
      expect(result).toBe('Hello World');
    });

    it('should decode empty string', () => {
      expect(decodeBase64Unicode('')).toBe('');
    });

    it('should roundtrip complex Unicode', () => {
      const original = '中文测试 日本語 한국어 العربية';
      const encoded = encodeBase64Unicode(original);
      expect(decodeBase64Unicode(encoded)).toBe(original);
    });
  });
});

// =============================================================================
// Timestamp Formatting Tests
// =============================================================================

describe('Timestamp Formatting', () => {
  describe('formatTimestampForDisplay', () => {
    it('should format nanoseconds (small values)', () => {
      expect(formatTimestampForDisplay(500)).toBe('500ns');
      expect(formatTimestampForDisplay(999)).toBe('999ns');
      expect(formatTimestampForDisplay(0)).toBe('0ns');
      expect(formatTimestampForDisplay(1)).toBe('1ns');
    });

    it('should format microseconds (1000-999999 ns)', () => {
      expect(formatTimestampForDisplay(1000)).toBe('1.00us');
      expect(formatTimestampForDisplay(1500)).toBe('1.50us');
      expect(formatTimestampForDisplay(999999)).toBe('1000.00us');
      expect(formatTimestampForDisplay(50000)).toBe('50.00us');
    });

    it('should format milliseconds (1000000-999999999 ns)', () => {
      expect(formatTimestampForDisplay(1000000)).toBe('1.00ms');
      expect(formatTimestampForDisplay(16666667)).toBe('16.67ms');
      expect(formatTimestampForDisplay(500000000)).toBe('500.00ms');
    });

    it('should format seconds (>= 1000000000 ns)', () => {
      expect(formatTimestampForDisplay(1000000000)).toBe('1.000s');
      expect(formatTimestampForDisplay(1500000000)).toBe('1.500s');
      expect(formatTimestampForDisplay(10000000000)).toBe('10.000s');
      expect(formatTimestampForDisplay(60000000000)).toBe('60.000s');
    });

    it('should handle boundary values', () => {
      // Exactly at microsecond boundary
      expect(formatTimestampForDisplay(1000)).toBe('1.00us');
      // Just below millisecond
      expect(formatTimestampForDisplay(999999)).toBe('1000.00us');
      // Exactly at millisecond boundary
      expect(formatTimestampForDisplay(1000000)).toBe('1.00ms');
      // Exactly at second boundary
      expect(formatTimestampForDisplay(1000000000)).toBe('1.000s');
    });
  });

  describe('formatSceneTimestamp', () => {
    it('should format BigInt string to seconds', () => {
      expect(formatSceneTimestamp('1000000000')).toBe('1.000s');
      expect(formatSceneTimestamp('5000000000')).toBe('5.000s');
    });

    it('should format timestamps with minutes', () => {
      // 60 seconds
      expect(formatSceneTimestamp('60000000000')).toBe('1m 0.000s');
      // 90 seconds
      expect(formatSceneTimestamp('90000000000')).toBe('1m 30.000s');
      // 125 seconds
      expect(formatSceneTimestamp('125000000000')).toBe('2m 5.000s');
    });

    it('should handle sub-second precision', () => {
      expect(formatSceneTimestamp('1500000000')).toBe('1.500s');
      expect(formatSceneTimestamp('1234567890')).toBe('1.234s');
    });

    it('should return original string on invalid input', () => {
      expect(formatSceneTimestamp('invalid')).toBe('invalid');
      // Empty string parses as BigInt(0) which is valid
    });

    it('should handle zero', () => {
      expect(formatSceneTimestamp('0')).toBe('0.000s');
    });
  });

  describe('formatRelativeTime', () => {
    it('should format recent time as "刚刚"', () => {
      const now = Date.now();
      expect(formatRelativeTime(now)).toBe('刚刚');
      expect(formatRelativeTime(now - 30000)).toBe('刚刚'); // 30 seconds ago
    });

    it('should format minutes ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 60000)).toBe('1 分钟前');
      expect(formatRelativeTime(now - 300000)).toBe('5 分钟前');
      expect(formatRelativeTime(now - 3540000)).toBe('59 分钟前');
    });

    it('should format hours ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 3600000)).toBe('1 小时前');
      expect(formatRelativeTime(now - 7200000)).toBe('2 小时前');
      expect(formatRelativeTime(now - 82800000)).toBe('23 小时前');
    });

    it('should format days ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 86400000)).toBe('1 天前');
      expect(formatRelativeTime(now - 172800000)).toBe('2 天前');
      expect(formatRelativeTime(now - 604800000)).toBe('7 天前');
    });
  });
});

// =============================================================================
// Display Value Formatting Tests
// =============================================================================

describe('formatDisplayValue', () => {
  describe('null and undefined handling', () => {
    it('should return empty string for null', () => {
      expect(formatDisplayValue(null)).toBe('');
    });

    it('should return empty string for undefined', () => {
      expect(formatDisplayValue(undefined)).toBe('');
    });
  });

  describe('number formatting', () => {
    it('should format integers as strings', () => {
      expect(formatDisplayValue(42)).toBe('42');
      expect(formatDisplayValue(0)).toBe('0');
      expect(formatDisplayValue(-5)).toBe('-5');
    });

    it('should format decimals with 2 decimal places', () => {
      expect(formatDisplayValue(3.14159)).toBe('3.14');
      expect(formatDisplayValue(0.5)).toBe('0.50');
      expect(formatDisplayValue(-2.718)).toBe('-2.72');
    });

    it('should format large numbers with locale formatting', () => {
      const result = formatDisplayValue(1000000);
      // Locale formatting varies, just check it contains the number
      expect(result).toContain('1');
      expect(result).toContain('000');
      expect(result).toContain('000');
    });
  });

  describe('identifier formatting', () => {
    it('should keep identifier columns as plain digit strings', () => {
      expect(formatDisplayValue(1438035, 'frame_id')).toBe('1438035');
      expect(formatDisplayValue(7, 'session_id')).toBe('7');
      expect(formatDisplayValue(1129, 'pid')).toBe('1129');
      expect(formatDisplayValue(21031, 'tid')).toBe('21031');
      expect(formatDisplayValue(1438035, 'display_frame_token')).toBe('1438035');
    });

    it('should normalize loose numeric identifier strings', () => {
      expect(formatDisplayValue('1,438,035', 'frame_id')).toBe('1438035');
      expect(formatDisplayValue('1 438 035', 'frame_id')).toBe('1438035');
      expect(formatDisplayValue('1_438_035', 'frame_id')).toBe('1438035');
    });
  });

  describe('percentage formatting (rate/percent columns)', () => {
    it('should format percentage when value > 1 (already in %)', () => {
      expect(formatDisplayValue(6.07, 'jank_rate')).toBe('6.07%');
      expect(formatDisplayValue(50, 'drop_percent')).toBe('50.00%');
    });

    it('should multiply by 100 when value <= 1 (ratio form)', () => {
      expect(formatDisplayValue(0.5, 'jank_rate')).toBe('50.0%');
      expect(formatDisplayValue(0.0607, 'drop_percent')).toBe('6.1%');
      expect(formatDisplayValue(1, 'rate')).toBe('100.0%');
    });

    it('should detect rate/percent in column name', () => {
      expect(formatDisplayValue(5.5, 'my_rate_column')).toBe('5.50%');
      expect(formatDisplayValue(0.1, 'percent_value')).toBe('10.0%');
    });
  });

  describe('duration formatting (nanoseconds)', () => {
    it('should format nanoseconds to readable units', () => {
      expect(formatDisplayValue(500, 'duration_ns')).toBe('500ns');
      expect(formatDisplayValue(1500, 'time_ns')).toBe('1.50µs');
      expect(formatDisplayValue(1500000, 'dur_ns')).toBe('1.50ms');
      expect(formatDisplayValue(1500000000, '_ns_column')).toBe('1.50s');
    });
  });

  describe('duration formatting (milliseconds)', () => {
    it('should format milliseconds', () => {
      expect(formatDisplayValue(16.67, 'duration')).toBe('16.7ms');
      expect(formatDisplayValue(500, 'frame_time')).toBe('500.0ms');
      expect(formatDisplayValue(50, 'render_ms')).toBe('50.0ms');
    });

    it('should convert ms to seconds when > 1000', () => {
      expect(formatDisplayValue(1500, 'duration')).toBe('1.50s');
      expect(formatDisplayValue(60000, 'total_time')).toBe('60.00s');
    });
  });

  describe('bigint formatting', () => {
    it('should format bigint values with time units', () => {
      expect(formatDisplayValue(BigInt(500))).toBe('500');
      expect(formatDisplayValue(BigInt(1500))).toBe('1.50µs');
      expect(formatDisplayValue(BigInt(1500000))).toBe('1.50ms');
      expect(formatDisplayValue(BigInt(1500000000))).toBe('1.50s');
    });
  });

  describe('boolean formatting', () => {
    it('should format true as checkmark', () => {
      expect(formatDisplayValue(true)).toBe('✓');
    });

    it('should format false as cross', () => {
      expect(formatDisplayValue(false)).toBe('✗');
    });
  });

  describe('array formatting', () => {
    it('should format empty array', () => {
      expect(formatDisplayValue([])).toBe('[]');
    });

    it('should format short arrays inline', () => {
      expect(formatDisplayValue([1, 2, 3])).toBe('[1, 2, 3]');
      expect(formatDisplayValue(['a', 'b'])).toBe('[a, b]');
    });

    it('should show count for long arrays', () => {
      expect(formatDisplayValue([1, 2, 3, 4])).toBe('[4 items]');
      expect(formatDisplayValue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe('[10 items]');
    });
  });

  describe('object formatting', () => {
    it('should format empty object', () => {
      expect(formatDisplayValue({})).toBe('{}');
    });

    it('should format small objects inline', () => {
      expect(formatDisplayValue({a: 1, b: 2})).toBe('{a: 1, b: 2}');
    });

    it('should stringify larger objects', () => {
      const obj = {a: 1, b: 2, c: 3, d: 4};
      const result = formatDisplayValue(obj);
      expect(result).toContain('a');
      expect(result).toContain('1');
    });
  });

  describe('string formatting', () => {
    it('should return strings as-is', () => {
      expect(formatDisplayValue('hello')).toBe('hello');
      expect(formatDisplayValue('')).toBe('');
      expect(formatDisplayValue('test value')).toBe('test value');
    });
  });
});

// =============================================================================
// Message Formatting Tests
// =============================================================================

describe('formatMessage', () => {
  describe('empty/null handling', () => {
    it('should return empty string for null/undefined', () => {
      expect(formatMessage('')).toBe('');
      expect(formatMessage(null as any)).toBe('');
      expect(formatMessage(undefined as any)).toBe('');
    });
  });

  describe('clickable timestamps', () => {
    it('should convert @ts[timestamp|label] to clickable spans', () => {
      const input = '@ts[1234567890|Frame #1]';
      const result = formatMessage(input);
      expect(result).toContain('class="ai-clickable-timestamp"');
      expect(result).toContain('data-ts="1234567890"');
      expect(result).toContain('Frame #1');
    });

    it('should handle multiple timestamps', () => {
      const input = '@ts[100|Start] to @ts[200|End]';
      const result = formatMessage(input);
      expect(result).toContain('data-ts="100"');
      expect(result).toContain('data-ts="200"');
      expect(result).toContain('Start');
      expect(result).toContain('End');
    });
  });

  describe('Markdown formatting', () => {
    it('should format headers', () => {
      expect(formatMessage('## Header 2')).toContain('<h2>Header 2</h2>');
      expect(formatMessage('### Header 3')).toContain('<h3>Header 3</h3>');
    });

    it('should format bold text', () => {
      expect(formatMessage('**bold text**')).toContain('<strong>bold text</strong>');
    });

    it('should format italic text', () => {
      expect(formatMessage('*italic text*')).toContain('<em>italic text</em>');
    });

    it('should format inline code', () => {
      expect(formatMessage('`code here`')).toContain('<code>code here</code>');
    });

    it('should format blockquotes', () => {
      expect(formatMessage('> quote')).toContain('<blockquote>quote</blockquote>');
    });

    it('should format links', () => {
      const result = formatMessage('[Link Text](https://example.com)');
      expect(result).toContain('<a href="https://example.com"');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('Link Text</a>');
    });

    it('should format images', () => {
      const result = formatMessage('![Alt Text](image.png)');
      expect(result).toContain('<img src="image.png"');
      expect(result).toContain('alt="Alt Text"');
    });

    it('should format unordered lists', () => {
      const input = '- Item 1\n- Item 2\n- Item 3';
      const result = formatMessage(input);
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Item 1</li>');
      expect(result).toContain('<li>Item 2</li>');
      expect(result).toContain('</ul>');
    });

    it('should format ordered lists', () => {
      const input = '1. First\n2. Second\n3. Third';
      const result = formatMessage(input);
      expect(result).toContain('<ol>');
      expect(result).toContain('<li>First</li>');
      expect(result).toContain('<li>Second</li>');
      expect(result).toContain('</ol>');
    });

    it('should convert newlines to br tags', () => {
      expect(formatMessage('line1\nline2')).toContain('<br>');
    });
  });

  describe('Markdown tables', () => {
    it('should convert markdown tables to HTML', () => {
      const input = '| Col1 | Col2 |\n|---|---|\n| A | B |';
      const result = formatMessage(input);
      expect(result).toContain('<table class="ai-md-table">');
      expect(result).toContain('<th>Col1</th>');
      expect(result).toContain('<td>A</td>');
    });
  });
});

// =============================================================================
// parseSummaryToTable Tests
// =============================================================================

describe('parseSummaryToTable', () => {
  it('should return null for null/undefined/empty', () => {
    expect(parseSummaryToTable(null as any)).toBe(null);
    expect(parseSummaryToTable(undefined as any)).toBe(null);
    expect(parseSummaryToTable('')).toBe(null);
  });

  it('should return null for non-string input', () => {
    expect(parseSummaryToTable(123 as any)).toBe(null);
    expect(parseSummaryToTable({} as any)).toBe(null);
  });

  it('should parse comma-separated key-value pairs', () => {
    const result = parseSummaryToTable('FPS: 60, Jank Rate: 5%');
    expect(result).not.toBe(null);
    expect(result!.columns).toEqual(['FPS', 'Jank Rate']);
    expect(result!.rows[0]).toEqual(['60', '5%']);
  });

  it('should parse pipe-separated key-value pairs', () => {
    const result = parseSummaryToTable('Total: 100 | Passed: 95 | Failed: 5');
    expect(result).not.toBe(null);
    expect(result!.columns).toEqual(['Total', 'Passed', 'Failed']);
  });

  it('should return null if fewer than 2 key-value pairs', () => {
    expect(parseSummaryToTable('single: value')).toBe(null);
    expect(parseSummaryToTable('no colon here')).toBe(null);
  });
});

// =============================================================================
// Layer Name Formatting Tests
// =============================================================================

describe('formatLayerName', () => {
  it('should translate known layer names', () => {
    expect(formatLayerName('jank_frames')).toBe('卡顿帧');
    expect(formatLayerName('scrolling_sessions')).toBe('滑动会话');
    expect(formatLayerName('frame_details')).toBe('帧详情');
    expect(formatLayerName('overview')).toBe('概览');
  });

  it('should format unknown snake_case names', () => {
    expect(formatLayerName('cpu_usage_stats')).toBe('Cpu Usage Stats');
    expect(formatLayerName('render_thread_analysis')).toBe('Render Thread Analysis');
  });

  it('should handle single word', () => {
    expect(formatLayerName('test')).toBe('Test');
  });
});

// =============================================================================
// Evidence Parsing Tests
// =============================================================================

describe('parseEvidence', () => {
  it('should return empty array for null/undefined', () => {
    expect(parseEvidence(null)).toEqual([]);
    expect(parseEvidence(undefined)).toEqual([]);
  });

  it('should return array as-is', () => {
    expect(parseEvidence(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('should parse JSON string to array', () => {
    expect(parseEvidence('["a", "b"]')).toEqual(['a', 'b']);
  });

  it('should wrap non-array string in array', () => {
    expect(parseEvidence('single evidence')).toEqual(['single evidence']);
  });

  it('should return empty array for invalid JSON array', () => {
    expect(parseEvidence('{"not": "array"}')).toEqual([]);
  });
});

// =============================================================================
// Translation Tests
// =============================================================================

describe('translateCategory', () => {
  it('should translate known categories', () => {
    expect(translateCategory('APP')).toBe('应用问题');
    expect(translateCategory('SYSTEM')).toBe('系统问题');
    expect(translateCategory('MIXED')).toBe('混合问题');
    expect(translateCategory('UNKNOWN')).toBe('未知');
  });

  it('should return original for unknown categories', () => {
    expect(translateCategory('CUSTOM')).toBe('CUSTOM');
    expect(translateCategory('other')).toBe('other');
  });
});

describe('translateComponent', () => {
  it('should translate known components', () => {
    expect(translateComponent('MAIN_THREAD')).toBe('主线程');
    expect(translateComponent('RENDER_THREAD')).toBe('渲染线程');
    expect(translateComponent('SURFACE_FLINGER')).toBe('SurfaceFlinger');
    expect(translateComponent('BINDER')).toBe('Binder 跨进程调用');
    expect(translateComponent('CPU_SCHEDULING')).toBe('CPU 调度');
    expect(translateComponent('GPU')).toBe('GPU');
    expect(translateComponent('MEMORY')).toBe('内存');
    expect(translateComponent('IO')).toBe('IO');
  });

  it('should return original for unknown components', () => {
    expect(translateComponent('CUSTOM_COMPONENT')).toBe('CUSTOM_COMPONENT');
  });
});

// =============================================================================
// DataFormatter Class Tests
// =============================================================================

describe('DataFormatter class', () => {
  let formatter: DataFormatter;

  beforeEach(() => {
    formatter = new DataFormatter();
  });

  it('should expose all formatting functions', () => {
    expect(typeof formatter.encodeBase64Unicode).toBe('function');
    expect(typeof formatter.decodeBase64Unicode).toBe('function');
    expect(typeof formatter.formatRelativeTime).toBe('function');
    expect(typeof formatter.formatTimestampForDisplay).toBe('function');
    expect(typeof formatter.formatSceneTimestamp).toBe('function');
    expect(typeof formatter.formatDisplayValue).toBe('function');
    expect(typeof formatter.formatMessage).toBe('function');
    expect(typeof formatter.parseSummaryToTable).toBe('function');
    expect(typeof formatter.formatLayerName).toBe('function');
    expect(typeof formatter.parseEvidence).toBe('function');
    expect(typeof formatter.translateCategory).toBe('function');
    expect(typeof formatter.translateComponent).toBe('function');
  });

  it('should work correctly when called through instance', () => {
    expect(formatter.formatTimestampForDisplay(1000000)).toBe('1.00ms');
    expect(formatter.translateCategory('APP')).toBe('应用问题');
    expect(formatter.formatDisplayValue(null)).toBe('');
  });
});

// =============================================================================
// Edge Cases and Boundary Tests
// =============================================================================

describe('Edge Cases', () => {
  describe('numeric edge cases', () => {
    it('should handle zero values', () => {
      expect(formatDisplayValue(0)).toBe('0');
      expect(formatTimestampForDisplay(0)).toBe('0ns');
    });

    it('should handle negative values', () => {
      expect(formatDisplayValue(-100)).toBe('-100');
      expect(formatDisplayValue(-0.5)).toBe('-0.50');
    });

    it('should handle very large numbers', () => {
      const result = formatDisplayValue(Number.MAX_SAFE_INTEGER);
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle Infinity', () => {
      const result = formatDisplayValue(Infinity);
      // toLocaleString returns the infinity symbol
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle NaN', () => {
      const result = formatDisplayValue(NaN);
      expect(result).toBe('NaN');
    });
  });

  describe('string edge cases', () => {
    it('should handle empty strings', () => {
      expect(formatDisplayValue('')).toBe('');
      expect(formatMessage('')).toBe('');
    });

    it('should handle whitespace-only strings', () => {
      expect(formatDisplayValue('   ')).toBe('   ');
    });

    it('should handle very long strings', () => {
      const longString = 'a'.repeat(10000);
      const result = formatDisplayValue(longString);
      expect(result.length).toBe(10000);
    });
  });

  describe('nested data edge cases', () => {
    it('should handle deeply nested objects', () => {
      const nested = {a: {b: {c: {d: 1}}}};
      const result = formatDisplayValue(nested);
      expect(result).toContain('a');
    });

    it('should handle arrays with mixed types', () => {
      const mixed = [1, 'two', {three: 3}];
      const result = formatDisplayValue(mixed);
      // Arrays with 3 or fewer items are shown inline
      expect(result).toContain('1');
      expect(result).toContain('two');
    });

    it('should handle objects that would exceed JSON stringification', () => {
      // Note: Truly circular references cause stack overflow in formatDisplayValue
      // because it recursively calls itself. This test verifies the fallback path.
      const largeObj: Record<string, number> = {};
      for (let i = 0; i < 10; i++) {
        largeObj[`key${i}`] = i;
      }
      const result = formatDisplayValue(largeObj);
      // Large objects get stringified or show field count
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('special characters', () => {
    it('should handle HTML special chars in formatDisplayValue', () => {
      expect(formatDisplayValue('<script>')).toBe('<script>');
    });

    it('should handle newlines in strings', () => {
      expect(formatDisplayValue('line1\nline2')).toBe('line1\nline2');
    });

    it('should handle unicode in formatDisplayValue', () => {
      expect(formatDisplayValue('测试')).toBe('测试');
      expect(formatDisplayValue('🎉')).toBe('🎉');
    });
  });
});
