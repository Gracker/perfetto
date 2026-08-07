// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

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
