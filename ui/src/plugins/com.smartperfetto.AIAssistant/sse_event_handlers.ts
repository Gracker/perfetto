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
 * SSE (Server-Sent Events) event handlers for the AI Assistant plugin.
 *
 * This module processes SSE events from the backend analysis API,
 * transforming raw event data into UI-friendly messages and state updates.
 *
 * Event types handled:
 * - progress: Analysis progress updates
 * - sql_generated/sql_executed: SQL query lifecycle
 * - skill_section/skill_layered_result: Skill execution results
 * - hypothesis_generated/round_start: Agent-driven analysis
 * - analysis_completed/error: Terminal events
 */

import {Message} from './types';
import {
  formatDisplayValue,
  formatLayerName,
  translateCategory,
  translateComponent,
  extractConclusionFromOverview,
  convertToExpandableSections,
  parseSummaryToTable,
} from './data_formatter';
import {
  DataEnvelope,
  DataPayload,
  isDataEnvelope,
  envelopeToSqlQueryResult,
} from './generated';

/**
 * Context object passed to SSE event handlers.
 * Contains references to state and methods needed for event processing.
 */
export interface SSEHandlerContext {
  /** Add a message to the conversation */
  addMessage: (msg: Message) => void;
  /** Generate a unique message ID */
  generateId: () => string;
  /** Get the current messages array (read-only) */
  getMessages: () => readonly Message[];
  /** Remove the last message if it matches a condition */
  removeLastMessageIf: (predicate: (msg: Message) => boolean) => boolean;
  /** Set/get loading state */
  setLoading: (loading: boolean) => void;
  /** Track displayed skill progress for deduplication */
  displayedSkillProgress: Set<string>;
  /** Collected non-fatal errors for summary */
  collectedErrors: Array<{
    skillId: string;
    stepId?: string;
    error: string;
    timestamp: number;
  }>;
  /** Whether completion event was already handled */
  completionHandled: boolean;
  /** Set completion handled flag */
  setCompletionHandled: (handled: boolean) => void;
  /** Backend URL for building report links */
  backendUrl: string;
}

/**
 * Handler result indicating what action to take after processing.
 */
export interface SSEHandlerResult {
  /** Whether this is a terminal event (analysis complete or error) */
  isTerminal?: boolean;
  /** Whether to stop loading indicator */
  stopLoading?: boolean;
}

/**
 * Process a progress event - shows analysis phase updates.
 */
export function handleProgressEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data?.message) {
    // Remove previous progress message
    ctx.removeLastMessageIf(
      msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
    );
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `⏳ ${data.data.message}`,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process sql_executed event - shows query results.
 */
export function handleSqlExecutedEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data?.result) {
    const rowCount = data.data.result.rowCount || 0;
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `📊 查询到 **${rowCount}** 条记录`,
      timestamp: Date.now(),
      sqlResult: {
        columns: data.data.result.columns || [],
        rows: data.data.result.rows || [],
        rowCount,
        query: data.data.sql || '',
        expandableData: data.data.result.expandableData,
        summary: data.data.result.summary,
      },
    });
  }
  return {};
}

/**
 * Process skill_section event - displays skill step data as a table.
 */
export function handleSkillSectionEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data) {
    const section = data.data;
    // Remove previous progress message
    ctx.removeLastMessageIf(
      msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
    );
    // Show progress for this section - use sectionTitle for compact display
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: '',  // No message content, title is in table header
      timestamp: Date.now(),
      sqlResult: section.rowCount > 0 ? {
        columns: section.columns,
        rows: section.rows,
        rowCount: section.rowCount,
        query: '',  // No SQL display
        sectionTitle: `${section.sectionTitle} (${section.sectionIndex}/${section.totalSections})`,
        expandableData: section.expandableData,
        summary: section.summary,
      } : undefined,
    });
  }
  return {};
}

/**
 * Process skill_diagnostics event - shows diagnostic messages.
 */
export function handleSkillDiagnosticsEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data?.diagnostics && data.data.diagnostics.length > 0) {
    const diagnostics = data.data.diagnostics;
    const criticalItems = diagnostics.filter((d: any) => d.severity === 'critical');
    const warningItems = diagnostics.filter((d: any) => d.severity === 'warning');
    const infoItems = diagnostics.filter((d: any) => d.severity === 'info');

    let content = '**🔍 诊断结果**\n\n';
    if (criticalItems.length > 0) {
      content += '🔴 **严重问题:**\n';
      criticalItems.forEach((d: any) => {
        content += `- ${d.message}\n`;
        if (d.suggestions && d.suggestions.length > 0) {
          content += `  *建议: ${d.suggestions.join('; ')}*\n`;
        }
      });
      content += '\n';
    }
    if (warningItems.length > 0) {
      content += '🟡 **警告:**\n';
      warningItems.forEach((d: any) => {
        content += `- ${d.message}\n`;
      });
      content += '\n';
    }
    if (infoItems.length > 0) {
      content += '🔵 **提示:**\n';
      infoItems.forEach((d: any) => {
        content += `- ${d.message}\n`;
      });
    }

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: content.trim(),
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process skill_layered_result event - displays multi-layer analysis results.
 * Handles overview (L1), list (L2), and deep (L4) layer data.
 */
export function handleSkillLayeredResultEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const layeredResult = data?.data?.result?.layers || data?.data?.layers;
  if (!layeredResult) return {};

  // Deduplication check
  const skillId = data.data.skillId || data.data.result?.metadata?.skillId || 'unknown';
  const deduplicationKey = `skill_layered_result:${skillId}`;
  if (ctx.displayedSkillProgress.has(deduplicationKey)) {
    console.log('[SSEHandlers] Skipping duplicate skill_layered_result:', deduplicationKey);
    return {};
  }
  ctx.displayedSkillProgress.add(deduplicationKey);

  console.log('[SSEHandlers] skill_layered_result received:', data.data);
  const layers = layeredResult;
  const metadata = data.data.result?.metadata || {
    skillName: data.data.skillName || data.data.skillId,
  };

  // Remove previous progress message
  ctx.removeLastMessageIf(
    msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
  );

  // Process overview layer (L1)
  const overview = layers.overview || layers.L1;
  if (overview && Object.keys(overview).length > 0) {
    processOverviewLayer(overview, metadata, ctx);
  }

  // Process list layer (L2)
  const deep = layers.deep || layers.L4;
  const list = layers.list || layers.L2;
  if (list && typeof list === 'object') {
    processListLayer(list, deep, ctx);
  }

  // Show conclusion card if available
  const conclusion = data.data.result?.conclusion || extractConclusionFromOverview(overview);
  if (conclusion && conclusion.category && conclusion.category !== 'UNKNOWN') {
    renderConclusionCard(conclusion, ctx);
  }

  // Show summary if available
  if (data.data.summary) {
    renderSummary(data.data.summary, ctx);
  }

  return {};
}

/**
 * Process overview (L1) layer data.
 */
function processOverviewLayer(
  overview: Record<string, any>,
  metadata: any,
  ctx: SSEHandlerContext
): void {
  // Helper to check if object is a StepResult format
  const isStepResult = (obj: any): boolean => {
    return obj && typeof obj === 'object' && 'data' in obj && Array.isArray(obj.data);
  };

  // Helper to extract data from StepResult
  const extractData = (obj: any): any[] | null => {
    if (isStepResult(obj)) {
      return obj.data;
    }
    return null;
  };

  // Helper to get display title
  const getDisplayTitle = (key: string, obj: any): string => {
    if (isStepResult(obj) && obj.display?.title) {
      return obj.display.title;
    }
    const skillContext = metadata.skillName ? ` (${metadata.skillName})` : '';
    return formatLayerName(key) + skillContext;
  };

  // Helper to get display format
  const getDisplayFormat = (obj: any): string => {
    return (obj?.display?.format || 'table').toLowerCase();
  };

  // Process each entry in overview layer
  for (const [key, val] of Object.entries(overview)) {
    if (val === null || val === undefined) continue;

    const format = getDisplayFormat(val);
    const title = getDisplayTitle(key, val);

    // Route based on display format
    if (format === 'chart') {
      const chartData = buildChartData(val, title);
      if (chartData) {
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          chartData,
        });
        continue;
      }
    } else if (format === 'metric') {
      const metricData = buildMetricData(val, title);
      if (metricData) {
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          metricData,
        });
        continue;
      }
    }

    // Default: table format
    const dataArray = extractData(val);
    if (dataArray && dataArray.length > 0) {
      const firstRow = dataArray[0];
      if (typeof firstRow === 'object' && firstRow !== null) {
        const columns = Object.keys(firstRow);
        const rows = dataArray.map((item: any) =>
          columns.map(col => formatDisplayValue(item[col], col))
        );

        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          sqlResult: {
            columns,
            rows,
            rowCount: rows.length,
            sectionTitle: `📊 ${title}`,
          },
        });
      }
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      // Nested object: display as single-row table
      const objColumns = Object.keys(val);
      const objRow = objColumns.map(col => formatDisplayValue((val as any)[col], col));

      ctx.addMessage({
        id: ctx.generateId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        sqlResult: {
          columns: objColumns,
          rows: [objRow],
          rowCount: 1,
          sectionTitle: `📈 ${formatLayerName(key)}`,
        },
      });
    }
  }
}

