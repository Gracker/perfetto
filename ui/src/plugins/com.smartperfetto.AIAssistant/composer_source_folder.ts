// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Adding a source folder from a composer: the system folder dialog, registration
 * and the disclosure review, for whichever composer hosts it. The dialog can stay
 * open for minutes, so its result only applies to the conversation that asked and
 * only while that conversation can still change its context.
 */

import m from 'mithril';

import {getSmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
import {analysisCatalog, catalogIdentityKey, type CatalogIdentity} from './analysis_catalog';
import {normalizeAnalysisContext} from './analysis_context';
import {
  getCodebaseDirectoryPickerCapability,
  registerCodebase,
  selectDirectory,
  type CodebaseSummary,
} from './codebase_api';
import {analysisContextAfterCodebaseRegistration} from './codebase_panel';
import {ContentDisclosureReview} from './content_disclosure_review';
import {errorMessage} from './management_ui';
import {detectSourcePathSuggestion} from './source_path_suggestion';
import type {AnalysisContextSelection} from './types';
import {uiText as text} from './ui_language';

export interface ComposerSourceFolderHost {
  identity(): CatalogIdentity;
  /** The conversation a result belongs to; null before one exists. */
  conversationKey(): string | null;
  locked(): boolean;
  selection(): AnalysisContextSelection;
  apply(selection: AnalysisContextSelection): void;
}

export class ComposerSourceFolder {
  private capabilityKey: string | undefined;
  private pickerAvailable = false;
  private adding = false;
  private errorText: string | null = null;
  private pendingGrant: {codebase: CodebaseSummary; conversationKey: string | null} | null = null;
  private readonly dismissed = new Set<string>();

  constructor(private readonly host: ComposerSourceFolderHost) {}

  private get available(): boolean {
    this.ensureCapability();
    return this.pickerAvailable;
  }

  /** The folder action of the context control; whether this backend can offer it is asked when the popover opens. */
  contextControlAttrs(): {onOpen: () => void; onAddFolder?: () => void; addingFolder?: boolean} {
    return {
      onOpen: () => this.ensureCapability(),
      ...(this.pickerAvailable ? {onAddFolder: () => void this.add(), addingFolder: this.adding} : {}),
    };
  }

  private ensureCapability(): void {
    const identity = this.host.identity();
    const key = catalogIdentityKey(identity);
    if (this.capabilityKey === key) return;
    this.capabilityKey = key;
    this.pickerAvailable = false;
    void getCodebaseDirectoryPickerCapability(identity.backendUrl, identity.apiKey)
      .then((capability) => {
        if (this.capabilityKey !== key) return;
        this.pickerAvailable = capability.available;
        m.redraw();
      })
      .catch(() => undefined);
  }

  async add(defaultPath?: string): Promise<void> {
    if (this.adding || this.host.locked()) return;
    const identity = this.host.identity();
    const conversationKey = this.host.conversationKey();
    const isCurrent = (): boolean => conversationKey === this.host.conversationKey() &&
      !this.host.locked() && this.host.identity().scopeKey === identity.scopeKey;
    this.adding = true;
    this.errorText = null;
    m.redraw();
    try {
      const picked = await selectDirectory(
        identity.backendUrl, 'codebase', identity.apiKey, getSmartPerfettoRequestContext(), defaultPath,
      );
      if (!picked.selected) return;
      const {codebase} = await registerCodebase(identity.backendUrl, {
        kind: 'app_source',
        displayName: picked.displayNameSuggestion,
        rootPath: picked.rootPath,
        directorySelectionId: picked.directorySelectionId,
        sendToProvider: false,
        reuseExisting: true,
      }, identity.apiKey);
      await analysisCatalog.refresh(identity);
      if (!isCurrent()) return;
      if (defaultPath) this.dismissed.add(defaultPath);
      const selection = normalizeAnalysisContext(this.host.selection());
      if (selection.codeAwareMode === 'metadata_only' || codebase.eligibleForSendToProvider === true) {
        this.use(codebase);
      } else {
        this.pendingGrant = {codebase, conversationKey};
      }
    } catch (error) {
      this.errorText = errorMessage(error, text('无法添加源码文件夹', 'Unable to add the source folder'));
    } finally {
      this.adding = false;
      m.redraw();
    }
  }

  private use(codebase: CodebaseSummary): void {
    this.host.apply(analysisContextAfterCodebaseRegistration(
      normalizeAnalysisContext(this.host.selection()),
      codebase,
      analysisCatalog.read(this.host.identity()).codebases,
    ));
  }

  private settleGrant(updated: CodebaseSummary | undefined): void {
    const pending = this.pendingGrant;
    this.pendingGrant = null;
    if (!pending || !updated || pending.conversationKey !== this.host.conversationKey() || this.host.locked()) return;
    this.use(updated);
  }

  private renderSuggestion(input: string): m.Children {
    const suggestion = detectSourcePathSuggestion(input);
    if (!suggestion || this.dismissed.has(suggestion) || this.host.locked()) return null;
    const identity = this.host.identity();
    analysisCatalog.ensure(identity);
    if (!this.available || !analysisCatalog.read(identity).featureEnabled) return null;
    return m('div.ai-source-path-card', [
      m('span', text('用作本对话的源码：', 'Use as source for this chat:')),
      m('code', {title: suggestion}, suggestion),
      m('button', {
        type: 'button',
        disabled: this.adding,
        onclick: () => void this.add(suggestion),
      }, this.adding ? text('等待选择…', 'Waiting…') : text('在系统窗口中确认', 'Confirm in system dialog')),
      m('button', {
        type: 'button',
        'aria-label': text('忽略', 'Dismiss'),
        onclick: () => this.dismissed.add(suggestion),
      }, '×'),
    ]);
  }

  /** What sits above the composer: the path card, a failure, and the disclosure review when one is due. */
  render(input: string): m.Children {
    const identity = this.host.identity();
    return [
      this.renderSuggestion(input),
      this.errorText ? m('div.ai-context-control-error', {role: 'alert'}, this.errorText) : null,
      this.pendingGrant
        ? m('div.ai-modal-backdrop', {role: 'dialog', 'aria-modal': 'true'},
            m('div.ai-modal-card', m(ContentDisclosureReview, {
              backendUrl: identity.backendUrl,
              apiKey: identity.apiKey,
              readOnly: false,
              codebase: this.pendingGrant.codebase,
              onGranted: (updated: CodebaseSummary) => this.settleGrant(updated),
              onCancel: () => this.settleGrant(undefined),
            })))
        : null,
    ];
  }
}
