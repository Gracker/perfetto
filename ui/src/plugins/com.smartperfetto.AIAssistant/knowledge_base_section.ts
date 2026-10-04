// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Document knowledge bases in the codebase settings panel: register a folder
 * (local folder picker, or a typed backend path where no picker exists),
 * index it, allow its text to reach the AI service, try a search, and delete
 * it. Which knowledge bases a turn uses is chosen beside the input box. The
 * picked folder path is transient local interaction data: it lives only in
 * this form's memory until registration, and no response shows a registered
 * root.
 */

import m from 'mithril';

import {catalogIdentityKey} from './analysis_catalog';
import {
  deleteKnowledgeBase,
  getCodebaseDirectoryPickerCapability,
  knowledgeBaseSelectable,
  previewKnowledgeCollection,
  registerKnowledgeCollection,
  reindexKnowledgeCollection,
  searchKnowledgeCollection,
  selectDirectory,
  setKnowledgeBaseConsent,
  type KnowledgeBaseSummary,
  type KnowledgeCollectionPreview,
  type KnowledgeSearchHit,
} from './codebase_api';
import {
  type SmartPerfettoRequestContext,
  tryGetSmartPerfettoRequestContext,
} from '../../core/smartperfetto_request_context';
import {
  type CurrentResult,
  errorMessage,
  MANAGEMENT_STYLES as STYLES,
  runWhileCurrent,
} from './management_ui';
import {knowledgeConsentQuestion, knowledgeTextDisclosure} from './source_analysis_disclosure';
import {uiText as text} from './ui_language';

export interface KnowledgeBaseSectionAttrs {
  backendUrl: string;
  apiKey?: string;
  scopeKey: string;
  readOnly: boolean;
  /** Document collections only; the Wiki keeps its own legacy section. */
  sources: readonly KnowledgeBaseSummary[];
  /** Shown as "used this turn"; chosen in the context popover. */
  selectedIds: readonly string[];
  /** Reload the panel's lists after a mutation. */
  onChanged(): Promise<unknown>;
  /** A consent change is an authorization change: the parent restarts its session. */
  onAuthorizationChange(): void;
}

interface RegistrationForm {
  rootPath: string;
  /** Absent for a typed path, which the backend admits only under its configured knowledge roots. */
  directorySelectionId?: string;
  displayName: string;
  description: string;
  rightsAcknowledged: boolean;
  sendToProvider: boolean;
  preview: KnowledgeCollectionPreview;
}

/** What an operation pinned when it started; every later request and state write checks it. */
interface Operation {
  epoch: number;
  backendUrl: string;
  apiKey?: string;
  context: SmartPerfettoRequestContext;
  onChanged: KnowledgeBaseSectionAttrs['onChanged'];
  onAuthorizationChange: KnowledgeBaseSectionAttrs['onAuthorizationChange'];
}

function sameRequestContext(
  left: SmartPerfettoRequestContext,
  right: SmartPerfettoRequestContext | undefined,
): boolean {
  return right !== undefined && left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId && left.userId === right.userId;
}

export class KnowledgeBaseSection implements m.ClassComponent<KnowledgeBaseSectionAttrs> {
  private form: RegistrationForm | null = null;
  /** A backend path typed by hand (remote or container deployments without a local picker). */
  private manualPath: string | null = null;
  private busy: string | null = null;
  private error: string | null = null;
  private success: string | null = null;
  private searchSourceId: string | null = null;
  private searchQuery = '';
  private searchHits: KnowledgeSearchHit[] | null = null;
  /** Bumped by every identity change and by unmounting: an operation of an older epoch is gone. */
  private epoch = 0;
  private identity = '';

  onbeforeupdate(vnode: m.Vnode<KnowledgeBaseSectionAttrs>): boolean {
    this.syncIdentity(vnode.attrs);
    return true;
  }

  onremove(): void {
    this.epoch++;
    this.form = null;
    this.searchHits = null;
  }

