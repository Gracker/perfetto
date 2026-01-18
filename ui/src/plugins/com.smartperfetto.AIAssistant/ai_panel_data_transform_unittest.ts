// Copyright (C) 2024 SmartPerfetto
// AI Panel Data Transform Unit Tests
//
// Tests for the data transformation logic in AI Panel that handles
// StepResult format from backend skill_data events.

import {describe, it, expect} from '@jest/globals';

// =============================================================================
// Test Helpers - These mirror the logic in ai_panel.ts
// =============================================================================

/**
 * Check if an object is in StepResult format
 * StepResult: { stepId, data: [...], display, executionTimeMs? }
 */
function isStepResult(obj: any): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }
  return 'data' in obj && Array.isArray(obj.data);
}

/**
 * Extract data array from StepResult or return null
 */
function extractDataFromStepResult(obj: any): any[] | null {
  if (isStepResult(obj)) {
    return obj.data;
  }
  return null;
}

/**
 * Get display title from StepResult or use formatted key
 */
function getDisplayTitle(key: string, obj: any, defaultSkillName?: string): string {
  if (isStepResult(obj) && obj.display?.title) {
    return obj.display.title;
  }
  // Format key: snake_case to Title Case
  const formatted = key
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return defaultSkillName ? `${formatted} (${defaultSkillName})` : formatted;
}

/**
 * Format display value for table cells
 */
