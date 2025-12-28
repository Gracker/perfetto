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

export interface SqlResultTableAttrs {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
  onPin?: (data: {query: string, columns: string[], rows: any[][], timestamp: number}) => void;
  onExport?: (format: 'csv' | 'json') => void;
}

// Modern color scheme
const COLORS = {
  primary: '#6366f1',
  primaryHover: '#4f46e5',
  primaryLight: 'rgba(99, 102, 241, 0.1)',
  success: '#10b981',
  warning: '#f59e0b',
  border: 'var(--border)',
  bgHover: 'var(--chip-bg)',
  text: 'var(--text)',
  textSecondary: 'var(--text-secondary)',
  textMuted: 'var(--text-muted)',
};

// Professional styles for SQL result table
const STYLES = {
  container: {
    background: 'var(--background)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    background: 'var(--background2)',
    borderBottom: '1px solid var(--border)',
    flexWrap: 'wrap' as const,
    gap: '8px',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  rowCount: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px',
    fontWeight: '500',
    color: 'var(--text)',
    padding: '4px 10px',
    background: COLORS.primaryLight,
    borderRadius: '6px',
  },
  statsToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: '500',
    color: 'var(--text-secondary)',
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  copyBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: '500',
    color: 'var(--text)',
    background: 'var(--background)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  expandBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: '500',
    color: COLORS.primary,
    background: COLORS.primaryLight,
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  pinBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: '500',
    color: 'var(--text)',
    background: 'var(--background)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  pinSuccess: {
    background: `${COLORS.success}20`,
    borderColor: COLORS.success,
    color: COLORS.success,
  },
  stats: {
    padding: '12px 16px',
    background: 'var(--background2)',
    borderBottom: '1px solid var(--border)',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '12px',
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px',
    background: 'var(--background)',
    borderRadius: '6px',
    border: '1px solid var(--border)',
  },
  statLabel: {
    fontSize: '11px',
    fontWeight: '500',
    color: 'var(--text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  statValue: {
    fontSize: '14px',
    fontWeight: '600',
    color: 'var(--text)',
  },
  tableWrapper: {
    overflowX: 'auto' as const,
    maxHeight: '320px',
    overflowY: 'auto' as const,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '13px',
    background: 'var(--background)',
  },
  th: {
    position: 'sticky' as const,
    top: 0,
    backgroundColor: 'var(--background2)',
    padding: '12px 14px',
    textAlign: 'left' as const,
    borderBottom: '2px solid var(--border)',
    fontWeight: '600',
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    cursor: 'pointer',
    transition: 'background 0.15s ease',
  },
  thHover: {
    background: COLORS.bgHover,
  },
  td: {
    padding: '12px 14px',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap' as const,
    fontSize: '13px',
    transition: 'background 0.15s ease',
  },
  tr: {
    transition: 'background 0.15s ease',
  },
  trHover: {
    background: COLORS.bgHover,
  },
  trClickable: {
    cursor: 'pointer',
  },
  cellValue: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '300px',
    fontFamily: 'monospace',
    fontSize: '12px',
  },
  cellNumber: {
    color: '#a5b4fc',
    fontWeight: '500',
  },
  cellNull: {
    color: 'var(--text-muted)',
    fontStyle: 'italic' as const,
  },
  exportActions: {
    display: 'flex',
    gap: '8px',
    padding: '12px 18px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--background2)',
  },
  exportBtn: {
    padding: '6px 14px',
    borderRadius: '6px',
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontSize: '12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    transition: 'all 0.2s ease',
  },
};

export class SqlResultTable implements m.ClassComponent<SqlResultTableAttrs> {
  private expanded = false;
  private showStats = false;
  private copySuccess = false;
  private copiedTimeout: any = null;
  private pinSuccess = false;
  private pinTimeout: any = null;