/**
 * Build chart data from step result.
 */
function buildChartData(obj: any, title: string): Message['chartData'] | null {
  const dataArray = obj?.data;
  if (!Array.isArray(dataArray) || dataArray.length === 0) return null;

  const firstRow = dataArray[0];
  if (!firstRow || typeof firstRow !== 'object') return null;

  const keys = Object.keys(firstRow);
  const labelKey = keys.find(k =>
    k.toLowerCase().includes('label') ||
    k.toLowerCase().includes('name') ||
    k.toLowerCase().includes('type')
  );
  const valueKey = keys.find(k =>
    k.toLowerCase().includes('value') ||
    k.toLowerCase().includes('count') ||
    k.toLowerCase().includes('total')
  );

  if (!labelKey || !valueKey) return null;

  return {
    type: 'bar',
    title: title,
    data: dataArray.map((item: any) => ({
      label: String(item[labelKey] || 'Unknown'),
      value: Number(item[valueKey]) || 0,
    })),
  };
}

/**
 * Build metric data from step result.
 */
function buildMetricData(obj: any, title: string): Message['metricData'] | null {
  const dataArray = obj?.data;
  if (!Array.isArray(dataArray) || dataArray.length === 0) return null;

  const firstRow = dataArray[0];
  if (!firstRow || typeof firstRow !== 'object') return null;

  const keys = Object.keys(firstRow);
  const valueKey = keys.find(k =>
    k.toLowerCase().includes('value') ||
    k.toLowerCase().includes('total') ||
    k.toLowerCase().includes('avg')
  );

  if (valueKey) {
    const value = firstRow[valueKey];
    return {
      title: title,
      value: typeof value === 'number' ? value.toFixed(2) : String(value),
      status: firstRow.status || undefined,
    };
  }

  // If single key-value pair, use first entry
  if (keys.length === 1) {
    return {
      title: title,
      value: String(firstRow[keys[0]]),
    };
  }

  return null;
}

/**
 * Process list (L2) layer data with optional deep (L4) expandable content.
 */
