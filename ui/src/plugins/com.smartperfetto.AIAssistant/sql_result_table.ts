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

import m from 'mithril';
import {Trace} from '../../public/trace';
import {Time} from '../../base/time';
import {ChartVisualizer, ChartData} from './chart_visualizer';
import {
  ColumnDefinition,
  buildColumnDefinitions,
} from './generated/data_contract.types';
import {
  getColumnClasses,
} from './renderers/formatters';
import {escapeHtml} from './data_formatter';

/**
 * User interaction data for focus tracking (Agent-Driven Architecture v2.0).
 *
 * This captures user clicks on timestamps, entities, etc. and sends them
 * to the backend FocusStore for incremental analysis context.
 */
export interface UserInteraction {
  type: 'click' | 'drill_down';
  target: {
    /** Entity type if clicking on an entity column */
    entityType?: 'frame' | 'process' | 'thread' | 'session' | 'cpu_slice' | 'binder';
    /** Entity ID (string for JSON serialization) */
    entityId?: string;
    /** Entity name for display */
    entityName?: string;
    /** Time range if clicking on timestamp (stringified for JSON) */
    timeRange?: { start: string; end: string };
  };
  source: 'ui';
  timestamp: number;
  context?: {
    /** Column name where the click occurred */
    columnName?: string;
    /** Row data for context */
    rowContext?: Record<string, any>;
  };
}

export interface SqlResultTableAttrs {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
  title?: string;  // Optional title to display in header (e.g., section title)
  trace?: Trace;  // 新增：用于跳转到时间线
  onPin?: (data: {query: string, columns: string[], rows: any[][], timestamp: number}) => void;
  onExport?: (format: 'csv' | 'json') => void;
  /**
   * Callback for user interaction tracking (Agent-Driven Architecture v2.0).
   *
   * When provided, the table will capture user clicks on timestamps and
   * entities, sending them to the backend for focus tracking.
   */
  onInteraction?: (interaction: UserInteraction) => void;
  // 可展开行数据：每行的详细分析结果（用于 iterator 类型结果）
  expandableData?: Array<{
    item: Record<string, any>;
    result: {
      success: boolean;
      sections?: Record<string, any>;
      error?: string;
    };
  }>;
  // 汇总报告（在表格上方显示）
  summary?: {
    title: string;
    content: string;
  };
  // 元数据：从列表中提取的固定值（如 layer_name, process_name）
  // 这些值在所有行中相同，显示在标题区域而非表格列中
  metadata?: Record<string, any>;
  /**
   * Column definitions for schema-driven rendering (v2.0)
   *
   * When provided, column formatting and click actions are determined
   * by the column definitions rather than auto-detection from column names.
   */
  columnDefinitions?: ColumnDefinition[];
}

// 时间戳列信息
interface TimestampColumn {
  columnIndex: number;
  columnName: string;
  unit: TimeUnit;
  // 关联的 duration 列（用于时间范围跳转）
  durationColumnIndex?: number;
  durationColumnName?: string;
  durationUnit?: TimeUnit;
}

// 实体列信息 (用于交互追踪)
interface EntityColumn {
  columnIndex: number;
  columnName: string;
  entityType: 'frame' | 'process' | 'thread' | 'session' | 'cpu_slice' | 'binder';
}

// 单位转换为纳秒的乘数
type TimeUnit = 'ns' | 'us' | 'ms' | 's';

const UNIT_TO_NS: Record<TimeUnit, number> = {
  'ns': 1,
  'us': 1e3,
  'ms': 1e6,
  's': 1e9,
};

// Colors are now defined in CSS variables (styles.scss)
// This file uses CSS class names instead of inline styles

// 显示限制常量
const COLLAPSED_ROW_LIMIT = 10;  // 折叠时显示的行数
const EXPANDED_ROW_LIMIT = 50;   // 展开时最大显示的行数

export class SqlResultTable implements m.ClassComponent<SqlResultTableAttrs> {
  private expanded = false;
  private showStats = false;
  private showChart = false;  // 新增：控制图表显示
  private copySuccess = false;
  private copiedTimeout: any = null;
  private pinSuccess = false;
  private pinTimeout: any = null;
  private timestampColumns: TimestampColumn[] = [];  // 存储检测到的时间戳列
  private entityColumns: EntityColumn[] = [];  // 存储检测到的实体列 (v2.0 交互追踪)
  // 可展开行状态：记录哪些行处于展开状态
  private expandedRows = new Set<number>();
  // Trace 起始时间（纳秒），用于计算相对时间显示
  private traceStartNs: number = 0;