function formatDisplayValue(value: any, columnName?: string): string {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'number') {
    // Format percentages
    if (columnName?.includes('rate') || columnName?.includes('ratio')) {
      return `${value.toFixed(2)}%`;
    }
    // Format durations in ms
    if (columnName?.includes('dur') || columnName?.includes('time')) {
      return `${value.toFixed(2)}ms`;
    }
    // Format FPS
    if (columnName === 'fps' || columnName === 'avg_fps') {
      return value.toFixed(1);
    }
    return typeof value === 'number' && !Number.isInteger(value)
      ? value.toFixed(2)
      : String(value);
  }
  if (typeof value === 'boolean') {
    return value ? '✓' : '✗';
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? JSON.stringify(value) : '-';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

// =============================================================================
// Tests
// =============================================================================

describe('AI Panel Data Transform', () => {
  describe('isStepResult', () => {
    it('should identify valid StepResult objects', () => {
      const validStepResult = {
        stepId: 'performance_summary',
        data: [{fps: 60, jank_rate: 5.2}],
        display: {title: 'Performance Summary'},
        executionTimeMs: 123,
      };
      expect(isStepResult(validStepResult)).toBe(true);
    });

    it('should reject objects without data array', () => {
      const invalid1 = {stepId: 'test', display: {}};
      const invalid2 = {data: 'not an array'};
      const invalid3 = {data: null};

      expect(isStepResult(invalid1)).toBe(false);
      expect(isStepResult(invalid2)).toBe(false);
      expect(isStepResult(invalid3)).toBe(false);
    });

    it('should reject non-objects', () => {
      expect(isStepResult(null)).toBe(false);
      expect(isStepResult(undefined)).toBe(false);
      expect(isStepResult('string')).toBe(false);
      expect(isStepResult(123)).toBe(false);
      expect(isStepResult([1, 2, 3])).toBe(false);
    });

    it('should accept StepResult with empty data array', () => {
      const emptyData = {stepId: 'test', data: []};
      expect(isStepResult(emptyData)).toBe(true);
    });
  });

  describe('extractDataFromStepResult', () => {
    it('should extract data array from StepResult', () => {
      const stepResult = {
        stepId: 'scrolling_sessions',
        data: [
          {session_id: 1, fps: 55},
          {session_id: 2, fps: 60},
        ],
        display: {title: 'Scrolling Sessions'},
      };

      const extracted = extractDataFromStepResult(stepResult);
      expect(extracted).toEqual([
        {session_id: 1, fps: 55},
        {session_id: 2, fps: 60},
      ]);
    });

    it('should return null for non-StepResult objects', () => {
      const plainArray = [{fps: 60}];
      const plainObject = {fps: 60, jank_rate: 5};

      expect(extractDataFromStepResult(plainArray)).toBe(null);
      expect(extractDataFromStepResult(plainObject)).toBe(null);
    });
  });

  describe('getDisplayTitle', () => {
    it('should use display.title from StepResult if available', () => {
      const stepResult = {
        stepId: 'perf_summary',
        data: [{fps: 60}],
        display: {title: '性能概览'},
      };

      const title = getDisplayTitle('perf_summary', stepResult);
      expect(title).toBe('性能概览');
    });

    it('should format key when no display.title', () => {
      const stepResult = {
        stepId: 'scrolling_sessions',
        data: [{fps: 60}],
      };

      const title = getDisplayTitle('scrolling_sessions', stepResult);
      expect(title).toBe('Scrolling Sessions');
    });

    it('should append skill name context', () => {
      const plainObject = {fps: 60};
      const title = getDisplayTitle('performance_summary', plainObject, 'scrolling_analysis');
      expect(title).toBe('Performance Summary (scrolling_analysis)');
    });
  });

  describe('formatDisplayValue', () => {
    it('should format null/undefined as dash', () => {
      expect(formatDisplayValue(null)).toBe('-');
      expect(formatDisplayValue(undefined)).toBe('-');
    });

    it('should format percentages for rate columns', () => {
      expect(formatDisplayValue(5.234, 'jank_rate')).toBe('5.23%');
      expect(formatDisplayValue(10.5, 'drop_ratio')).toBe('10.50%');
    });

    it('should format durations for time columns', () => {
      expect(formatDisplayValue(16.666, 'dur_ms')).toBe('16.67ms');
      expect(formatDisplayValue(100, 'execution_time')).toBe('100.00ms');
    });

    it('should format FPS values', () => {
      expect(formatDisplayValue(59.8, 'fps')).toBe('59.8');
      expect(formatDisplayValue(30.123, 'avg_fps')).toBe('30.1');
    });

    it('should format booleans', () => {
      expect(formatDisplayValue(true)).toBe('✓');
      expect(formatDisplayValue(false)).toBe('✗');
    });

    it('should handle arrays', () => {
      expect(formatDisplayValue([])).toBe('-');
      expect(formatDisplayValue([1, 2, 3])).toBe('[1,2,3]');
    });

    it('should stringify objects', () => {
      expect(formatDisplayValue({key: 'value'})).toBe('{"key":"value"}');
    });
  });

  describe('Layer Data Processing', () => {
    it('should correctly process L1 overview layer with StepResult format', () => {
      // This is the actual format sent by backend
      const backendL1Data = {
        performance_summary: {
          stepId: 'performance_summary',
          data: [{fps: 55.2, jank_rate: 8.5, total_frames: 120}],
          display: {title: '性能概览'},
          executionTimeMs: 45,
        },
      };

      // Process each entry
      const results: any[] = [];
      for (const [key, val] of Object.entries(backendL1Data)) {
        const dataArray = extractDataFromStepResult(val);
        if (dataArray && dataArray.length > 0) {
          const firstRow = dataArray[0];
          const columns = Object.keys(firstRow);
          const title = getDisplayTitle(key, val);

          results.push({
            columns,
            data: dataArray,
            title,
          });
        }
      }

      expect(results).toHaveLength(1);
      expect(results[0].columns).toEqual(['fps', 'jank_rate', 'total_frames']);
      expect(results[0].title).toBe('性能概览');
      expect(results[0].data[0].fps).toBe(55.2);
    });

    it('should correctly process L2 list layer with StepResult format', () => {
      const backendL2Data = {
        scrolling_sessions: {
          stepId: 'scrolling_sessions',
          data: [
            {session_id: 1, start_ts: 1000000, fps: 55},
            {session_id: 2, start_ts: 2000000, fps: 60},
          ],
          display: {title: '滑动会话列表'},
        },
      };

      const results: any[] = [];
      for (const [key, value] of Object.entries(backendL2Data)) {
        let items: any[] = [];
        let displayTitle = key;

        if (isStepResult(value)) {
          items = (value as any).data;
          if ((value as any).display?.title) {
            displayTitle = (value as any).display.title;
          }
        }

        if (items.length > 0) {
          results.push({
            title: displayTitle,
            rowCount: items.length,
            columns: Object.keys(items[0]),
          });
        }
      }

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('滑动会话列表');
      expect(results[0].rowCount).toBe(2);
      expect(results[0].columns).toEqual(['session_id', 'start_ts', 'fps']);
    });

    it('should NOT show stepId/data/display/executionTimeMs as columns', () => {
      const badColumns = ['stepId', 'data', 'display', 'executionTimeMs'];

      const backendData = {
        performance_summary: {
          stepId: 'performance_summary',
          data: [{fps: 60, jank_rate: 5}],
          display: {title: 'Test'},
          executionTimeMs: 100,
        },
      };

      // Process the data correctly
      for (const [_key, val] of Object.entries(backendData)) {
        const dataArray = extractDataFromStepResult(val);
        if (dataArray && dataArray.length > 0) {
          const columns = Object.keys(dataArray[0]);

          // Verify none of the bad columns appear
          for (const badCol of badColumns) {
            expect(columns).not.toContain(badCol);
          }
        }
      }
    });
  });
});