function processListLayer(
  list: Record<string, any>,
  deep: Record<string, any> | undefined,
  ctx: SSEHandlerContext
): void {
  // Helper to check if object is a StepResult format
  const isStepResult = (obj: any): boolean => {
    if (!obj || typeof obj !== 'object' || !('data' in obj)) return false;
    if (Array.isArray(obj.data)) return true;
    if (obj.data && typeof obj.data === 'object' &&
        (Array.isArray(obj.data.columns) || Array.isArray(obj.data.rows))) {
      return true;
    }
    return false;
  };

  // Helper to check if data is in DataPayload format
  const isDataPayloadFormat = (data: any): boolean => {
    return data && typeof data === 'object' &&
      !Array.isArray(data) &&
      (Array.isArray(data.columns) || Array.isArray(data.rows));
  };

  // Helper to find frame detail in deep layer
  const findFrameDetail = (frameId: string | number, sessionId?: string | number): any => {
    if (!deep || typeof deep !== 'object') return null;

    const sessionKeys = sessionId !== undefined
      ? [String(sessionId), `session_${sessionId}`]
      : [];
    const frameKeys = [String(frameId), `frame_${frameId}`];

    for (const [sid, frames] of Object.entries(deep)) {
      if (sessionId !== undefined) {
        const sessionMatches = sessionKeys.some(sk => sid === sk);
        if (!sessionMatches) continue;
      }

      if (frames && typeof frames === 'object') {
        for (const fk of frameKeys) {
          const frameData = (frames as any)[fk];
          if (frameData) return frameData;
        }
      }
    }
    return null;
  };

  for (const [key, value] of Object.entries(list)) {
    let items: any[] = [];
    let columns: string[] = [];
    let rows: any[][] = [];
    let displayTitle = formatLayerName(key);
    let isExpandable = false;
    let metadataColumns: string[] = [];
    let hiddenColumns: string[] = [];
    let preBindedExpandableData: any[] | undefined;
    let summaryReport: any | undefined;

    if (isStepResult(value)) {
      const stepData = (value as any).data;
      const displayConfig = (value as any).display;

      if (displayConfig?.title) {
        displayTitle = displayConfig.title;
      }
      isExpandable = displayConfig?.expandable === true;
      metadataColumns = displayConfig?.metadataFields || displayConfig?.metadata_columns || [];
      hiddenColumns = displayConfig?.hidden_columns || displayConfig?.hiddenColumns || [];

      // Extract hidden columns from column definitions
      if (displayConfig?.columns && Array.isArray(displayConfig.columns)) {
        const hiddenFromDefs = displayConfig.columns
          .filter((c: any) => c.hidden === true)
          .map((c: any) => c.name);
        hiddenColumns = [...new Set([...hiddenColumns, ...hiddenFromDefs])];
      }

      if (isDataPayloadFormat(stepData)) {
        // NEW DataPayload format
        const allColumns = stepData.columns || [];
        const allRows = stepData.rows || [];
        preBindedExpandableData = stepData.expandableData;
        summaryReport = stepData.summary;

        items = allRows.map((row: any[]) => {
          const obj: Record<string, any> = {};
          allColumns.forEach((col: string, i: number) => { obj[col] = row[i]; });
          return obj;
        });

        // Apply column filtering
        const columnsToHide = new Set([...metadataColumns, ...hiddenColumns]);
        if (columnsToHide.size > 0) {
          const visibleIndices: number[] = [];
          columns = allColumns.filter((col: string, idx: number) => {
            if (!columnsToHide.has(col)) {
              visibleIndices.push(idx);
              return true;
            }
            return false;
          });
          rows = allRows.map((row: any[]) =>
            visibleIndices.map(idx => formatDisplayValue(row[idx], allColumns[idx]))
          );
        } else {
          columns = allColumns;
          rows = allRows.map((row: any[]) =>
            row.map((val, idx) => formatDisplayValue(val, allColumns[idx]))
          );
        }
      } else {
        // Legacy format: data is array of row objects
        items = stepData;
      }
    } else if (Array.isArray(value)) {
      items = value;
    }

    // Skip if no data
    if (items.length === 0 && rows.length === 0) continue;

    // Build columns/rows from items if needed
    if (columns.length === 0 && items.length > 0) {
      const allColumns = Object.keys(items[0] || {});
      const columnsToHide = new Set([...metadataColumns, ...hiddenColumns]);
      columns = allColumns.filter(col => !columnsToHide.has(col));
      rows = items.map((item: any) => columns.map(col => formatDisplayValue(item[col], col)));
    }

    // Build expandable data
    let expandableData: any[] | undefined;
    if (preBindedExpandableData && preBindedExpandableData.length > 0) {
      expandableData = preBindedExpandableData;
    } else if (isExpandable && deep) {
      expandableData = items.map((item: any) => {
        const frameId = item.frame_id || item.frameId || item.id;
        const sessionId = item.session_id || item.sessionId;
        const frameDetail = findFrameDetail(frameId, sessionId);

        if (frameDetail) {
          const sections = convertToExpandableSections(frameDetail.data);
          return {
            item: frameDetail.item || item,
            result: { success: true, sections },
          };
        }
        return null;
      });
    }

    // Extract metadata for header display
    const extractedMetadata: Record<string, any> = {};
    if (metadataColumns.length > 0 && items.length > 0) {
      for (const col of metadataColumns) {
        if (items[0][col] !== undefined) {
          extractedMetadata[col] = items[0][col];
        }
      }
    }

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      sqlResult: {
        columns,
        rows,
        rowCount: rows.length,
        sectionTitle: `📋 ${displayTitle} (${rows.length}条)`,
        expandableData: expandableData && expandableData.filter(Boolean).length > 0
          ? expandableData
          : undefined,
        metadata: Object.keys(extractedMetadata).length > 0 ? extractedMetadata : undefined,
        summaryReport: summaryReport,
      },
    });
  }
}

/**
 * Render conclusion card from analysis result.
 */
