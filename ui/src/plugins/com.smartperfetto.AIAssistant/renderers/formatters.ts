/**
 * Value Formatters
 *
 * Formatters for different data types and formats.
 * Used by schema-driven rendering to display values correctly.
 *
 * @module formatters
 * @version 2.0.0
 */

import {
  ColumnDefinition,
  ColumnType,
} from '../generated/data_contract.types';

// =============================================================================
// Time Constants
// =============================================================================

const NS_PER_US = 1e3;
const NS_PER_MS = 1e6;
const NS_PER_S = 1e9;

// Unit conversion multipliers to nanoseconds
const UNIT_TO_NS: Record<string, number> = {
  ns: 1,
  us: NS_PER_US,
  ms: NS_PER_MS,
  s: NS_PER_S,
};

// =============================================================================
// Number Formatters
// =============================================================================

/**
 * Format a number with compact notation (e.g., 1.2M, 3.5K)
 */
export function formatCompact(value: number): string {
  if (Math.abs(value) >= 1e9) {
    return (value / 1e9).toFixed(1) + 'B';
  }
  if (Math.abs(value) >= 1e6) {
    return (value / 1e6).toFixed(1) + 'M';
  }
  if (Math.abs(value) >= 1e3) {
    return (value / 1e3).toFixed(1) + 'K';
  }
  return value.toFixed(0);
}

/**
 * Format a percentage value
 */
export function formatPercentage(value: number, decimals = 1): string {
  // Handle values already in percentage form (0-100)
  if (value > 1) {
    return value.toFixed(decimals) + '%';
  }
  // Handle values in decimal form (0-1)
  return (value * 100).toFixed(decimals) + '%';
}

/**
 * Format a byte size in human-readable form
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return size.toFixed(unitIndex === 0 ? 0 : 1) + ' ' + units[unitIndex];
}

// =============================================================================
// Duration Formatters
// =============================================================================

/**
 * Convert a value to nanoseconds based on its unit
 */
export function toNanoseconds(value: number, unit: string = 'ns'): number {
  const multiplier = UNIT_TO_NS[unit] || 1;
  return value * multiplier;
}

/**
 * Format duration in milliseconds
 */
export function formatDurationMs(ns: number, decimals = 2): string {
  const ms = ns / NS_PER_MS;
  return ms.toFixed(decimals) + ' ms';
}

/**
 * Format duration in microseconds
 */
export function formatDurationUs(ns: number, decimals = 1): string {
  const us = ns / NS_PER_US;
  return us.toFixed(decimals) + ' μs';
}

/**
 * Format duration in the most appropriate unit
 */
export function formatDurationAuto(ns: number): string {
  if (ns >= NS_PER_S) {
    return (ns / NS_PER_S).toFixed(2) + ' s';
  }
  if (ns >= NS_PER_MS) {
    return (ns / NS_PER_MS).toFixed(2) + ' ms';
  }
  if (ns >= NS_PER_US) {
    return (ns / NS_PER_US).toFixed(1) + ' μs';
  }
  return ns.toFixed(0) + ' ns';
}

// =============================================================================
// Timestamp Formatters
// =============================================================================

/**
 * Format timestamp as relative offset from trace start
 */
export function formatTimestampRelative(ns: number, traceStartNs = 0): string {
  const offsetNs = ns - traceStartNs;
  return formatDurationAuto(offsetNs);
}

/**
 * Format timestamp as absolute ISO string
 */
export function formatTimestampAbsolute(ns: number): string {
  // Assume ns since Unix epoch for absolute timestamps
  const ms = ns / NS_PER_MS;
  return new Date(ms).toISOString();
}

// =============================================================================
// String Formatters
// =============================================================================

/**
 * Truncate a string with ellipsis
 */
export function truncateString(value: string, maxLength = 50): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.substring(0, maxLength - 3) + '...';
}

/**
 * Format a boolean value
 */
export function formatBoolean(value: boolean): string {
  return value ? '✓' : '✗';
}

// =============================================================================
// Main Format Function
// =============================================================================

/**
 * Format a cell value based on column definition
 */
