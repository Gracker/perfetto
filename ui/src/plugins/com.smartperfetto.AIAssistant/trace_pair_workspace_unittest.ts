// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {TracePairWorkspace} from './trace_pair_workspace';
import {TracePairWorkspaceController} from './trace_pair_workspace_state';

describe('TracePairWorkspace', () => {
  let root: HTMLDivElement;
  let controller: TracePairWorkspaceController;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
    controller = new TracePairWorkspaceController();
    controller.open({
      scope: {
        key: 'tenant/user/workspace/current',
        backendUrl: 'http://127.0.0.1:3000',
      },
      currentTrace: {
        id: 'current',
        filename: 'current.pftrace',
        size: 11 * 1024 * 1024,
      },
    });
    controller.setCatalog([
      {
        id: 'history-a',
        filename: 'launch_light.pftrace',
        uploadedAt: '2026-07-10T01:30:00.000Z',
        size: 11 * 1024 * 1024,
      },
      {
        id: 'history-b',
        filename: 'launch_light.pftrace',
        uploadedAt: '2026-07-10T02:30:00.000Z',
      },
      {
        id: 'history-unique',
        filename: 'launch_heavy.pftrace',
        uploadedAt: '2026-07-10T03:30:00.000Z',
        size: 19 * 1024 * 1024,
      },
    ]);
  });

  afterEach(() => {
    m.mount(root, null);
    root.remove();
  });

  it('exposes the splitter to keyboard users', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});
    m.mount(root, {view: () => m(TracePairWorkspace, {controller})});
    const splitter = root.querySelector<HTMLElement>('[role="separator"]');

    expect(splitter?.tabIndex).toBe(0);
    expect(splitter?.getAttribute('aria-orientation')).toBe('vertical');
    splitter?.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));

    expect(controller.getState().splitPercent).toBe(52);
  });

  it('renders upload controls for empty panes and replacement controls for selected traces', () => {
    const empty = new TracePairWorkspaceController();
    empty.open({
      scope: {
        key: 'tenant/user/workspace/zero-start',
        backendUrl: 'http://127.0.0.1:3000',
      },
    });
    empty.setUploadHandler(async (_pane, file) => ({
      id: file.name,
      filename: file.name,
      size: file.size,
    }));
    m.mount(root, {view: () => m(TracePairWorkspace, {controller: empty})});

    expect(
      root.querySelectorAll('input[data-trace-pair-upload]'),
    ).toHaveLength(2);
    expect(root.textContent).toContain('Upload trace');
    expect(
      root.querySelector('section[data-pane-slot="first"]')?.textContent,
    ).toContain('Select a baseline trace above');
    expect(
      root.querySelector('section[data-pane-slot="second"]')?.textContent,
    ).toContain('Select a comparison trace above');

    empty.setCatalog([{id: 'baseline', filename: 'baseline.pftrace'}]);
    empty.selectTrace({pane: 'first', traceId: 'baseline'});
    m.redraw.sync();
    expect(
      root.querySelector('section[data-pane-slot="first"]')?.textContent,
    ).toContain('Replace file');
  });

  it('shows a replacement upload error inside the populated pane', async () => {
    controller.setUploadHandler(async () => {
      throw new Error('replacement failed');
    });
    m.mount(root, {view: () => m(TracePairWorkspace, {controller})});

    await controller.uploadTrace(
      'first',
      new File(['replacement'], 'replacement.pftrace'),
    );
    m.redraw.sync();

    expect(
      root.querySelector('section[data-pane-slot="first"]')?.textContent,
    ).toContain('replacement failed');
  });

  it('keeps both iframe nodes alive across layout-only changes', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});
    m.mount(root, {view: () => m(TracePairWorkspace, {controller})});

    const currentFrame = root.querySelector<HTMLIFrameElement>(
      'iframe[data-trace-side="current"]',
    );
    const referenceFrame = root.querySelector<HTMLIFrameElement>(
      'iframe[data-trace-side="reference"]',
    );
    expect(currentFrame).not.toBeNull();
    expect(referenceFrame).not.toBeNull();
    const currentSrc = currentFrame?.src;
    const referenceSrc = referenceFrame?.src;
    expect(currentSrc).toContain('smartperfettoTraceId=current');
    expect(referenceSrc).toContain('smartperfettoTraceId=history-a');
    expect(currentSrc).toContain('#!/viewer?');
    expect(referenceSrc).toContain('#!/viewer?');
    expect(currentSrc).not.toContain('url=');
    expect(referenceSrc).not.toContain('url=');

    const assertFramesUnchanged = () => {
      m.redraw.sync();
      expect(root.querySelectorAll('iframe')).toHaveLength(2);
      expect(root.querySelector('iframe[data-trace-side="current"]')).toBe(
        currentFrame,
      );
      expect(root.querySelector('iframe[data-trace-side="reference"]')).toBe(
        referenceFrame,
      );
      expect(currentFrame?.src).toBe(currentSrc);
      expect(referenceFrame?.src).toBe(referenceSrc);
    };

    controller.toggleMaximized('current');
    assertFramesUnchanged();
    controller.toggleMaximized('current');
    assertFramesUnchanged();
    controller.toggleMinimized('reference');
    assertFramesUnchanged();
    controller.toggleMinimized('reference');
    assertFramesUnchanged();
    controller.setLayout('vertical');
    assertFramesUnchanged();

    controller.close();
    m.redraw.sync();
    expect(root.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('observes each iframe so pane geometry changes trigger a redraw', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const observed = new Set<Element>();
    class TestResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        observed.add(target);
      }
      unobserve(target: Element): void {
        observed.delete(target);
      }
      disconnect(): void {
        observed.clear();
      }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    });

    try {
      controller.selectTrace({pane: 'second', traceId: 'history-a'});
      m.mount(root, {view: () => m(TracePairWorkspace, {controller})});
      const frames = Array.from(root.querySelectorAll('iframe'));

      expect(frames).toHaveLength(2);
      expect(frames.every((frame) => observed.has(frame))).toBe(true);
    } finally {
      m.mount(root, null);
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: originalResizeObserver,
      });
    }
  });

  it('uses filenames as selector labels while retaining distinct ids', () => {
    m.mount(root, {view: () => m(TracePairWorkspace, {controller})});

    const firstOption = root.querySelector<HTMLOptionElement>(
      'option[value="history-a"]',
    );
    const secondOption = root.querySelector<HTMLOptionElement>(
      'option[value="history-b"]',
    );

    expect(firstOption?.textContent).toMatch(/^launch_light\.pftrace/);
    expect(secondOption?.textContent).toMatch(/^launch_light\.pftrace/);
    expect(firstOption?.textContent).not.toContain('history-a');
    expect(secondOption?.textContent).not.toContain('history-b');
    expect(firstOption?.textContent).not.toBe(secondOption?.textContent);
    expect(firstOption?.value).toBe('history-a');
    expect(secondOption?.value).toBe('history-b');
    expect(
      root.querySelector<HTMLOptionElement>(
        'option[value="history-unique"]',
      )?.textContent,
    ).toBe('launch_heavy.pftrace');
  });

  it('renders arbitrary historical baseline/comparison choices and swaps them', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});
    controller.selectTrace({pane: 'first', traceId: 'history-unique'});
    m.mount(root, {view: () => m(TracePairWorkspace, {controller})});

    expect(
      root.querySelector('section[data-pane-slot="first"]')?.textContent,
    ).toContain('Baseline');
    expect(
      root.querySelector('section[data-pane-slot="second"]')?.textContent,
    ).toContain('Comparison');
    expect(
      root.querySelector<HTMLSelectElement>(
        'section[data-pane-slot="first"] select',
      )?.value,
    ).toBe('history-unique');
    expect(
      root.querySelector<HTMLSelectElement>(
        'section[data-pane-slot="second"] select',
      )?.value,
    ).toBe('history-a');

    root
      .querySelector<HTMLButtonElement>('button[data-trace-pair-swap]')
      ?.click();
    m.redraw.sync();

    expect(controller.getState()).toMatchObject({
      currentTrace: {id: 'history-a'},
      referenceTrace: {id: 'history-unique'},
    });
  });

  it('makes running identity controls visibly and behaviorally immutable', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});
    controller.setSelectionLocked(true);
    m.mount(root, {view: () => m(TracePairWorkspace, {controller})});

    const selectors = Array.from(
      root.querySelectorAll<HTMLSelectElement>('select.ai-trace-pair-selector'),
    );
    expect(selectors).toHaveLength(2);
    expect(selectors.every((selector) => selector.disabled)).toBe(true);
    expect(
      selectors.every(
        (selector) =>
          selector.title ===
          'Trace selection is locked while analysis is running',
      ),
    ).toBe(true);

    const exitButton = root.querySelector<HTMLButtonElement>(
      'button[data-trace-pair-exit]',
    );
    expect(exitButton?.disabled).toBe(true);
    expect(exitButton?.title).toBe(
      'Stop the analysis before exiting the dual-trace workspace',
    );
    expect(exitButton?.textContent).toContain('Exit');

    controller.close();
    m.redraw.sync();
    expect(controller.getState().open).toBe(true);
    expect(root.querySelector('.ai-trace-pair-workspace')).not.toBeNull();
  });
});