function renderConclusionCard(conclusion: any, ctx: SSEHandlerContext): void {
  const categoryEmoji = conclusion.category === 'APP' ? '📱' :
                        conclusion.category === 'SYSTEM' ? '⚙️' :
                        conclusion.category === 'MIXED' ? '🔄' : '❓';
  const confidencePercent = Math.round((conclusion.confidence || 0.5) * 100);
  const confidenceBar = '█'.repeat(Math.floor(confidencePercent / 10)) +
                        '░'.repeat(10 - Math.floor(confidencePercent / 10));

  let conclusionContent = `## 🎯 分析结论\n\n`;
  conclusionContent += `**问题分类:** ${categoryEmoji} **${translateCategory(conclusion.category)}**\n`;
  conclusionContent += `**问题组件:** \`${translateComponent(conclusion.component)}\`\n`;
  conclusionContent += `**置信度:** ${confidenceBar} ${confidencePercent}%\n\n`;
  conclusionContent += `### 📋 根因分析\n${conclusion.summary}\n\n`;

  if (conclusion.suggestion) {
    conclusionContent += `### 💡 优化建议\n${conclusion.suggestion}\n\n`;
  }

  if (conclusion.evidence && Array.isArray(conclusion.evidence) && conclusion.evidence.length > 0) {
    conclusionContent += `### 📊 证据\n`;
    conclusion.evidence.forEach((e: string) => {
      conclusionContent += `- ${e}\n`;
    });
  }

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'assistant',
    content: conclusionContent,
    timestamp: Date.now(),
  });
}

/**
 * Render summary section.
 */
function renderSummary(summary: string, ctx: SSEHandlerContext): void {
  const summaryTableData = parseSummaryToTable(summary);
  if (summaryTableData) {
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      sqlResult: {
        columns: summaryTableData.columns,
        rows: summaryTableData.rows,
        rowCount: summaryTableData.rows.length,
        sectionTitle: '📝 分析摘要',
      },
    });
  } else {
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `**📝 分析摘要:** ${summary}`,
      timestamp: Date.now(),
    });
  }
}

/**
 * Process analysis_completed event - final analysis result.
 */
export function handleAnalysisCompletedEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  console.log('[SSEHandlers] analysis_completed received, architecture:', data?.architecture);

  // Guard against duplicate handling
  if (ctx.completionHandled) {
    console.log('[SSEHandlers] Completion already handled, skipping');
    return { isTerminal: true, stopLoading: true };
  }

  // Support both 'answer' (legacy) and 'conclusion' (agent-driven)
  const answerContent = data?.data?.answer || data?.data?.conclusion;

  if (answerContent) {
    ctx.setCompletionHandled(true);

    // Remove any remaining progress message
    ctx.removeLastMessageIf(
      msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
    );

    // Build content with agent-driven metadata if available
    let content = answerContent;

    const isAgentDriven = data?.architecture === 'v2-agent-driven' || data?.architecture === 'agent-driven';
    if (isAgentDriven && data?.data?.hypotheses) {
      const hypotheses = data.data.hypotheses;
      const confirmed = hypotheses.filter((h: any) => h.status === 'confirmed');
      const confidence = data.data.confidence || 0;

      if (confirmed.length > 0 || confidence > 0) {
        content += `\n\n---\n**分析元数据**\n`;
        content += `- 置信度: ${(confidence * 100).toFixed(0)}%\n`;
        content += `- 分析轮次: ${data.data.rounds || 1}\n`;
        if (confirmed.length > 0) {
          content += `- 确认假设: ${confirmed.map((h: any) => h.description).join(', ')}\n`;
        }
      }
    }

    const reportUrl = data.data.reportUrl;
    if (!reportUrl && data.data.reportError) {
      console.warn('[SSEHandlers] HTML report generation failed:', data.data.reportError);
    }

    // Check if conclusion was already shown
    const messages = ctx.getMessages();
    const hasConclusionAlready = messages.some(
      m => m.role === 'assistant' && m.content.includes('🎯 分析结论')
    );

    if (!hasConclusionAlready) {
      ctx.addMessage({
        id: ctx.generateId(),
        role: 'assistant',
        content: content,
        timestamp: Date.now(),
        reportUrl: reportUrl ? `${ctx.backendUrl}${reportUrl}` : undefined,
      });
    }
  }

  // Show error summary if there were any non-fatal errors
  if (ctx.collectedErrors.length > 0) {
    showErrorSummary(ctx);
  }

  return { isTerminal: true, stopLoading: true };
}

/**
 * Process hypothesis_generated event - initial hypotheses from AI.
 */
export function handleHypothesisGeneratedEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data?.hypotheses && Array.isArray(data.data.hypotheses)) {
    const hypotheses = data.data.hypotheses;
    ctx.removeLastMessageIf(
      msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
    );

    let content = `### 🧪 生成了 ${hypotheses.length} 个分析假设\n`;
    for (let i = 0; i < hypotheses.length; i++) {
      const h = hypotheses[i];
      content += `${i + 1}. ${h}\n`;
    }
    content += '\n_AI 将验证这些假设..._';

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process round_start event - analysis round started.
 */
export function handleRoundStartEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data) {
    const round = data.data.round || 1;
    const maxRounds = data.data.maxRounds || 5;
    const message = data.data.message || `分析轮次 ${round}`;

    ctx.removeLastMessageIf(
      msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
    );

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `⏳ 🔄 ${message} (${round}/${maxRounds})`,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process agent_task_dispatched event - tasks sent to domain agents.
 */
export function handleAgentTaskDispatchedEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data) {
    const taskCount = data.data.taskCount || 0;
    const agents = data.data.agents || [];
    const message = data.data.message || `派发 ${taskCount} 个任务`;

    ctx.removeLastMessageIf(
      msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
    );

    let content = `⏳ 🤖 ${message}`;
    if (agents.length > 0) {
      content += `\n\n派发给: ${agents.map((a: string) => `\`${a}\``).join(', ')}`;
    }

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process synthesis_complete event - feedback synthesis complete.
 */
export function handleSynthesisCompleteEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data) {
    const confirmedFindings = data.data.confirmedFindings || 0;
    const updatedHypotheses = data.data.updatedHypotheses || 0;
    const message = data.data.message || '综合分析结果';

    ctx.removeLastMessageIf(
      msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
    );

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `⏳ 📝 ${message}\n\n确认 ${confirmedFindings} 个发现，更新 ${updatedHypotheses} 个假设`,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process strategy_decision event - next iteration strategy decided.
 */
export function handleStrategyDecisionEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data) {
    const strategy = data.data.strategy || 'continue';
    const confidence = data.data.confidence || 0;
    const message = data.data.message || `策略: ${strategy}`;

    ctx.removeLastMessageIf(
      msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
    );

    const strategyEmoji = strategy === 'conclude' ? '✅' :
                         strategy === 'deep_dive' ? '🔍' :
                         strategy === 'pivot' ? '↩️' : '➡️';

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `⏳ ${strategyEmoji} ${message} (置信度: ${(confidence * 100).toFixed(0)}%)`,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process data event - v2.0 DataEnvelope format.
 */
export function handleDataEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (!data) return {};

  console.log('[SSEHandlers] v2.0 data event received:', data.id, data.envelope);

  const envelopes: DataEnvelope[] = Array.isArray(data.envelope)
    ? data.envelope
    : [data.envelope];

  for (const envelope of envelopes) {
    if (!isDataEnvelope(envelope)) {
      console.warn('[SSEHandlers] Invalid DataEnvelope:', envelope);
      continue;
    }

    // Generate deduplication key
    const deduplicationKey = envelope.meta.source ||
      `${envelope.meta.skillId || 'unknown'}:${envelope.meta.stepId || 'unknown'}`;

    if (ctx.displayedSkillProgress.has(deduplicationKey)) {
      console.log('[SSEHandlers] Skipping duplicate data envelope:', deduplicationKey);
      continue;
    }
    ctx.displayedSkillProgress.add(deduplicationKey);

    ctx.removeLastMessageIf(
      msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
    );

    renderDataEnvelope(envelope, ctx);
  }

  return {};
}

/**
 * Render a DataEnvelope based on its display format.
 */
function renderDataEnvelope(envelope: DataEnvelope, ctx: SSEHandlerContext): void {
  const format = envelope.display.format || 'table';
  const payload = envelope.data as DataPayload;
  const title = envelope.display.title;

  switch (format) {
    case 'text':
      if (payload.text) {
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: `**${title}**\n\n${payload.text}`,
          timestamp: Date.now(),
        });
      }
      break;

    case 'summary':
      if (payload.summary) {
        let summaryContent = `## 📊 ${payload.summary.title || title}\n\n`;
        summaryContent += payload.summary.content + '\n';

        if (payload.summary.metrics && payload.summary.metrics.length > 0) {
          summaryContent += '\n### 关键指标\n\n';
          for (const metric of payload.summary.metrics) {
            const icon = metric.severity === 'critical' ? '🔴' :
                         metric.severity === 'warning' ? '🟡' : '🟢';
            const unit = metric.unit || '';
            summaryContent += `${icon} **${metric.label}:** ${metric.value}${unit}\n`;
          }
        }

        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: summaryContent,
          timestamp: Date.now(),
        });
      }
      break;

    case 'metric':
      if (payload.summary && payload.summary.metrics) {
        let metricContent = `### 📈 ${title}\n\n`;
        for (const metric of payload.summary.metrics) {
          const icon = metric.severity === 'critical' ? '🔴' :
                       metric.severity === 'warning' ? '🟡' : '🟢';
          const unit = metric.unit || '';
          metricContent += `| ${icon} ${metric.label} | **${metric.value}${unit}** |\n`;
        }
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: metricContent,
          timestamp: Date.now(),
        });
      }
      break;

    case 'chart':
      if (payload.chart) {
        const chartConfig = payload.chart;
        let chartContent = `### 📉 ${title}\n\n`;
        chartContent += `**图表类型:** ${chartConfig.type}\n\n`;
        chartContent += `*[图表渲染暂未实现，数据已记录]*\n`;
        console.log('[SSEHandlers] Chart data received:', chartConfig);
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: chartContent,
          timestamp: Date.now(),
        });
      }
      break;

    case 'timeline':
      ctx.addMessage({
        id: ctx.generateId(),
        role: 'assistant',
        content: `### ⏱️ ${title}\n\n*[时间线渲染暂未实现]*\n`,
        timestamp: Date.now(),
      });
      break;

    case 'table':
    default:
      const rawResult = envelopeToSqlQueryResult(envelope);
      let filteredColumns = rawResult.columns;
      let filteredRows = rawResult.rows;
      let filteredColumnDefs = rawResult.columnDefinitions;

      if (rawResult.columnDefinitions && Array.isArray(rawResult.columnDefinitions)) {
        const hiddenFromDefs = rawResult.columnDefinitions
          .filter((c: any) => c.hidden === true)
          .map((c: any) => c.name);
        const metadataFields = envelope.display.metadataFields || [];
        const columnsToHide = new Set([...hiddenFromDefs, ...metadataFields]);

        if (columnsToHide.size > 0 && rawResult.columns.length > 0) {
          const visibleIndices: number[] = [];
          filteredColumns = rawResult.columns.filter((col: string, idx: number) => {
            if (!columnsToHide.has(col)) {
              visibleIndices.push(idx);
              return true;
            }
            return false;
          });

          filteredRows = rawResult.rows.map((row: any[]) =>
            visibleIndices.map(idx => row[idx])
          );

          filteredColumnDefs = rawResult.columnDefinitions.filter(
            (def: any) => !columnsToHide.has(def.name)
          );
        }
      }

      if (filteredRows.length > 0) {
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          sqlResult: {
            columns: filteredColumns,
            rows: filteredRows,
            rowCount: filteredRows.length,
            columnDefinitions: filteredColumnDefs,
            sectionTitle: title,
            group: envelope.display.group,
            collapsible: envelope.display.collapsible,
            defaultCollapsed: envelope.display.defaultCollapsed,
            maxVisibleRows: envelope.display.maxVisibleRows,
          },
        });
      }
      break;
  }
}