export function formatCellValue(
  value: unknown,
  column: ColumnDefinition,
  options: {
    traceStartNs?: number;
  } = {}
): string {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return '-';
  }

  // Get the value in the correct unit (for duration/timestamp)
  let numValue: number | undefined;
  if (typeof value === 'number') {
    numValue = value;
    // Convert to nanoseconds if unit is specified
    if (column.unit && (column.type === 'timestamp' || column.type === 'duration')) {
      numValue = toNanoseconds(value, column.unit);
    }
  }

  // Format based on column format (explicit format takes precedence)
  const format = column.format || 'default';

  switch (format) {
    case 'compact':
      return numValue !== undefined ? formatCompact(numValue) : String(value);

    case 'percentage':
      return numValue !== undefined ? formatPercentage(numValue) : String(value);

    case 'duration_ms':
      return numValue !== undefined ? formatDurationMs(numValue) : String(value);

    case 'duration_us':
      return numValue !== undefined ? formatDurationUs(numValue) : String(value);

    case 'timestamp_relative':
      return numValue !== undefined
        ? formatTimestampRelative(numValue, options.traceStartNs || 0)
        : String(value);

    case 'timestamp_absolute':
      return numValue !== undefined ? formatTimestampAbsolute(numValue) : String(value);

    case 'bytes_human':
      return numValue !== undefined ? formatBytes(numValue) : String(value);

    case 'code':
      return String(value); // Will be styled with monospace CSS

    case 'truncate':
      return typeof value === 'string' ? truncateString(value) : String(value);

    case 'full':
      return String(value);

    case 'default':
    default:
      // Use type-based default formatting
      return formatByType(value, column.type);
  }
}

/**
 * Format a value based on its column type (default formatting)
 */
function formatByType(value: unknown, type: ColumnType): string {
  switch (type) {
    case 'number':
      return typeof value === 'number' ? value.toLocaleString() : String(value);

    case 'timestamp':
      return typeof value === 'number' ? formatTimestampRelative(value) : String(value);

    case 'duration':
      return typeof value === 'number' ? formatDurationAuto(value) : String(value);

    case 'percentage':
      return typeof value === 'number' ? formatPercentage(value) : String(value);

    case 'bytes':
      return typeof value === 'number' ? formatBytes(value) : String(value);

    case 'boolean':
      return formatBoolean(!!value);

    case 'json':
      return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

    case 'link':
    case 'string':
    case 'enum':
    default:
      return String(value);
  }
}

// =============================================================================
// CSS Class Helpers
// =============================================================================

/**
 * Get CSS classes for a column based on its definition
 */
export function getColumnClasses(column: ColumnDefinition): string {
  const classes: string[] = [];

  // Type-based classes
  if (column.type === 'number' || column.type === 'duration' || column.type === 'bytes') {
    classes.push('col-numeric');
  }
  if (column.type === 'timestamp') {
    classes.push('col-timestamp', 'col-clickable');
  }
  if (column.type === 'duration') {
    classes.push('col-duration');
  }
  if (column.type === 'percentage') {
    classes.push('col-percentage');
  }
  if (column.type === 'boolean') {
    classes.push('col-boolean');
  }

  // Format-based classes
  if (column.format === 'code') {
    classes.push('col-code');
  }

  // Click action classes
  if (column.clickAction === 'navigate_timeline' || column.clickAction === 'navigate_range') {
    classes.push('col-clickable', 'col-timestamp');
  }
  if (column.clickAction === 'link') {
    classes.push('col-clickable', 'col-link');
  }

  // Width classes
  if (column.width === 'narrow') {
    classes.push('col-narrow');
  } else if (column.width === 'wide') {
    classes.push('col-wide');
  }

  // Hidden class
  if (column.hidden) {
    classes.push('col-hidden');
  }

  // Custom CSS class
  if (column.cssClass) {
    classes.push(column.cssClass);
  }

  return classes.join(' ');
}

/**
 * Get CSS classes for a cell value based on column definition and value
 */
export function getCellClasses(
  value: unknown,
  column: ColumnDefinition,
  _rowData?: Record<string, unknown>
): string {
  const classes: string[] = [];

  // Inherit column classes
  classes.push(getColumnClasses(column));

  // Add negative number class
  if (column.type === 'number' && typeof value === 'number' && value < 0) {
    classes.push('cell-negative');
  }

  // Add boolean styling
  if (column.type === 'boolean') {
    classes.push(value ? 'cell-true' : 'cell-false');
  }

  return classes.join(' ');
}
