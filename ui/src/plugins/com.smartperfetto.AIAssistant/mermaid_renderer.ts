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
 * Mermaid diagram rendering for the AI Assistant plugin.
 *
 * This module handles:
 * - Lazy loading of Mermaid.js from local assets (CSP compliant)
 * - Initialization with secure settings
 * - Rendering diagrams from Base64-encoded source
 * - Error handling for rendering failures
 *
 * Usage:
 * 1. Call ensureMermaidInitialized() before rendering
 * 2. Use renderMermaidInElement() on container with .ai-mermaid-diagram elements
 */

import {assetSrc} from '../../base/assets';
import {decodeBase64Unicode} from './data_formatter';

/**
 * Get the global Mermaid instance if loaded.
 */
function getMermaid(): any | undefined {
  return (globalThis as any).mermaid;
}

/**
 * Mermaid renderer class for managing diagram rendering.
 *
 * Implements lazy loading and secure initialization of Mermaid.js,
 * with proper error handling and CSP compliance.
 */
export class MermaidRenderer {
  private mermaidInitialized = false;
  private mermaidLoadPromise: Promise<void> | null = null;

  /**
   * Check if Mermaid is available on the global object.
   */
  getMermaid(): any | undefined {
    return getMermaid();
  }

  /**
   * Load Mermaid script from local assets.
   * Returns a promise that resolves when loaded.
   *
   * The script is loaded from assets/mermaid.min.js which is copied
   * by build.js to comply with CSP (Content Security Policy).
   */
  loadMermaidScript(): Promise<void> {
    if (this.mermaidLoadPromise) return this.mermaidLoadPromise;
    if (this.getMermaid()) return Promise.resolve();

    this.mermaidLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // Load mermaid from local assets (copied by build.js) to comply with CSP.
      script.src = assetSrc('assets/mermaid.min.js');
      script.async = true;
      script.onload = () => {
        console.log('[MermaidRenderer] Mermaid loaded from local assets');
        resolve();
      };
      script.onerror = () => {
        console.error('[MermaidRenderer] Failed to load Mermaid from local assets');
        this.mermaidLoadPromise = null;
        reject(new Error('Failed to load Mermaid'));
      };
      document.head.appendChild(script);
    });

    return this.mermaidLoadPromise;
  }

  /**
   * Ensure Mermaid is loaded and initialized.
   * Call this before rendering any diagrams.
   */
  async ensureMermaidInitialized(): Promise<void> {
    if (this.mermaidInitialized) return;

    // Load mermaid script if not already loaded
    if (!this.getMermaid()) {
      try {
        await this.loadMermaidScript();
      } catch (e) {
        console.warn('[MermaidRenderer] Mermaid not available:', e);
        return;
      }
    }

    const mermaid = this.getMermaid();
    if (!mermaid) {
      console.warn('[MermaidRenderer] Mermaid not available on globalThis after load');
      return;
    }

    // Keep this safe for untrusted markdown: strict sanitization and no autostart.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
    });
    this.mermaidInitialized = true;
    console.log('[MermaidRenderer] Mermaid initialized with strict security');
  }

  /**
   * Render Mermaid diagrams within a container element.
   *
   * Looks for elements with:
   * - .ai-mermaid-diagram[data-mermaid-b64] - Diagram containers
   * - .ai-mermaid-source[data-mermaid-b64] - Source code display
   *
   * The Base64-encoded Mermaid source is decoded and rendered as SVG.
   *
   * @param container - The HTML element containing diagrams to render
   */
  async renderMermaidInElement(container: HTMLElement): Promise<void> {
    const diagramNodes = Array.from(
      container.querySelectorAll<HTMLElement>('.ai-mermaid-diagram[data-mermaid-b64]')
    );
    const sourceNodes = Array.from(
      container.querySelectorAll<HTMLElement>('.ai-mermaid-source[data-mermaid-b64]')
    );

    if (diagramNodes.length === 0 && sourceNodes.length === 0) return;

    await this.ensureMermaidInitialized();
    const mermaid = this.getMermaid();
    if (!mermaid) return;

    // Populate sources first (textContent, no HTML interpretation).
    for (const source of sourceNodes) {
      if (source.dataset.rendered === 'true') continue;
      const b64 = source.dataset.mermaidB64;
      if (!b64) continue;
      try {
        source.textContent = decodeBase64Unicode(b64);
        source.dataset.rendered = 'true';
      } catch (e) {
        console.warn('[MermaidRenderer] Failed to decode mermaid source:', e);
      }
    }

    // Render diagrams.
    for (const host of diagramNodes) {
      if (host.dataset.rendered === 'true') continue;
      const b64 = host.dataset.mermaidB64;
      if (!b64) continue;

      let code = '';
      try {
        code = decodeBase64Unicode(b64);
      } catch (e) {
        console.warn('[MermaidRenderer] Failed to decode mermaid diagram:', e);
        continue;
      }

      const renderId = `ai-mermaid-${Math.random().toString(36).slice(2)}`;
      host.classList.add('mermaid');
      host.textContent = '';

      try {
        // mermaid.render returns {svg, bindFunctions} in modern versions.
        const result: any = await mermaid.render(renderId, code);
        host.innerHTML = result?.svg || '';
        if (typeof result?.bindFunctions === 'function') {
          result.bindFunctions(host);
        }
        host.dataset.rendered = 'true';
      } catch (e) {
        console.warn('[MermaidRenderer] Mermaid render failed:', e);
        host.innerHTML =
          '<div class="ai-mermaid-error">Mermaid 渲染失败（请展开查看源码）</div>';
        host.dataset.rendered = 'true';
      }
    }
  }

  /**
   * Reset the renderer state (for testing or re-initialization).
   */
  reset(): void {
    this.mermaidInitialized = false;
    this.mermaidLoadPromise = null;
  }
}

/**
 * Default singleton instance for convenient access.
 */
export const mermaidRenderer = new MermaidRenderer();
