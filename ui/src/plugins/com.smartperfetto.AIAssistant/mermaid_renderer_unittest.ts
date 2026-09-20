// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {defer} from '../../base/deferred';
import {encodeBase64Unicode} from './data_formatter';
import {MermaidRenderer} from './mermaid_renderer';

const originalMermaid = (globalThis as {mermaid?: unknown}).mermaid;

afterEach(() => {
  if (originalMermaid === undefined) {
    delete (globalThis as {mermaid?: unknown}).mermaid;
  } else {
    (globalThis as {mermaid?: unknown}).mermaid = originalMermaid;
  }
});

describe('MermaidRenderer', () => {
  function addDiagram(container: HTMLElement, code = 'flowchart LR\nA --> B') {
    const host = document.createElement('div');
    host.className = 'ai-mermaid-diagram';
    host.dataset.mermaidB64 = encodeBase64Unicode(code);
    container.appendChild(host);
    return host;
  }

  function delayedRenderer() {
    const first = defer<{svg: string}>();
    const started = defer<void>();
    const render = vi.fn().mockImplementationOnce(() => {
      started.resolve();
      return first;
    }).mockResolvedValue({svg: '<svg xmlns="http://www.w3.org/2000/svg" />'});
    (globalThis as {mermaid?: unknown}).mermaid = {initialize: vi.fn(), render};
    return {renderer: new MermaidRenderer(), first, started, render};
  }

  it('coalesces streaming replacements and only renders the latest nodes', async () => {
    const {renderer, first, started, render} = delayedRenderer();
    const container = document.createElement('div');
    const oldHost = addDiagram(container);
    const pending = [renderer.renderMermaidInElement(container)];
    await started;
    let latestHost = oldHost;
    for (let i = 0; i < 100; i++) {
      container.replaceChildren();
      latestHost = addDiagram(container, `flowchart LR\nA --> B${i}`);
      pending.push(renderer.renderMermaidInElement(container));
    }
    await Promise.resolve();
    const callsWhileBlocked = render.mock.calls.length;
    first.resolve({svg: '<svg xmlns="http://www.w3.org/2000/svg" />'});
    await Promise.all(pending);

    expect(callsWhileBlocked).toBe(1);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1][1]).toContain('B99');
    expect(oldHost.innerHTML).toBe('');
    expect(latestHost.querySelector('svg')).not.toBeNull();
  });

  it('deduplicates redraws of an in-flight diagram and completes every diagram', async () => {
    const {renderer, first, started, render} = delayedRenderer();
    const container = document.createElement('div');
    const hosts = [addDiagram(container), addDiagram(container)];
    const pending = [renderer.renderMermaidInElement(container)];
    await started;
    for (let i = 0; i < 10; i++) {
      pending.push(renderer.renderMermaidInElement(container));
    }
    first.resolve({svg: '<svg xmlns="http://www.w3.org/2000/svg" />'});
    await Promise.all(pending);

    expect(render).toHaveBeenCalledTimes(2);
    for (const host of hosts) expect(host.querySelector('svg')).not.toBeNull();
  });

  it('discards an obsolete failure and can render new content afterwards', async () => {
    const {renderer, first, started, render} = delayedRenderer();
    const container = document.createElement('div');
    const oldHost = addDiagram(container);
    const pending = renderer.renderMermaidInElement(container);
    await started;
    container.replaceChildren();
    const latestHost = addDiagram(container);
    const latest = renderer.renderMermaidInElement(container);
    first.reject(new Error('Obsolete diagram failed'));
    await Promise.all([pending, latest]);

    expect(oldHost.innerHTML).toBe('');
    expect(latestHost.querySelector('svg')).not.toBeNull();
    container.replaceChildren();
    const nextHost = addDiagram(container);
    await renderer.renderMermaidInElement(container);
    expect(nextHost.querySelector('svg')).not.toBeNull();
    expect(render).toHaveBeenCalledTimes(3);
  });

  it('does not write stale output when the same node source changes', async () => {
    const {renderer, first, started, render} = delayedRenderer();
    const container = document.createElement('div');
    const host = addDiagram(container);
    const pending = renderer.renderMermaidInElement(container);
    await started;
    host.dataset.mermaidB64 = encodeBase64Unicode('flowchart LR\nC --> D');
    const latest = renderer.renderMermaidInElement(container);
    first.resolve({svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>stale</text></svg>'});
    await Promise.all([pending, latest]);

    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1][1]).toContain('C --> D');
    expect(host.textContent).not.toContain('stale');
  });

  it('stops processing a mounted container after it is removed', async () => {
    const {renderer, first, started, render} = delayedRenderer();
    const container = document.createElement('div');
    const hosts = [addDiagram(container), addDiagram(container)];
    document.body.appendChild(container);
    const pending = renderer.renderMermaidInElement(container);
    await started;
    container.remove();
    first.resolve({svg: '<svg xmlns="http://www.w3.org/2000/svg" />'});
    await pending;

    expect(render).toHaveBeenCalledTimes(1);
    for (const host of hosts) expect(host.innerHTML).toBe('');
  });

  it('renders real Mermaid flowcharts with multiline HTML labels', async () => {
    const svgPrototype = SVGElement.prototype as SVGElement & {
      getBBox?: () => DOMRect;
      getComputedTextLength?: () => number;
    };
    const originalGetBBox = svgPrototype.getBBox;
    const originalGetComputedTextLength =
      svgPrototype.getComputedTextLength;
    svgPrototype.getBBox = () =>
      ({x: 0, y: 0, width: 100, height: 40}) as DOMRect;
    svgPrototype.getComputedTextLength = () => 100;
    const mermaidModuleName = ['mer', 'maid'].join('');
    const mermaidModule = (await import(mermaidModuleName)) as {
      default: unknown;
    };
    (globalThis as {mermaid?: unknown}).mermaid = mermaidModule.default;

    const container = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'ai-mermaid-diagram';
    host.dataset.mermaidB64 = encodeBase64Unicode(`graph TD
  A["Cold Start (1339ms)"] --> B["bindApplication 阶段<br/>~569ms"]
  B --> C["⭐ 合成 CPU 负载"]`);
    container.appendChild(host);

    try {
      await new MermaidRenderer().renderMermaidInElement(container);

      expect(host.querySelector('.ai-mermaid-error')).toBeNull();
      expect(host.querySelector('svg')).not.toBeNull();
      expect(host.querySelector('foreignObject br')).not.toBeNull();
      expect(host.textContent).toContain('bindApplication 阶段');
    } finally {
      if (originalGetBBox) {
        svgPrototype.getBBox = originalGetBBox;
      } else {
        delete svgPrototype.getBBox;
      }
      if (originalGetComputedTextLength) {
        svgPrototype.getComputedTextLength = originalGetComputedTextLength;
      } else {
        delete svgPrototype.getComputedTextLength;
      }
    }
  }, 15_000);

  it('renders real sequence diagrams with multiline message labels', async () => {
    const svgPrototype = SVGElement.prototype as SVGElement & {
      getBBox?: () => DOMRect;
      getComputedTextLength?: () => number;
    };
    const originalGetBBox = svgPrototype.getBBox;
    const originalGetComputedTextLength = svgPrototype.getComputedTextLength;
    svgPrototype.getBBox = () =>
      ({x: 0, y: 0, width: 100, height: 40}) as DOMRect;
    svgPrototype.getComputedTextLength = () => 100;
    const mermaidModuleName = ['mer', 'maid'].join('');
    const mermaidModule = (await import(mermaidModuleName)) as {
      default: unknown;
    };
    (globalThis as {mermaid?: unknown}).mermaid = mermaidModule.default;

    const container = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'ai-mermaid-diagram';
    host.dataset.mermaidB64 = encodeBase64Unicode(`sequenceDiagram
  participant MT as App MainThread
  participant RT as App RenderThread
  MT->>MT: Choreographer#doFrame<br/>INPUT → ANIMATION → TRAVERSAL
  MT->>RT: syncAndDrawFrame`);
    container.appendChild(host);

    try {
      await new MermaidRenderer().renderMermaidInElement(container);

      expect(host.querySelector('.ai-mermaid-error')).toBeNull();
      expect(host.querySelector('svg')).not.toBeNull();
      expect(host.textContent).toContain('INPUT');
      expect(host.textContent).toContain('ANIMATION');
    } finally {
      if (originalGetBBox) {
        svgPrototype.getBBox = originalGetBBox;
      } else {
        delete svgPrototype.getBBox;
      }
      if (originalGetComputedTextLength) {
        svgPrototype.getComputedTextLength = originalGetComputedTextLength;
      } else {
        delete svgPrototype.getComputedTextLength;
      }
    }
  }, 15_000);

  it('preserves safe Mermaid theme CSS while removing active SVG content', async () => {
    const initialize = vi.fn();
    const render = vi.fn().mockResolvedValue({
      svg: `
        <svg id="diagram" xmlns="http://www.w3.org/2000/svg">
          <style>
            #diagram .node { fill: #ffffff; color: #0f172a; }
            #diagram .edge { marker-end: url(#arrow); }
            @import url("https://evil.example/theme.css");
          </style>
          <script>alert('xss')</script>
          <a href="javascript:alert('xss')">
            <rect class="node" onclick="alert('xss')" style="fill: #fff" />
          </a>
          <path filter="URL(https://filter.invalid/remote.svg#shadow)" />
        </svg>`,
    });
    (globalThis as {mermaid?: unknown}).mermaid = {initialize, render};

    const container = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'ai-mermaid-diagram';
    host.dataset.mermaidB64 = encodeBase64Unicode('flowchart LR\nA --> B');
    container.appendChild(host);

    await new MermaidRenderer().renderMermaidInElement(container);

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({securityLevel: 'strict'}),
    );
    expect(host.querySelector('style')?.textContent).toContain(
      '#diagram .node { fill: #ffffff; color: #0f172a; }',
    );
    expect(host.querySelector('style')?.textContent).toContain(
      'url(#arrow)',
    );
    expect(host.innerHTML).not.toContain('@import');
    expect(host.innerHTML).not.toContain('evil.example');
    expect(host.innerHTML).not.toContain('filter.invalid');
    expect(host.innerHTML).not.toContain('<script');
    expect(host.innerHTML).not.toContain('onclick');
    expect(host.innerHTML).not.toContain('javascript:');
  });
});