/**
 * Process skill_error event - collect non-fatal skill errors.
 */
export function handleSkillErrorEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data) {
    const errorInfo = {
      skillId: data.skillId || 'unknown',
      stepId: data.data?.stepId,
      error: data.data?.error || 'Unknown error',
      timestamp: Date.now(),
    };
    console.log('[SSEHandlers] Skill error collected:', errorInfo);
    ctx.collectedErrors.push(errorInfo);
  }
  return {};
}

/**
 * Process error event - fatal error occurred.
 */
export function handleErrorEvent(
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  if (data?.data?.error) {
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `**错误:** ${data.data.error}`,
      timestamp: Date.now(),
    });
  }

  // Show collected errors summary if any
  if (ctx.collectedErrors.length > 0) {
    showErrorSummary(ctx);
  }

  return { isTerminal: true, stopLoading: true };
}

/**
 * Show a summary of all collected errors from the analysis.
 */
function showErrorSummary(ctx: SSEHandlerContext): void {
  if (ctx.collectedErrors.length === 0) return;

  // Group errors by skillId
  const errorsBySkill = new Map<string, Array<{ stepId?: string; error: string }>>();
  for (const err of ctx.collectedErrors) {
    if (!errorsBySkill.has(err.skillId)) {
      errorsBySkill.set(err.skillId, []);
    }
    errorsBySkill.get(err.skillId)!.push({ stepId: err.stepId, error: err.error });
  }

  let summaryContent = `### ⚠️ 分析过程中遇到 ${ctx.collectedErrors.length} 个错误\n\n`;

  for (const [skillId, errors] of errorsBySkill) {
    summaryContent += `**Skill: ${skillId}**\n`;
    for (const err of errors) {
      const stepInfo = err.stepId ? ` (step: ${err.stepId})` : '';
      summaryContent += `- ${err.error}${stepInfo}\n`;
    }
    summaryContent += '\n';
  }

  summaryContent += `\n*这些错误不影响其他分析结果的展示，但可能导致部分数据缺失。*`;

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'assistant',
    content: summaryContent,
    timestamp: Date.now(),
  });

  // Clear collected errors after showing summary
  ctx.collectedErrors.length = 0;
}