  view(vnode: m.Vnode<SqlResultTableAttrs>) {
    const {columns, rows, rowCount, query, onPin, onExport} = vnode.attrs;

    // Limit displayed rows when collapsed
    const displayRows = this.expanded ? rows : rows.slice(0, 10);
    const hasMore = rows.length > 10;

    // Calculate statistics
    const stats = this.calculateStats(columns, rows);

    // Build pin button style
    const pinBtnStyle = {...STYLES.pinBtn};
    if (this.pinSuccess) {
      Object.assign(pinBtnStyle, STYLES.pinSuccess);
    }

    return m('div', {style: STYLES.container}, [
      // Header
      m('div', {style: STYLES.header}, [
        m('div', {style: STYLES.headerLeft}, [
          m('span', {style: STYLES.rowCount}, `📊 ${rowCount.toLocaleString()} rows`),
          m('button', {
            style: STYLES.statsToggle,
            onclick: () => {
              this.showStats = !this.showStats;
              m.redraw();
            },
          }, this.showStats ? '▼ Hide Stats' : '▶ Stats'),
        ]),
        m('div', {style: STYLES.headerRight}, [
          // Pin button (if callback provided)
          onPin && query ? m('button', {
            style: pinBtnStyle,
            onclick: () => this.pinResults(query, columns, rows, onPin),
            title: 'Pin results to notes',
          }, [
            m('span', this.pinSuccess ? '✓' : '📌'),
            m('span', this.pinSuccess ? 'Pinned!' : 'Pin'),
          ]) : null,
          m('button', {
            style: STYLES.copyBtn,
            onclick: () => this.copyResults(columns, rows),
            title: 'Copy all results as TSV',
          }, [
            m('span', this.copySuccess ? '✓' : '📋'),
            m('span', this.copySuccess ? 'Copied!' : 'Copy'),
          ]),
          hasMore ? m('button', {
            style: STYLES.expandBtn,
            onclick: () => {
              this.expanded = !this.expanded;
              m.redraw();
            },
          }, this.expanded ? `▲ Show less` : `▼ Show all (${rowCount})`) : null,
        ]),
      ]),

      // Statistics section (collapsible)
      this.showStats ? m('div', {style: STYLES.stats}, [
        m('div', {style: STYLES.statsGrid},
          Object.entries(stats).map(([key, value]) =>
            m('div', {style: STYLES.statItem}, [
              m('span', {style: STYLES.statLabel}, key),
              m('span', {style: STYLES.statValue}, String(value)),
            ])
          )
        ),
      ]) : null,

      // Export buttons
      onExport ? m('div', {style: STYLES.exportActions}, [
        m('button', {
          style: STYLES.exportBtn,
          onclick: () => onExport('csv'),
          title: 'Export as CSV',
        }, '📄 CSV'),
        m('button', {
          style: STYLES.exportBtn,
          onclick: () => onExport('json'),
          title: 'Export as JSON',
        }, '📋 JSON'),
      ]) : null,

      // Table
      m('div', {style: STYLES.tableWrapper},
        m('table', {style: STYLES.table}, [
          m('thead',
            m('tr',
              columns.map((col) =>
                m('th', {
                  style: STYLES.th,
                  title: col,
                  onclick: () => this.copyColumn(rows, columns.indexOf(col)),
                }, col)
              )
            )
          ),
          m('tbody',
            displayRows.map((row, rowIndex) =>
              m('tr', {
                style: STYLES.tr,
                key: rowIndex,
                onclick: () => this.copyRow(row),
                title: 'Click to copy row',
              },
                row.map((cell, cellIndex) =>
                  m('td', {
                    style: STYLES.td,
                    key: cellIndex,
                    title: this.formatCellValue(cell),
                  }, this.formatCellValue(cell))
                )
              )
            )
          ),
        ])
      ),
    ]);
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
    if (value > 1_000_000_000) return (value / 1_000_000_000).toFixed(2) + 's';
    if (value > 1_000_000) return (value / 1_000_000).toFixed(2) + 'ms';
    if (value > 1000) return (value / 1000).toFixed(2) + 'µs';
    return value.toFixed(2);
  }

  private formatCellValue(value: any): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (typeof value === 'number') {
      // Format timestamps as readable time
      if (value > 1_000_000_000) {
        return (value / 1_000_000_000).toFixed(2) + 's';
      }
      if (value > 1_000_000) {
        return (value / 1_000_000).toFixed(2) + 'ms';
      }
      if (value > 1000) {
        return (value / 1000).toFixed(2) + 'µs';
      }
      return String(value);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  }

  private async copyResults(columns: string[], rows: any[][]) {
    // Copy as TSV (tab-separated values)
    const header = columns.join('\t');
    const data = rows.map((row) =>
      row.map((cell) => this.formatCellValue(cell)).join('\t')
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

  private async copyRow(row: any[]) {
    const text = row.map((cell) => this.formatCellValue(cell)).join('\t');
    try {
      await navigator.clipboard.writeText(text);
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

  private async copyColumn(rows: any[][], colIndex: number) {
    const columnData = rows.map((row) => this.formatCellValue(row[colIndex])).join('\n');
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
}