  /** Another backend, credential or scope drops every in-flight result and the picked folder. */
  private syncIdentity(attrs: KnowledgeBaseSectionAttrs): void {
    const identity = catalogIdentityKey(attrs);
    if (identity === this.identity) return;
    this.identity = identity;
    this.epoch++;
    this.form = null;
    this.manualPath = null;
    this.busy = null;
    this.error = null;
    this.success = null;
    this.searchSourceId = null;
    this.searchHits = null;
  }

  /**
   * Start an operation pinned to this mount, identity and request scope. It
   * never starts while another one runs or the view is read-only.
   */
  private begin(attrs: KnowledgeBaseSectionAttrs, busy: string): Operation | undefined {
    const context = tryGetSmartPerfettoRequestContext();
    if (attrs.readOnly || this.busy || !context) return undefined;
    this.busy = busy;
    this.error = null;
    this.success = null;
    m.redraw();
    return {
      epoch: this.epoch, backendUrl: attrs.backendUrl, apiKey: attrs.apiKey, context,
      onChanged: attrs.onChanged, onAuthorizationChange: attrs.onAuthorizationChange,
    };
  }

  /** Still this mount, this identity, and the request scope it started in. */
  private current(op: Operation): boolean {
    return op.epoch === this.epoch && sameRequestContext(op.context, tryGetSmartPerfettoRequestContext());
  }

  /**
   * One request of an operation: issued only while it is current, and its
   * answer handed back only while it still is. Never writes component state.
   */
  private async step<T>(op: Operation, request: () => Promise<T>): Promise<CurrentResult<T> | undefined> {
    if (!this.current(op)) return undefined;
    return runWhileCurrent(() => this.current(op), request);
  }

  /**
   * End an operation: state is written only for a current one. Every caller
   * runs in the tick a current step returned (as does the list refresh that
   * follows), so this check is the second layer behind the step's own.
   */
  private finish(op: Operation, update: () => void = () => {}): void {
    if (!this.current(op)) return;
    this.busy = null;
    update();
    m.redraw();
  }

  private fail(op: Operation, error: unknown, fallback = text('知识库操作失败', 'Knowledge base action failed')): void {
    this.finish(op, () => {
      this.error = errorMessage(error, fallback);
    });
  }

  private async chooseFolder(attrs: KnowledgeBaseSectionAttrs): Promise<void> {
    const op = this.begin(attrs, 'choose');
    if (!op) return;
    // Without a local picker (remote or container backend), offer the typed path directly.
    const capability = await this.step(op, () =>
      getCodebaseDirectoryPickerCapability(op.backendUrl, op.apiKey, op.context));
    if (!capability) return;
    if (!capability.ok) return this.fail(op, capability.error);
    if (!capability.value.available) {
      return this.finish(op, () => {
        this.manualPath = '';
      });
    }
    const selection = await this.step(op, () => selectDirectory(op.backendUrl, 'knowledge', op.apiKey, op.context));
    if (!selection) return;
    if (!selection.ok) return this.fail(op, selection.error);
    const picked = selection.value;
    if (!picked.selected) return this.finish(op);
    const preview = await this.step(op, () => previewKnowledgeCollection(op.backendUrl, {
      rootPath: picked.rootPath,
      directorySelectionId: picked.directorySelectionId,
    }, op.apiKey, op.context));
    if (!preview) return;
    if (!preview.ok) return this.fail(op, preview.error);
    this.finish(op, () => {
      this.form = {
        rootPath: picked.rootPath,
        directorySelectionId: picked.directorySelectionId,
        displayName: picked.displayNameSuggestion,
        description: '',
        rightsAcknowledged: false,
        sendToProvider: false,
        preview: preview.value,
      };
    });
  }

  private async previewTypedPath(attrs: KnowledgeBaseSectionAttrs): Promise<void> {
    const rootPath = this.manualPath?.trim();
    if (!rootPath) return;
    const op = this.begin(attrs, 'choose');
    if (!op) return;
    const preview = await this.step(op, () =>
      previewKnowledgeCollection(op.backendUrl, {rootPath}, op.apiKey, op.context));
    if (!preview) return;
    if (!preview.ok) return this.fail(op, preview.error);
    this.finish(op, () => {
      this.manualPath = null;
      this.form = {
        rootPath, displayName: rootPath.split(/[\\/]/).filter(Boolean).pop() ?? '',
        description: '', rightsAcknowledged: false, sendToProvider: false, preview: preview.value,
      };
    });
  }