  view(vnode: m.Vnode<SqlResultTableAttrs>) {
    const {columns, rows, rowCount, query, onPin, trace, title, expandableData, summary, metadata, columnDefinitions, onInteraction} = vnode.attrs;

    // 获取 trace 起始时间，用于相对时间戳显示
    if (trace) {
      this.traceStartNs = Number(trace.traceInfo.start);
    }

    // Build or infer column definitions (v2.0 schema-driven rendering)
    // If columnDefinitions are provided, use them; otherwise infer from column names
    const effectiveColumnDefs = columnDefinitions || buildColumnDefinitions(columns);

    // 检测时间戳列（只在第一次或列变化时执行）
    // If column definitions are provided, extract from them; otherwise use pattern matching
    if (this.timestampColumns.length === 0 ||
        this.timestampColumns.some((tc) => columns[tc.columnIndex] !== tc.columnName)) {
      this.timestampColumns = columnDefinitions
        ? this.extractTimestampColumnsFromDefinitions(columnDefinitions, columns)
        : this.detectTimestampColumns(columns);
    }

    // 检测实体列 (v2.0 交互追踪)
    if (this.entityColumns.length === 0 ||
        this.entityColumns.some((ec) => columns[ec.columnIndex] !== ec.columnName)) {
      this.entityColumns = this.detectEntityColumns(columns);
    }

    // Classify columns for styling (use column definitions if available)
    const columnClasses = columnDefinitions
      ? columns.map((_, idx) => getColumnClasses(effectiveColumnDefs[idx]))
      : this.classifyColumns(columns);

    // Limit displayed rows: collapsed shows 10, expanded shows up to 50
    const displayLimit = this.expanded ? EXPANDED_ROW_LIMIT : COLLAPSED_ROW_LIMIT;
    const displayRows = rows.slice(0, displayLimit);
    const hasMore = rows.length > COLLAPSED_ROW_LIMIT;

    // Calculate statistics (only when needed)
    const stats = this.showStats ? this.calculateStats(columns, rows) : {};

    return m('div.sql-result.compact', [
      // 汇总报告（如果有且有关键发现）
      // Use oncreate/onupdate to directly set innerHTML, bypassing Mithril's
      // reconciliation for formatted content (avoids removeChild errors)
      summary && summary.content.includes('关键发现') ? m('.sql-result-summary', [
        m('div.summary-content', {
          oncreate: (vnode: m.VnodeDOM) => {
            (vnode.dom as HTMLElement).innerHTML = this.formatMarkdown(summary.content);
          },
          onupdate: (vnode: m.VnodeDOM) => {
            const newHtml = this.formatMarkdown(summary.content);
            const dom = vnode.dom as HTMLElement;
            if (dom.innerHTML !== newHtml) {
              dom.innerHTML = newHtml;
            }
          },
        }),
      ]) : null,

      // Compact single-row header with title (if provided), row count, and actions
      m('.sql-result-header.compact-header', [
        m('.sql-result-title', [
          m('span.pf-icon', title ? 'folder' : 'table_chart'),
          title
            ? m('span.section-title', title)
            : null,
          m('span.row-count', `${rowCount} 条`),
          // Inline metadata display - dynamically render all metadata fields
          metadata && Object.keys(metadata).length > 0
            ? m('span.header-metadata',
                Object.entries(metadata)
                  .filter(([_, v]) => v !== null && v !== undefined && v !== '')
                  .map(([key, value]) => m('span.metadata-tag', [
                    m('span.metadata-label', this.formatMetadataLabel(key) + ':'),
                    m('span.metadata-value', this.formatMetadataValue(value, key)),
                  ]))
              )
            : null,
        ]),
        m('.sql-result-actions', [
          // Copy button (icon only)
          m('button.sql-result-action.icon-only', {
            class: this.copySuccess ? 'active' : '',
            onclick: () => this.copyResults(columns, rows),
            title: 'Copy to clipboard',
          }, m('span.pf-icon', this.copySuccess ? 'check' : 'content_copy')),
          // Pin button (icon only) - only show if query exists
          onPin && query ? m('button.sql-result-action.icon-only', {
            class: this.pinSuccess ? 'active' : '',
            onclick: () => this.pinResults(query, columns, rows, onPin),
            title: 'Pin results',
          }, m('span.pf-icon', this.pinSuccess ? 'check' : 'push_pin')) : null,
          // Stats toggle (icon only)
          m('button.sql-result-action.icon-only', {
            class: this.showStats ? 'active' : '',
            onclick: () => { this.showStats = !this.showStats; m.redraw(); },
            title: 'Show statistics',
          }, m('span.pf-icon', 'analytics')),
          // Chart button (icon only, if data is visualizable)
          this.canVisualize(columns, rows) ? m('button.sql-result-action.icon-only', {
            class: this.showChart ? 'active' : '',
            onclick: () => { this.showChart = !this.showChart; m.redraw(); },
            title: 'Show chart',
          }, m('span.pf-icon', 'bar_chart')) : null,
        ]),
      ]),

      // Statistics section (collapsible, compact)
      this.showStats ? m('.sql-result-stats.compact-stats', [
        m('.stats-grid',
          Object.entries(stats).slice(0, 6).map(([key, value]) =>
            m('.stat-item', [
              m('.stat-label', key),
              m('.stat-value', String(value)),
            ])
          )
        ),
      ]) : null,

      // Table - Perfetto style, full width
      m('.sql-result-table-wrapper',
        m('table.sql-result-table', [
          m('thead',
            m('tr', [
              // 可展开按钮列表头（如果有可展开数据 - check for at least one non-null item）
              expandableData && expandableData.some(Boolean) ? m('th.col-expand', '') : null,
              ...columns.map((col, idx) =>
                m('th', {
                  class: columnClasses[idx] || '',
                  title: col,
                  onclick: () => this.copyColumn(rows, columns, idx),
                }, col)
              ),
              // Navigation arrow column header
              trace ? m('th.col-action', '') : null,
            ])
          ),
          // Use map().flat() instead of flatMap for more predictable DOM structure
          // CRITICAL: Each row ALWAYS produces exactly 2 tr elements for structural stability
          // This prevents Mithril's virtual DOM reconciliation errors during concurrent redraws
          m('tbody',
            displayRows.map((row, rowIndex) => {
              const hasExpandableData = expandableData && expandableData[rowIndex];
              const isExpanded = hasExpandableData && this.expandedRows.has(rowIndex);
              const hasAnyExpandable = expandableData && expandableData.some(Boolean);
              const totalColSpan = columns.length + (trace ? 2 : 1) + (hasAnyExpandable ? 1 : 0);

              // 主行 - 始终渲染
              const mainRow = m('tr.main-row', {
                key: `main-${rowIndex}`,
                class: trace ? 'clickable' : '',
              }, [
                // 可展开按钮列（如果整体有可展开数据）
                hasAnyExpandable ? m('td.col-expand', hasExpandableData ? {
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    if (isExpanded) {
                      this.expandedRows.delete(rowIndex);
                    } else {
                      this.expandedRows.add(rowIndex);
                    }
                    m.redraw();
                  },
                } : {}, hasExpandableData ? m('span.expand-icon', isExpanded ? '▼' : '▶') : null) : null,
                // 数据列
                ...row.map((cell, cellIndex) =>
                  this.renderCellPerfetto(
                    cell,
                    cellIndex,
                    columnClasses[cellIndex],
                    trace,
                    row,
                    columns,
                    onInteraction,
                    effectiveColumnDefs[cellIndex]
                  )
                ),
                // Navigation arrow
                trace ? m('td.col-action', {
                  onclick: () => this.jumpToFirstTimestamp(row, trace),
                  title: 'Jump to timeline',
                }, '→') : null,
              ]);

              // 详情行 - 始终渲染完整内容，仅用 CSS 控制显示
              // 关键：内容始终存在，不根据 isExpanded 条件渲染，避免 DOM 变化
              const detailRow = m('tr.detail-row', {
                key: `detail-${rowIndex}`,
                style: { display: isExpanded ? 'table-row' : 'none' },
              }, m('td', {
                colSpan: totalColSpan,
              }, hasExpandableData
                ? m('div.expanded-content', this.renderExpandableContent(expandableData![rowIndex]))
                : null  // 没有数据的行内容为空，但 tr 和 td 始终存在
              ));

              // 始终返回 2 个元素的数组
              return [mainRow, detailRow];
            }).flat()
          ),
        ])
      ),

      // Expand/collapse (compact)
      hasMore ? m('.sql-result-expand.compact-expand', [
        m('button', {
          onclick: () => { this.expanded = !this.expanded; m.redraw(); },
        }, [
          m('span.pf-icon', this.expanded ? 'expand_less' : 'expand_more'),
          this.expanded ? '收起' : `展开 (${rowCount})`,
        ]),
      ]) : null,

      // Chart visualization (collapsible)
      this.showChart && this.canVisualize(columns, rows)
        ? m(ChartVisualizer, {
            chartData: this.generateChartData(columns, rows),
            width: 400,
            height: 200,
          })
        : null,
    ]);
  }

  /**
   * Classify columns for proper styling (number, duration, name, etc.)
   */
  private classifyColumns(columns: string[]): string[] {
    return columns.map((col) => {
      const lowerCol = col.toLowerCase();

      // 绝对时间戳列 - 只有 ts, ts_str 等明确的绝对时间列才显示为可点击
      // 排除 relative_*, dur_* 等相对时间列
      if (!(/relative|dur|duration|latency|elapsed/i.test(lowerCol)) &&
          (/^ts$/i.test(col) || /^ts_str$/i.test(col) || /^timestamp$/i.test(col) ||
           /^start_ts$/i.test(col) || /^end_ts$/i.test(col) || /^ts_end$/i.test(col) ||
           /^client_ts$/i.test(col) || /^server_ts$/i.test(col))) {
        return 'col-timestamp';
      }

      // Duration/relative time columns - numeric style, not clickable
      if (/dur|duration|latency|relative|elapsed|_ms$|_us$|_ns$/i.test(lowerCol)) {
        return 'col-duration';
      }

      // Count/number/ID columns
      if (/count|cnt|num|total|sum|avg|min|max|^id$|_id$|^pid$|^tid$|^upid$|^utid$|percent|ratio|depth|index|frame_index|token|session_id|track_id|slice_id|arg_set_id/i.test(lowerCol)) {
        return 'col-number';
      }

      // Name columns
      if (/name|label|title|desc|package|process|thread|function/i.test(lowerCol)) {
        return 'col-name';
      }

      // Category columns
      if (/type|category|kind|class|status|state/i.test(lowerCol)) {
        return 'col-category';
      }

      return '';
    });
  }

  /**
   * Render cell with Perfetto styling
   */
  private renderCellPerfetto(
    value: any,
    columnIndex: number,
    columnClass: string,
    trace?: Trace,
    row?: any[],  // 完整行数据，用于获取 dur_str
    columns?: string[],  // 列名数组，用于构建交互上下文
    onInteraction?: (interaction: UserInteraction) => void,  // 交互回调
    columnDefinition?: ColumnDefinition
  ): m.Children {
    const isTimestamp = columnClass === 'col-timestamp';
    // Fix: 区分 duration (时长，需要单位转换) 和 number (普通数字如 ID/count)
    const isDuration = columnClass === 'col-duration';
    const isPlainNumber = columnClass === 'col-number';
    const columnName = columns?.[columnIndex];
    const isIdentifier = this.isIdentifierColumn(columnName);

    // 获取该列的时间戳信息（如果有）
    const tsColumn = this.timestampColumns.find(tc => tc.columnIndex === columnIndex);
    const resolvedUnit = this.resolveTimeUnit(columnDefinition?.unit, columnName);
    const timestampUnit = tsColumn?.unit ?? resolvedUnit;
    const timestampNs = isTimestamp ? this.parseTimeValueToNs(value, timestampUnit) : null;
    const durationNs = isDuration ? this.parseTimeValueToNs(value, resolvedUnit) : null;

    // Format the display value
    // 支持 number、bigint 和字符串数值
    let numericValue: number | null = null;

    if (typeof value === 'bigint') {
      numericValue = Number(value);
    } else if (typeof value === 'number') {
      numericValue = value;
    } else if (typeof value === 'string') {
      const normalized = value.trim().replace(/[,\s]/g, '');
      if (/^-?\d+$/.test(normalized)) {
        try {
          numericValue = Number(BigInt(normalized));
        } catch {
          numericValue = parseFloat(normalized);
        }
      } else if (/^-?\d+(\.\d+)?$/.test(normalized)) {
        numericValue = parseFloat(normalized);
      }
    }

    const isValueNumeric = numericValue !== null && !isNaN(numericValue);

    let displayValue: string;
    if (value === null || value === undefined) {
      displayValue = 'NULL';
    } else if (isDuration && durationNs !== null) {
      // Duration 类型：统一以 ms 展示
      displayValue = this.formatDuration(durationNs);
    } else if (isPlainNumber && (isValueNumeric || isIdentifier)) {
      // ID/token/pid/tid 等标识符列保持原始数字字符串，不加千分位
      if (isIdentifier) {
        displayValue = this.formatIdentifierValue(value);
      } else {
        // 普通数字类型 (count, avg, etc.)：使用千分位分隔
        displayValue = Number.isInteger(numericValue!)
          ? numericValue!.toLocaleString()
          : numericValue!.toFixed(2);
      }
    } else if (isTimestamp && timestampNs !== null) {
      displayValue = this.formatTimestamp(Number(timestampNs));
    } else {
      displayValue = this.formatCellValue(value, columnName);
    }

    // Timestamp cell with click handler
    if (isTimestamp && trace && tsColumn && timestampNs !== null) {
      // 获取 duration 值（如果有）
      const durValue = (tsColumn.durationColumnIndex !== undefined && row)
        ? row[tsColumn.durationColumnIndex]
        : undefined;
      const durUnit = tsColumn.durationUnit || this.resolveTimeUnit(undefined, tsColumn.durationColumnName);
      const durNs = durValue === undefined ? null : this.parseTimeValueToNs(durValue, durUnit);
      const hasRange = durNs !== null && durNs > BigInt(0);

      return m('td', {
        class: `${columnClass} timestamp-cell`,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          if (hasRange && durNs !== null) {
            this.jumpToTimeRange(timestampNs, durNs, trace);

            // 发送交互事件 (v2.0 Focus Tracking)
            if (onInteraction) {
              const endNs = timestampNs + durNs;
              onInteraction({
                type: 'click',
                target: {
                  timeRange: {
                    start: timestampNs.toString(),
                    end: endNs.toString(),
                  },
                },
                source: 'ui',
                timestamp: Date.now(),
                context: {
                  columnName: columns?.[columnIndex],
                  rowContext: this.buildRowContext(row, columns),
                },
              });
            }
          } else {
            this.jumpToTimestampNs(timestampNs, trace);

            // 发送单点时间戳交互事件 (v2.0 Focus Tracking)
            if (onInteraction) {
              onInteraction({
                type: 'click',
                target: {
                  timeRange: {
                    start: timestampNs.toString(),
                    end: timestampNs.toString(),
                  },
                },
                source: 'ui',
                timestamp: Date.now(),
                context: {
                  columnName: columns?.[columnIndex],
                  rowContext: this.buildRowContext(row, columns),
                },
              });
            }
          }
        },
        title: hasRange ? 'Click to jump to time range' : `Click to jump (${timestampUnit})`,
      }, displayValue);
    }

    // Entity column cell with click handler (v2.0 Focus Tracking)
    const entityColumn = this.entityColumns.find(ec => ec.columnIndex === columnIndex);
    if (entityColumn && value !== null && value !== undefined && onInteraction) {
      return m('td', {
        class: `${columnClass} entity-cell`,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          // 发送实体点击交互事件
          onInteraction({
            type: 'click',
            target: {
              entityType: entityColumn.entityType,
              entityId: isIdentifier ? this.formatIdentifierValue(value) : String(value),
              entityName: this.findEntityName(row, columns, entityColumn.entityType),
            },
            source: 'ui',
            timestamp: Date.now(),
            context: {
              columnName: columns?.[columnIndex],
              rowContext: this.buildRowContext(row, columns),
            },
          });
        },
        title: `Click to focus on this ${entityColumn.entityType}`,
      }, displayValue);
    }

    // Regular cell
    return m('td', {
      class: columnClass + (value === null ? ' null-cell' : ''),
      title: String(value),
    }, displayValue);
  }

  /**
   * Format duration values in milliseconds (统一展示单位)
   */
  private formatDuration(ns: bigint): string {
    const ms = Number(ns) / 1e6;
    if (!Number.isFinite(ms)) {
      return `${ns.toString()}ns`;
    }

    if (ms === 0) {
      return '0ms';
    }

    const absMs = Math.abs(ms);
    if (absMs >= 100) {
      return `${ms.toFixed(1)}ms`;
    }
    if (absMs >= 1) {
      return `${ms.toFixed(2)}ms`;
    }
    if (absMs >= 0.01) {
      return `${ms.toFixed(3)}ms`;
    }
    return `${ms.toFixed(4)}ms`;
  }

  /**
   * Jump to first timestamp in the row
   * 如果有 dur_str 列，跳转到时间范围（start 到 start+dur）
   */
  private jumpToFirstTimestamp(row: any[], trace: Trace): void {
    for (const tc of this.timestampColumns) {
      const tsValue = row[tc.columnIndex];

      const startNs = this.parseTimeValueToNs(tsValue, tc.unit);
      if (startNs === null) {
        continue;
      }

      const durValue = tc.durationColumnIndex !== undefined
        ? row[tc.durationColumnIndex]
        : undefined;
      const durUnit = tc.durationUnit || this.resolveTimeUnit(undefined, tc.durationColumnName);
      const durNs = durValue === undefined ? null : this.parseTimeValueToNs(durValue, durUnit);

      if (durNs !== null && durNs > BigInt(0)) {
        this.jumpToTimeRange(startNs, durNs, trace);
      } else {
        this.jumpToTimestampNs(startNs, trace);
      }
      return;
    }
  }

  /**
   * 跳转到时间范围（start 到 start+dur）
   * @param startNs 开始时间（纳秒）
   * @param durNs 持续时间（纳秒）
   * @param trace Perfetto trace 对象
   */
  private jumpToTimeRange(startNs: bigint, durNs: bigint, trace: Trace): void {
    try {
      const endNs = startNs + durNs;
      // 在前后各留出 5% 的边距，便于查看上下文
      const margin = durNs / BigInt(20);
      const viewStart = startNs - margin;
      const viewEnd = endNs + margin;

      console.log(`[SqlResultTable] Jumping to time range: start=${startNs}, dur=${durNs}, end=${endNs}`);

      trace.scrollTo({
        time: {
          start: Time.fromRaw(viewStart > BigInt(0) ? viewStart : BigInt(0)),
          end: Time.fromRaw(viewEnd),
          behavior: 'focus',
        },
      });

      console.log(`[SqlResultTable] Jumped to time range: ${this.formatTimestamp(Number(startNs))} - ${this.formatTimestamp(Number(endNs))}`);
    } catch (error) {
      console.error('[SqlResultTable] Failed to jump to time range:', error);
    }
  }

  private calculateStats(columns: string[], rows: any[][]): Record<string, string | number> {
    const stats: Record<string, string | number> = {
      'Total Rows': rows.length,
      'Columns': columns.length,
    };

    // Add stats for numeric columns
    columns.forEach((col, colIndex) => {
      const numericValues = rows
        .map((row) => row[colIndex])
        .filter((val) => typeof val === 'number' && isFinite(val));

      if (numericValues.length > 0) {
        const sum = numericValues.reduce((a, b) => a + b, 0);
        const avg = sum / numericValues.length;
        const min = Math.min(...numericValues);
        const max = Math.max(...numericValues);

        stats[`${col} (avg)`] = this.formatValue(avg);
        stats[`${col} (min)`] = this.formatValue(min);
        stats[`${col} (max)`] = this.formatValue(max);
      }
    });

    return stats;
  }

  private formatValue(value: number): string {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(2);
  }

  private formatCellValue(value: any, columnName?: string): string {
    if (value === null || value === undefined) return 'NULL';
    const isIdentifier = this.isIdentifierColumn(columnName);
    if (typeof value === 'number') {
      if (isIdentifier && Number.isFinite(value)) {
        return Number.isInteger(value) ? String(Math.trunc(value)) : String(value);
      }
      if (Number.isInteger(value)) return value.toLocaleString();
      return value.toFixed(2);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'string' && isIdentifier) {
      const normalized = this.normalizeLooseNumericString(value);
      return normalized ?? value;
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  private isIdentifierColumn(columnName?: string): boolean {
    const col = (columnName || '').toLowerCase();
    if (!col) return false;
    if (col === 'id' || col.endsWith('_id')) return true;
    return [
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
      'track_id',
      'slice_id',
      'arg_set_id',
    ].includes(col);
  }

  private normalizeLooseNumericString(raw: string): string | null {
    const compact = raw.trim().replace(/[,\s，_]/g, '');
    if (!/^\d+$/.test(compact)) return null;
    return compact;
  }

  private formatIdentifierValue(value: any): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Number.isInteger(value) ? String(Math.trunc(value)) : String(value);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'string') {
      const normalized = this.normalizeLooseNumericString(value);
      return normalized ?? value;
    }
    return String(value);
  }

  private async copyResults(columns: string[], rows: any[][]) {
    // Copy as TSV (tab-separated values)
    const header = columns.join('\t');
    const data = rows.map((row) =>
      row.map((cell, idx) => this.formatCellValue(cell, columns[idx])).join('\t')
    );
    const tsv = [header, ...data].join('\n');

    try {
      await navigator.clipboard.writeText(tsv);
      this.copySuccess = true;
      if (this.copiedTimeout) clearTimeout(this.copiedTimeout);
      this.copiedTimeout = setTimeout(() => {
        this.copySuccess = false;
        m.redraw();
      }, 2000);
      m.redraw();
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  private async copyColumn(rows: any[][], columns: string[], colIndex: number) {
    const columnData = rows.map((row) => this.formatCellValue(row[colIndex], columns[colIndex])).join('\n');
    try {
      await navigator.clipboard.writeText(columnData);
      this.copySuccess = true;
      if (this.copiedTimeout) clearTimeout(this.copiedTimeout);
      this.copiedTimeout = setTimeout(() => {
        this.copySuccess = false;
        m.redraw();
      }, 2000);
      m.redraw();
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  private async pinResults(
    query: string,
    columns: string[],
    rows: any[][],
    onPin: (data: {query: string, columns: string[], rows: any[][], timestamp: number}) => void
  ) {
    // Call the pin callback with the data
    onPin({
      query,
      columns,
      rows: rows.slice(0, 100), // Limit to 100 rows for storage
      timestamp: Date.now(),
    });

    // Show success feedback
    this.pinSuccess = true;
    if (this.pinTimeout) clearTimeout(this.pinTimeout);
    this.pinTimeout = setTimeout(() => {
      this.pinSuccess = false;
      m.redraw();
    }, 2000);
    m.redraw();
  }

  /**
   * 检测时间戳列
   * 只检测可用于跳转的【绝对时间戳】列，排除相对时间和持续时间列
   * 同时检测关联的 dur_str 列用于时间范围跳转
   */
  private detectTimestampColumns(columns: string[]): TimestampColumn[] {
    const detected: TimestampColumn[] = [];
    const durationColumnIndex = this.findDurationColumnIndex(columns);

    columns.forEach((col, idx) => {
      const lowerCol = col.toLowerCase();

      // 排除相对时间和持续时间列（这些不能用于跳转）
      if (/relative|dur|duration|latency|elapsed|delta|diff|offset/i.test(lowerCol)) {
        return;  // 跳过此列
      }

      // 检测是否是【绝对时间戳】列（可用于跳转到 Perfetto 时间线）
      // 必须是 ts, ts_str, timestamp 等明确的绝对时间列
      const isAbsoluteTimestamp =
        /^ts$/i.test(col) ||              // 标准的 ts 列（纳秒）
        /^ts_str$/i.test(col) ||          // 字符串形式的 ts（纳秒）
        /^timestamp$/i.test(col) ||       // timestamp
        /^start_ts$/i.test(col) ||        // start_ts（绝对开始时间）
        /^end_ts$/i.test(col) ||          // end_ts（绝对结束时间）
        /^ts_end$/i.test(col) ||          // ts_end（绝对结束时间）
        /^client_ts$/i.test(col) ||       // Binder client_ts
        /^server_ts$/i.test(col);         // Binder server_ts

      if (isAbsoluteTimestamp) {
        const tsColumn: TimestampColumn = {
          columnIndex: idx,
          columnName: col,
          unit: this.resolveTimeUnit(undefined, col),
        };

        // 默认只对开始时间列绑定 duration，避免 end_ts 误触发范围跳转
        const isStartLikeTimestamp =
          /^ts$/i.test(col) ||
          /^ts_str$/i.test(col) ||
          /^start_ts$/i.test(col) ||
          /^start_ts_str$/i.test(col) ||
          /^start_time$/i.test(col) ||
          /^client_ts$/i.test(col);

        if (isStartLikeTimestamp && durationColumnIndex !== -1) {
          tsColumn.durationColumnIndex = durationColumnIndex;
          tsColumn.durationColumnName = columns[durationColumnIndex];
          tsColumn.durationUnit = this.resolveTimeUnit(undefined, columns[durationColumnIndex]);
        }

        detected.push(tsColumn);
      }
    });

    return detected;
  }

  /**
   * 检测实体列 (v2.0 交互追踪)
   * 识别包含实体 ID 的列，如 frame_id, session_id, process_name 等
   */
  private detectEntityColumns(columns: string[]): EntityColumn[] {
    const detected: EntityColumn[] = [];

    columns.forEach((col, idx) => {
      // Frame 相关列
      if (/^frame_id$/i.test(col) || /^jank_frame_id$/i.test(col) || /^actual_frame_id$/i.test(col)) {
        detected.push({ columnIndex: idx, columnName: col, entityType: 'frame' });
        return;
      }

      // Session 相关列
      if (/^session_id$/i.test(col) || /^scroll_session_id$/i.test(col)) {
        detected.push({ columnIndex: idx, columnName: col, entityType: 'session' });
        return;
      }

      // Process 相关列 (只检测 upid/pid，不检测 process_name 因为那是名称不是 ID)
      if (/^upid$/i.test(col) || /^pid$/i.test(col)) {
        detected.push({ columnIndex: idx, columnName: col, entityType: 'process' });
        return;
      }

      // Thread 相关列
      if (/^utid$/i.test(col) || /^tid$/i.test(col)) {
        detected.push({ columnIndex: idx, columnName: col, entityType: 'thread' });
        return;
      }

      // CPU slice 相关列
      if (/^slice_id$/i.test(col) || /^cpu_slice_id$/i.test(col)) {
        detected.push({ columnIndex: idx, columnName: col, entityType: 'cpu_slice' });
        return;
      }

      // Binder 相关列
      if (/^binder_id$/i.test(col) || /^transaction_id$/i.test(col)) {
        detected.push({ columnIndex: idx, columnName: col, entityType: 'binder' });
        return;
      }
    });

    return detected;
  }

  /**
   * 构建行上下文，用于交互事件的 context 字段
   */
  private buildRowContext(row?: any[], columns?: string[]): Record<string, any> | undefined {
    if (!row || !columns) return undefined;

    const context: Record<string, any> = {};

    // 提取关键字段作为上下文
    const keyFields = [
      'frame_id', 'session_id', 'process_name', 'thread_name',
      'upid', 'utid', 'pid', 'tid', 'ts', 'dur', 'name', 'slice_name',
    ];

    columns.forEach((col, idx) => {
      const lowerCol = col.toLowerCase();
      if (keyFields.some(kf => lowerCol.includes(kf)) && row[idx] !== null && row[idx] !== undefined) {
        context[col] = row[idx];
      }
    });

    return Object.keys(context).length > 0 ? context : undefined;
  }

  /**
   * 从行数据中查找实体名称
   * 例如：对于 process 实体，查找 process_name 列
   */
  private findEntityName(row?: any[], columns?: string[], entityType?: string): string | undefined {
    if (!row || !columns || !entityType) return undefined;

    // 实体类型到名称列的映射
    const nameColumnMap: Record<string, string[]> = {
      frame: ['frame_name', 'slice_name', 'name'],
      process: ['process_name', 'package_name', 'cmdline'],
      thread: ['thread_name', 'name'],
      session: ['session_name', 'scroll_type'],
      cpu_slice: ['slice_name', 'name'],
      binder: ['interface', 'method'],
    };

    const candidateColumns = nameColumnMap[entityType] || ['name'];

    for (const candidateCol of candidateColumns) {
      const colIndex = columns.findIndex(c => c.toLowerCase() === candidateCol.toLowerCase());
      if (colIndex !== -1 && row[colIndex] !== null && row[colIndex] !== undefined) {
        return String(row[colIndex]);
      }
    }

    return undefined;
  }

  /**
   * Extract timestamp columns from column definitions (v2.0 schema-driven)
   *
   * This method uses explicit column definitions instead of pattern matching,
   * providing more reliable timestamp column detection.
   */
  private extractTimestampColumnsFromDefinitions(
    columnDefs: ColumnDefinition[],
    columns: string[]
  ): TimestampColumn[] {
    const detected: TimestampColumn[] = [];

    columnDefs.forEach((def, idx) => {
      // Check if this column has a navigate_timeline or navigate_range click action
      if (
        def.type === 'timestamp' &&
        (def.clickAction === 'navigate_timeline' || def.clickAction === 'navigate_range')
      ) {
        const tsColumn: TimestampColumn = {
          columnIndex: idx,
          columnName: columns[idx],
          unit: this.resolveTimeUnit(def.unit, columns[idx]),
        };

        // If durationColumn is specified, find its index
        if (def.durationColumn) {
          const durIndex = columns.indexOf(def.durationColumn);
          if (durIndex !== -1) {
            tsColumn.durationColumnIndex = durIndex;
            tsColumn.durationColumnName = def.durationColumn;
            tsColumn.durationUnit = this.resolveTimeUnit(
              columnDefs[durIndex]?.unit,
              def.durationColumn
            );
          }
        }

        detected.push(tsColumn);
      }
    });

    return detected;
  }

  private findDurationColumnIndex(columns: string[]): number {
    const candidates = [
      /^dur_str$/i,
      /^dur_ms$/i,
      /^dur_us$/i,
      /^dur_ns$/i,
      /^dur$/i,
      /^duration_str$/i,
      /^duration_ms$/i,
      /^duration_us$/i,
      /^duration_ns$/i,
      /^duration$/i,
      /_dur_str$/i,
      /_dur_ms$/i,
      /_dur_us$/i,
      /_dur_ns$/i,
      /_dur$/i,
      /_duration_str$/i,
      /_duration_ms$/i,
      /_duration_us$/i,
      /_duration_ns$/i,
      /_duration$/i,
    ];

    for (const pattern of candidates) {
      const index = columns.findIndex(col => pattern.test(col));
      if (index !== -1) {
        return index;
      }
    }

    return -1;
  }

  private resolveTimeUnit(unit?: string, columnName?: string): TimeUnit {
    const normalizedUnit = unit?.toLowerCase();
    if (normalizedUnit && ['ns', 'us', 'ms', 's'].includes(normalizedUnit)) {
      return normalizedUnit as TimeUnit;
    }

    const lowerCol = (columnName || '').toLowerCase();
    if (!lowerCol) {
      return 'ns';
    }

    if (/_ns$/.test(lowerCol) || /\b(?:time|duration)\s*\(ns\)/.test(lowerCol)) {
      return 'ns';
    }
    if (/_us$|_micros$/.test(lowerCol) || /\b(?:time|duration)\s*\((?:us|µs)\)/.test(lowerCol)) {
      return 'us';
    }
    if (/_ms$|_millis$/.test(lowerCol) || /\b(?:time|duration)\s*\(ms\)/.test(lowerCol)) {
      return 'ms';
    }
    if (/(^|_)s$|_sec$/.test(lowerCol) || /\b(?:time|duration)\s*\(s\)/.test(lowerCol)) {
      return 's';
    }

    return 'ns';
  }

  private parseTimeValueToNs(value: unknown, unit: TimeUnit): bigint | null {
    if (value === null || value === undefined) {
      return null;
    }

    const unitMultiplier = UNIT_TO_NS[unit];
    const bigintMultiplier = BigInt(unitMultiplier);

    if (typeof value === 'bigint') {
      return value * bigintMultiplier;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return null;
      }
      return BigInt(Math.round(value * unitMultiplier));
    }

    if (typeof value === 'string') {
      const normalized = value.trim().replace(/[,\s]/g, '');
      if (!normalized) {
        return null;
      }

      if (/^-?\d+$/.test(normalized)) {
        try {
          return BigInt(normalized) * bigintMultiplier;
        } catch {
          return null;
        }
      }

      if (/^-?\d+(\.\d+)?$/.test(normalized)) {
        const parsed = Number(normalized);
        if (!Number.isFinite(parsed)) {
          return null;
        }
        return BigInt(Math.round(parsed * unitMultiplier));
      }
    }

    return null;
  }

  /**
   * 格式化时间戳为相对时间（相对于 trace 起始时间）
   * 显示为 "Xm Ys.ZZZs" 或 "Ys.ZZZs" 格式
   */
  private formatTimestamp(ns: number): string {
    // 计算相对于 trace 起始时间的偏移
    const relativeNs = this.traceStartNs > 0 ? ns - this.traceStartNs : ns;

    // 如果相对时间为负或极小，直接显示
    if (relativeNs < 0) {
      return `-${this.formatDurationForTimestamp(Math.abs(relativeNs))}`;
    }

    return this.formatDurationForTimestamp(relativeNs);
  }

  /**
   * 将纳秒值格式化为人类可读的时间格式
   * 用于时间戳的相对时间显示
   */
  private formatDurationForTimestamp(ns: number): string {
    if (ns < 1000) {
      return `${ns}ns`;
    }

    const totalSeconds = ns / 1e9;

    if (totalSeconds >= 60) {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds - minutes * 60;
      return `${minutes}m${seconds.toFixed(3)}s`;
    }

    if (totalSeconds >= 1) {
      return `${totalSeconds.toFixed(3)}s`;
    }

    const ms = ns / 1e6;
    if (ms >= 1) {
      return `${ms.toFixed(2)}ms`;
    }

    const us = ns / 1e3;
    return `${us.toFixed(1)}µs`;
  }

  /**
   * 跳转到纳秒时间戳
   */
  private jumpToTimestampNs(timestampNs: bigint, trace: Trace): void {
    try {
      console.log(`[SqlResultTable] Jumping to timestamp ns=${timestampNs}`);

      // 使用 Perfetto 的 scrollTo API
      trace.scrollTo({
        time: {
          start: Time.fromRaw(timestampNs),
          end: Time.fromRaw(timestampNs + BigInt(10000000)), // 结束时间为开始时间+10ms（更宽的视野）
          behavior: 'focus', // 智能缩放以聚焦到该时间点
        },
      });

      console.log(`[SqlResultTable] Jumped to timestamp: ${this.formatTimestamp(Number(timestampNs))}`);
    } catch (error) {
      console.error('[SqlResultTable] Failed to jump to timestamp:', error);
    }
  }

  /**
   * 检查数据是否可以可视化
   * 要求：有至少一个数值列，并且行数不超过20（避免图表过于复杂）
   */
  private canVisualize(columns: string[], rows: any[][]): boolean {
    if (rows.length === 0 || rows.length > 20) {
      return false;
    }

    // 检查是否有数值列
    const hasNumericColumn = columns.some((_col, idx) => {
      const sampleValues = rows.slice(0, 5).map(row => row[idx]);
      return sampleValues.some(v => typeof v === 'number' && isFinite(v) && v > 0);
    });

    return hasNumericColumn;
  }

  /**
   * 生成图表数据
   * 自动检测最佳的可视化方式
   */
  private generateChartData(columns: string[], rows: any[][]): ChartData {
    // 查找标签列（通常是字符串列）和数值列
    const labelColumnIndex = columns.findIndex((_col, idx) => {
      const sampleValue = rows[0]?.[idx];
      return typeof sampleValue === 'string';
    });

    const valueColumnIndex = columns.findIndex((_col, idx) => {
      const sampleValue = rows[0]?.[idx];
      return typeof sampleValue === 'number' && isFinite(sampleValue) && sampleValue > 0;
    });

    if (labelColumnIndex === -1 || valueColumnIndex === -1) {
      // 降级：使用行索引作为标签
      return {
        type: 'bar',
        title: 'Data Distribution',
        data: rows.map((row, idx) => ({
          label: `Row ${idx + 1}`,
          value: parseFloat(row[valueColumnIndex] || row[0]) || 0,
        })),
      };
    }

    // 判断使用饼图还是柱状图
    // 如果是百分比数据或者总和接近100，使用饼图
    const values = rows.map(row => parseFloat(row[valueColumnIndex]) || 0);
    const total = values.reduce((sum, v) => sum + v, 0);
    const usePieChart = rows.length <= 10 && total > 50 && total < 150;

    return {
      type: usePieChart ? 'pie' : 'bar',
      title: `${columns[valueColumnIndex]} by ${columns[labelColumnIndex]}`,
      data: rows.map(row => {
        const value = parseFloat(row[valueColumnIndex]) || 0;
        return {
          label: String(row[labelColumnIndex] || 'Unknown'),
          value,
          percentage: usePieChart ? (value / total) * 100 : undefined,
        };
      }),
    };
  }

  /**
   * 渲染可展开行的详细内容
   */
  private renderExpandableContent(data: {
    item: Record<string, any>;
    result: {
      success: boolean;
      sections?: Record<string, any>;
      error?: string;
    };
  }): m.Children {
    if (!data.result.success) {
      return m('div.expanded-error', [
        m('span.error-icon', '✗'),
        m('span', `分析失败: ${data.result.error || '未知错误'}`),
      ]);
    }

    if (!data.result.sections) {
      return m('div.expanded-empty', '无详细分析数据');
    }

    const sections: m.Children[] = [];
    const emptySections: string[] = [];  // 记录空的 section 名称

    for (const [sectionId, sectionData] of Object.entries(data.result.sections)) {
      if (!sectionData || typeof sectionData !== 'object') continue;

      const section = sectionData as any;
      const title = section.title || sectionId;
      const dataRows = section.data || [];

      // 更严格的空数据检查：数组为空，或者第一行没有任何有效键
      if (dataRows.length === 0 ||
          !dataRows[0] ||
          typeof dataRows[0] !== 'object' ||
          Object.keys(dataRows[0]).length === 0) {
        emptySections.push(title);
        continue;
      }

      sections.push(m('div.expanded-section', [
        m('div.section-title', title),
        m('table.section-table', [
          m('thead',
            m('tr',
              Object.keys(dataRows[0]).map(key =>
                m('th', key)
              )
            )
          ),
          m('tbody',
            dataRows.slice(0, 20).map((row: any) =>
              m('tr',
                Object.values(row).map((value: any) =>
                  m('td', this.formatCellValue(value))
                )
              )
            )
          ),
        ]),
        dataRows.length > 20
          ? m('div.section-more', `... 还有 ${dataRows.length - 20} 条`)
          : null,
      ]));
    }

    // 如果有有效 section，返回它们；否则显示紧凑的空数据提示
    if (sections.length > 0) {
      return sections;
    }

    // 所有 section 都是空的，显示简洁提示
    if (emptySections.length > 0) {
      return m('div.expanded-empty.compact', [
        m('span', '无数据'),
        m('span.empty-sections', ` (${emptySections.join(', ')})`),
      ]);
    }

    return m('div.expanded-empty.compact', '无详细数据');
  }

  /**
   * 格式化元数据标签为用户友好的显示形式
   * @param key 字段名 (如 layer_name, process_name, pid)
   */
  private formatMetadataLabel(key: string): string {
    // 常用字段的中文标签映射
    const labelMap: Record<string, string> = {
      layer_name: 'Layer',
      process_name: '进程',
      pid: 'PID',
      session_id: '会话',
      package: '包名',
      frame_count: '帧数',
      jank_rate: '掉帧率',
    };
    return labelMap[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * 格式化元数据值（如 layer_name）为更短的显示形式
   * 例如 "TX-com.example.app/MainActivity#0" -> "TX-MainActivity"
   * @param value 字段值
   * @param key 字段名 (可选，用于上下文相关的格式化)
   */
  private formatMetadataValue(value: any, key?: string): string {
    if (value === null || value === undefined) return '';
    const str = String(value);

    // 对于 layer_name，提取简短形式
    // 格式通常是 "TX-com.example.app/ActivityName#0"
    if (key === 'layer_name' || str.match(/^TX-/)) {
      const layerMatch = str.match(/^(TX-)[^/]+\/([^#]+)/);
      if (layerMatch) {
        return `${layerMatch[1]}${layerMatch[2]}`;
      }
    }

    // 对于 process_name，提取应用名
    if (key === 'process_name') {
      // com.example.app -> app
      const parts = str.split('.');
      if (parts.length > 2) {
        return parts[parts.length - 1];
      }
    }

    // 如果太长，截断
    if (str.length > 40) {
      return str.substring(0, 37) + '...';
    }

    return str;
  }

  /**
   * 格式化 Markdown 内容为 HTML
   */
  private formatMarkdown(content: string): string {
    if (!content) return '';

    return escapeHtml(content)
      // 粗体
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // 斜体
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // 代码
      .replace(/`(.+?)`/g, '<code>$1</code>')
      // 换行
      .replace(/\n/g, '<br>');
  }
}