/**
 * Main SSE event dispatcher.
 * Routes events to appropriate handlers based on event type.
 */
export function handleSSEEvent(
  eventType: string,
  data: any,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  console.log('[SSEHandlers] SSE event:', eventType, data);

  switch (eventType) {
    case 'connected':
      return {};

    case 'progress':
      return handleProgressEvent(data, ctx);

    case 'sql_generated':
      // SQL was generated - don't show raw SQL to user
      return {};

    case 'sql_executed':
      return handleSqlExecutedEvent(data, ctx);

    case 'step_completed':
      // A step was completed - already shown in sql_executed
      return {};

    case 'skill_section':
      return handleSkillSectionEvent(data, ctx);

    case 'skill_diagnostics':
      return handleSkillDiagnosticsEvent(data, ctx);

    case 'skill_layered_result':
      return handleSkillLayeredResultEvent(data, ctx);

    case 'analysis_completed':
      return handleAnalysisCompletedEvent(data, ctx);

    case 'thought':
    case 'worker_thought':
      // Skip thought messages to reduce noise
      console.log(`[SSEHandlers] Skipping ${eventType} display`);
      return {};

    case 'data':
      return handleDataEvent(data, ctx);

    case 'skill_data':
      // DEPRECATED: Convert to skill_layered_result
      console.warn('[SSEHandlers] DEPRECATED: skill_data event received');
      if (data?.data) {
        const transformedData = {
          data: {
            skillId: data.data.skillId,
            skillName: data.data.skillName,
            layers: data.data.layers,
            diagnostics: data.data.diagnostics,
          },
        };
        return handleSkillLayeredResultEvent(transformedData, ctx);
      }
      return {};

    case 'finding':
      // Skip finding display - data shown in tables
      console.log('[SSEHandlers] Skipping finding display');
      return {};

    case 'hypothesis_generated':
      return handleHypothesisGeneratedEvent(data, ctx);

    case 'round_start':
      return handleRoundStartEvent(data, ctx);

    case 'stage_start':
      // Stage start in strategy execution
      if (data?.data?.message) {
        ctx.removeLastMessageIf(
          msg => msg.role === 'assistant' && msg.content.startsWith('⏳')
        );
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: `⏳ 📋 ${data.data.message}`,
          timestamp: Date.now(),
        });
      }
      return {};

    case 'agent_task_dispatched':
      return handleAgentTaskDispatchedEvent(data, ctx);

    case 'agent_dialogue':
      // Agent communication - tracked internally
      console.log('[SSEHandlers] Agent dialogue event:', data?.data);
      return {};

    case 'agent_response':
      // Agent completed task - wait for synthesis
      console.log(`[SSEHandlers] Agent ${data?.data?.agentId || 'unknown'} completed task`);
      return {};

    case 'synthesis_complete':
      return handleSynthesisCompleteEvent(data, ctx);

    case 'strategy_decision':
      return handleStrategyDecisionEvent(data, ctx);

    case 'conclusion':
      // Skip - let analysis_completed handle final message
      console.log('[SSEHandlers] CONCLUSION event received - waiting for analysis_completed');
      return {};

    case 'error':
      return handleErrorEvent(data, ctx);

    case 'skill_error':
      return handleSkillErrorEvent(data, ctx);

    case 'end':
      return { stopLoading: true };

    default:
      console.log(`[SSEHandlers] Unhandled event type: ${eventType}`);
      return {};
  }
}