  /**
   * Register, refresh the list, then index. Registration and indexing are
   * reported apart: a registered source whose indexing failed is already in
   * the list, with Rebuild and Delete, so it is never registered twice. An
   * operation that lost its mount or scope stops before the next request:
   * nothing is indexed for a view that is gone.
   */
  private async register(attrs: KnowledgeBaseSectionAttrs): Promise<void> {
    const form = this.form;
    if (!form || !form.rightsAcknowledged) return;
    const op = this.begin(attrs, 'register');
    if (!op) return;
    const registered = await this.step(op, () => registerKnowledgeCollection(op.backendUrl, {
      rootPath: form.rootPath,
      directorySelectionId: form.directorySelectionId,
      displayName: form.displayName.trim() || undefined,
      description: form.description.trim() || undefined,
      rightsAcknowledged: true,
      sendToProvider: form.sendToProvider,
    }, op.apiKey, op.context));
    if (!registered) return;
    if (!registered.ok) return this.fail(op, registered.error);
    const source = registered.value;
    // The picked folder leaves memory once registered.
    this.form = null;
    this.busy = `reindex:${source.sourceId}`;
    await op.onChanged();
    const indexed = await this.step(op, () =>
      reindexKnowledgeCollection(op.backendUrl, source.sourceId, op.apiKey, op.context));
    if (!indexed) return;
    this.finish(op, () => {
      if (indexed.ok) {
        this.success = text(
          `已添加 ${source.displayName}：索引 ${indexed.value.documentCount} 个文档。`,
          `Added ${source.displayName}: indexed ${indexed.value.documentCount} documents.`,
        );
      } else {
        this.error = text(
          `已添加 ${source.displayName}，但索引失败：${errorMessage(indexed.error, '')}可在列表中重建索引或删除。`,
          `Added ${source.displayName}, but indexing failed: ${errorMessage(indexed.error, '')} Rebuild its index or delete it in the list.`,
        );
      }
    });
    await op.onChanged();
  }

  private async reindex(attrs: KnowledgeBaseSectionAttrs, source: KnowledgeBaseSummary): Promise<void> {
    const op = this.begin(attrs, `reindex:${source.sourceId}`);
    if (!op) return;
    // A rebuild changes no authorization: a running analysis keeps its pinned generation.
    const result = await this.step(op, () =>
      reindexKnowledgeCollection(op.backendUrl, source.sourceId, op.apiKey, op.context));
    if (!result) return;
    if (!result.ok) return this.fail(op, result.error);
    this.finish(op, () => {
      this.success = text(
        `已重建 ${source.displayName} 的索引：${result.value.documentCount} 个文档。`,
        `Rebuilt the index of ${source.displayName}: ${result.value.documentCount} documents.`,
      );
    });
    await op.onChanged();
  }

  private async setConsent(
    attrs: KnowledgeBaseSectionAttrs,
    source: KnowledgeBaseSummary,
    sendToProvider: boolean,
  ): Promise<void> {
    if (sendToProvider && typeof window !== 'undefined' &&
        !window.confirm(knowledgeConsentQuestion(source.displayName))) return;
    const op = this.begin(attrs, `consent:${source.sourceId}`);
    if (!op) return;
    const updated = await this.step(op, () =>
      setKnowledgeBaseConsent(op.backendUrl, source.sourceId, sendToProvider, op.apiKey, op.context));
    if (!updated) return;
    if (!updated.ok) return this.fail(op, updated.error);
    // The server confirmed the change: notify the parent before any refresh can unmount this view.
    op.onAuthorizationChange();
    this.finish(op, () => {
      this.success = sendToProvider
        ? text(`已允许发送 ${source.displayName} 的正文`, `Allowed text from ${source.displayName}`)
        : text(`已撤销 ${source.displayName} 的正文发送授权`, `Revoked text for ${source.displayName}`);
    });
    await op.onChanged();
  }

  private async remove(attrs: KnowledgeBaseSectionAttrs, source: KnowledgeBaseSummary): Promise<void> {
    if (typeof window !== 'undefined' && !window.confirm(text(
      `确认删除知识库“${source.displayName}”及其全部索引？已发送给模型的内容无法撤回。原文件夹不会被删除。`,
      `Delete the knowledge base “${source.displayName}” and every index? Content already sent to a model cannot be recalled. The folder itself is not deleted.`,
    ))) return;
    const op = this.begin(attrs, `delete:${source.sourceId}`);
    if (!op) return;
    const removed = await this.step(op, () =>
      deleteKnowledgeBase(op.backendUrl, source.sourceId, op.apiKey, op.context));
    if (!removed) return;
    if (!removed.ok) return this.fail(op, removed.error);
    this.finish(op, () => {
      if (this.searchSourceId === source.sourceId) {
        this.searchSourceId = null;
        this.searchHits = null;
      }
      this.success = text(`已删除 ${source.displayName}`, `Deleted ${source.displayName}`);
    });
    await op.onChanged();
  }

  private async search(attrs: KnowledgeBaseSectionAttrs, source: KnowledgeBaseSummary): Promise<void> {
    const query = this.searchQuery.trim();
    if (!query) return;
    const op = this.begin(attrs, `search:${source.sourceId}`);
    if (!op) return;
    const hits = await this.step(op, () =>
      searchKnowledgeCollection(op.backendUrl, source.sourceId, query, op.apiKey, op.context));
    if (!hits) return;
    if (!hits.ok) return this.fail(op, hits.error);
    this.finish(op, () => {
      if (this.searchSourceId === source.sourceId) this.searchHits = hits.value;
    });
  }

  private renderSource(attrs: KnowledgeBaseSectionAttrs, source: KnowledgeBaseSummary): m.Children {
    const selectable = knowledgeBaseSelectable(source);
    const busy = this.busy !== null;
    const searching = this.searchSourceId === source.sourceId;
    return m('div', {style: STYLES.card}, [
      m('div', {style: STYLES.name}, source.displayName),
      source.description ? m('div', {style: STYLES.meta}, source.description) : null,
      m('div', {style: STYLES.chips}, [
        m('span', {style: STYLES.chip}, text(`文档 ${source.documentCount}`, `${source.documentCount} documents`)),
        m('span', {style: STYLES.chip}, source.hasActiveIndex
          ? text('索引就绪', 'Index ready') : text('未建索引', 'Not indexed')),
        m('span', {style: STYLES.chip}, source.sendToProvider
          ? text('已允许发送正文', 'Text allowed') : text('未允许发送正文', 'Text not allowed')),
        attrs.selectedIds.includes(source.sourceId)
          ? m('span', {style: STYLES.chip}, text('本轮已选', 'Used this turn'))
          : null,
      ]),
      selectable ? null : m('div', {style: STYLES.meta}, text(
        '建好索引并允许发送正文后才能用于分析。',
        'Index it and allow its text before using it in an analysis.',
      )),
      m('div', {style: STYLES.actions}, [
        m('button', {
          type: 'button', style: STYLES.button, disabled: attrs.readOnly || busy,
          onclick: () => this.reindex(attrs, source),
        }, this.busy === `reindex:${source.sourceId}` ? text('索引中…', 'Indexing…') : text('重建索引', 'Rebuild index')),
        m('button', {
          type: 'button', style: STYLES.button, disabled: attrs.readOnly || busy || !source.rightsAcknowledged,
          onclick: () => this.setConsent(attrs, source, !source.sendToProvider),
        }, source.sendToProvider ? text('撤销正文授权', 'Revoke text') : text('允许发送正文', 'Allow text')),
        m('button', {
          type: 'button', style: STYLES.button, disabled: busy || !source.hasActiveIndex,
          onclick: () => {
            this.searchSourceId = searching ? null : source.sourceId;
            this.searchHits = null;
            this.searchQuery = '';
          },
        }, searching ? text('收起试搜索', 'Hide search') : text('试搜索', 'Try a search')),
        m('button', {
          type: 'button', style: STYLES.button, disabled: attrs.readOnly || busy,
          onclick: () => this.remove(attrs, source),
        }, this.busy === `delete:${source.sourceId}` ? text('删除中…', 'Deleting…') : text('删除', 'Delete')),
      ]),
      searching ? this.renderSearch(attrs, source) : null,
    ]);
  }

  private renderSearch(attrs: KnowledgeBaseSectionAttrs, source: KnowledgeBaseSummary): m.Children {
    return m('div', {style: STYLES.divided}, [
      m('div', {style: {display: 'flex', gap: '6px'}}, [
        m('input[type=search]', {
          style: STYLES.input,
          value: this.searchQuery,
          'aria-label': text('搜索词', 'Search terms'),
          placeholder: text('输入要在这个知识库里找的词', 'Words to find in this knowledge base'),
          oninput: (event: InputEvent) => {
            this.searchQuery = (event.target as HTMLInputElement).value;
          },
          onkeydown: (event: KeyboardEvent) => {
            if (event.key === 'Enter') void this.search(attrs, source);
          },
        }),
        m('button', {
          type: 'button', style: STYLES.button, disabled: this.busy !== null || !this.searchQuery.trim(),
          onclick: () => this.search(attrs, source),
        }, text('搜索', 'Search')),
      ]),
      this.searchHits === null
        ? null
        : this.searchHits.length === 0
          ? m('div', {style: STYLES.meta}, text('没有命中。', 'No matches.'))
          : this.searchHits.map(hit => m('div', {style: {...STYLES.divided, marginTop: '6px', paddingTop: '6px'}}, [
              m('div', {style: STYLES.name}, hit.title || hit.heading || hit.relativePath),
              m('div', {style: STYLES.meta}, `${hit.relativePath}:L${hit.startLine}-L${hit.endLine}`),
              m('div', {style: {color: 'var(--chat-text)', fontSize: '12px'}}, hit.snippet),
            ])),
    ]);
  }

  private renderForm(attrs: KnowledgeBaseSectionAttrs, form: RegistrationForm): m.Children {
    const busy = this.busy !== null;
    return m('div', {style: STYLES.divided}, [
      m('div', {style: STYLES.meta}, text(
        `可索引 ${form.preview.documentCount} 个文档、${form.preview.chunkCount} 个分片。`,
        `${form.preview.documentCount} documents and ${form.preview.chunkCount} chunks can be indexed.`,
      )),
      m('label', {style: {...STYLES.meta, display: 'block', marginTop: '8px'}}, [
        text('名称', 'Name'),
        m('input[type=text]', {
          style: STYLES.input, value: form.displayName, disabled: busy, maxlength: 120,
          oninput: (event: InputEvent) => {
            form.displayName = (event.target as HTMLInputElement).value;
          },
        }),
      ]),
      m('label', {style: {...STYLES.meta, display: 'block', marginTop: '8px'}}, [
        text('描述（可选，告诉模型这里有什么）', 'Description (optional; tells the model what is here)'),
        m('input[type=text]', {
          style: STYLES.input, value: form.description, disabled: busy, maxlength: 280,
          oninput: (event: InputEvent) => {
            form.description = (event.target as HTMLInputElement).value;
          },
        }),
      ]),
      m('label', {style: {...STYLES.check, marginTop: '8px', minHeight: '40px', fontSize: '12px'}}, [
        m('input[type=checkbox]', {
          checked: form.rightsAcknowledged, disabled: busy,
          onchange: (event: Event) => {
            form.rightsAcknowledged = (event.target as HTMLInputElement).checked;
          },
        }),
        text('我确认有权在分析中使用这些文档。', 'I confirm I may use these documents in analysis.'),
      ]),
      m('label', {style: {...STYLES.check, minHeight: '40px', fontSize: '12px'}}, [
        m('input[type=checkbox]', {
          checked: form.sendToProvider, disabled: busy,
          onchange: (event: Event) => {
            form.sendToProvider = (event.target as HTMLInputElement).checked;
          },
        }),
        m('span', [
          text('允许把命中的文档片段发送给 AI 服务。', 'Allow matching document passages to be sent to the AI service.'),
          m('div', {style: STYLES.meta}, knowledgeTextDisclosure()),
        ]),
      ]),
      m('div', {style: STYLES.actions}, [
        m('button', {
          type: 'button', style: {...STYLES.button, ...STYLES.primary},
          disabled: attrs.readOnly || busy || !form.rightsAcknowledged,
          onclick: () => this.register(attrs),
        }, this.busy === 'register' ? text('添加中…', 'Adding…') : text('添加并建立索引', 'Add and index')),
        m('button', {
          type: 'button', style: STYLES.button, disabled: busy,
          onclick: () => {
            this.form = null;
          },
        }, text('取消', 'Cancel')),
      ]),
    ]);
  }

  private renderTypedPath(attrs: KnowledgeBaseSectionAttrs): m.Children {
    if (this.manualPath === null) {
      return m('button', {
        type: 'button', style: {...STYLES.button, marginTop: '8px'}, disabled: attrs.readOnly || this.busy !== null,
        onclick: () => {
          this.manualPath = '';
        },
      }, text('改为输入后端路径', 'Enter a backend path instead'));
    }
    return m('div', {style: STYLES.divided}, [
      m('div', {style: STYLES.meta}, text(
        '远程或容器部署无法打开本机文件夹选择器；路径必须位于后端配置的知识库根目录内。',
        'Remote or container deployments cannot open a local folder picker; the path must be under a knowledge root the backend allows.',
      )),
      m('div', {style: {display: 'flex', gap: '6px', marginTop: '6px'}}, [
        m('input[type=text]', {
          style: STYLES.input,
          value: this.manualPath,
          'aria-label': text('后端路径', 'Backend path'),
          disabled: this.busy !== null,
          oninput: (event: InputEvent) => {
            this.manualPath = (event.target as HTMLInputElement).value;
          },
        }),
        m('button', {
          type: 'button', style: STYLES.button, disabled: attrs.readOnly || this.busy !== null || !this.manualPath.trim(),
          onclick: () => this.previewTypedPath(attrs),
        }, text('预览', 'Preview')),
        m('button', {
          type: 'button', style: STYLES.button, disabled: this.busy !== null,
          onclick: () => {
            this.manualPath = null;
          },
        }, text('取消', 'Cancel')),
      ]),
    ]);
  }

  view({attrs}: m.Vnode<KnowledgeBaseSectionAttrs>): m.Children {
    this.syncIdentity(attrs);
    return m('div', {style: {marginTop: '18px'}}, [
      m('div', {style: STYLES.header}, [
        m('h4', {style: STYLES.title}, text('文档知识库', 'Document knowledge bases')),
        this.form ? null : m('button', {
          type: 'button', style: STYLES.button, disabled: attrs.readOnly || this.busy !== null,
          onclick: () => this.chooseFolder(attrs),
        }, this.busy === 'choose' ? text('选择中…', 'Choosing…') : text('选择文件夹添加', 'Add a folder')),
      ]),
      m('div', {style: STYLES.subtitle}, text(
        '模型可在分析中检索这些文档作为背景资料；每轮用哪些，在输入框旁的上下文选择中设置。',
        'The model may search these documents as background; choose which ones a turn uses beside the input box.',
      )),
      this.form ? this.renderForm(attrs, this.form) : this.renderTypedPath(attrs),
      this.error ? m('div', {style: STYLES.error, role: 'alert'}, this.error) : null,
      this.success ? m('div', {style: STYLES.success, role: 'status'}, this.success) : null,
      attrs.sources.length === 0 && !this.form
        ? m('div', {style: {...STYLES.empty, marginTop: '10px'}}, text('还没有文档知识库。', 'No document knowledge bases yet.'))
        : m('div', {style: {...STYLES.list, marginTop: '10px'}}, attrs.sources.map(source => this.renderSource(attrs, source))),
    ]);
  }
}
