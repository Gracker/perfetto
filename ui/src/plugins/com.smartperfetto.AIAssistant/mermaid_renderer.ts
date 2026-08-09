// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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
import {uiText} from './ui_language';

const MERMAID_SVG_ELEMENTS = new Set([
  'a',
  'br',
  'circle',
  'clippath',
  'code',
  'defs',
  'desc',
  'div',
  'ellipse',
  'em',
  'fedropshadow',
  'fegaussianblur',
  'femerge',
  'femergenode',
  'feoffset',
  'filter',
  'foreignobject',
  'g',
  'image',
  'line',
  'lineargradient',
  'marker',
  'mask',
  'p',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialgradient',
  'rect',
  'span',
  'stop',
  'strong',
  'style',
  'svg',
  'switch',
  'text',
  'title',
  'tspan',
  'use',
]);

const MERMAID_SVG_ATTRIBUTES = new Set([
  'alignment-baseline',
  'class',
  'clip-path',
  'color',
  'cx',
  'cy',
  'd',
  'dominant-baseline',
  'dx',
  'dy',
  'fill',
  'fill-opacity',
  'filter',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'height',
  'href',
  'id',
  'lengthadjust',
  'marker-end',
  'marker-height',
  'marker-mid',
  'marker-start',
  'marker-units',
  'marker-width',
  'mask',
  'offset',
  'opacity',
  'orient',
  'patternunits',
  'points',
  'pointer-events',
  'preserveaspectratio',
  'r',
  'refx',
  'refy',
  'requiredfeatures',
  'role',
  'rx',
  'ry',
  'stddeviation',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'stroke-width',
  'style',
  'tabindex',
  'text-anchor',
  'textlength',
  'transform',
  'vector-effect',
  'viewbox',
  'width',
  'x',
  'x1',
  'x2',
  'xlink:href',
  'xmlns',
  'xmlns:xlink',
  'y',
  'y1',
  'y2',
]);

const MERMAID_FRAGMENT_ATTRIBUTES = new Set(['href', 'xlink:href']);

function isSafeFragmentReference(value: string): boolean {
  const unquoted = value.trim().replace(/^(['"])(.*)\1$/, '$2');
  return /^#[A-Za-z0-9_.:-]+$/.test(unquoted);
}

function sanitizeMermaidCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[\s\S]*?(?:;|$)/gi, '')
    .replace(
      /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi,
      (_match, _quote, value: string) =>
        isSafeFragmentReference(value) ? `url(${value.trim()})` : 'none',
    )
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/(?:javascript|vbscript|data)\s*:/gi, '')
    .replace(/(?:-moz-binding|behavior)\s*:[^;}]+[;}]?/gi, '');
}

/**
 * Preserve Mermaid's generated theme CSS without trusting arbitrary SVG HTML.
 * Mermaid strict mode remains the primary guard; this parsed allowlist is the
 * defense-in-depth boundary for renderer output.
 */
function sanitizeMermaidSvg(svg: string): string {
  // Mermaid uses XHTML inside <foreignObject> and serializes HTML void
  // elements such as <br> without XML self-closing syntax. Parse through the
  // browser's HTML/SVG integration rules, then enforce a single SVG root.
  const parsed = new DOMParser().parseFromString(svg, 'text/html');
  const root = parsed.body.firstElementChild;
  if (
    parsed.body.children.length !== 1 ||
    root?.localName.toLowerCase() !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  ) {
    return '';
  }

  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const element of elements) {
    const elementName = element.localName.toLowerCase();
    if (!MERMAID_SVG_ELEMENTS.has(elementName)) {
      element.remove();
      continue;
    }

    if (elementName === 'style') {
      const safeCss = sanitizeMermaidCss(element.textContent ?? '');
      if (!safeCss.trim()) {
        element.remove();
        continue;
      }
      element.textContent = safeCss;
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const isMetadataAttribute =
        attributeName.startsWith('aria-') ||
        attributeName.startsWith('data-');
      if (
        attributeName.startsWith('on') ||
        (!isMetadataAttribute &&
          !MERMAID_SVG_ATTRIBUTES.has(attributeName))
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (
        MERMAID_FRAGMENT_ATTRIBUTES.has(attributeName) &&
        !isSafeFragmentReference(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (attributeName === 'style' || /url\s*\(/i.test(attribute.value)) {
        const safeCss = sanitizeMermaidCss(attribute.value);
        if (!safeCss.trim()) {
          element.removeAttribute(attribute.name);
        } else {
          element.setAttribute(attribute.name, safeCss);
        }
      }
    }
  }

  return root.outerHTML;
}

/**
 * Get the global Mermaid instance if loaded.
 */
function getMermaid(): any | undefined {
  return (globalThis as any).mermaid;
}

function normalizeMermaidSource(code: string): string {
  const normalizedBreaks = code.replace(/<br\s*\/?>/gi, '<br/>');
  if (!/^\s*sequenceDiagram\b/m.test(normalizedBreaks)) {
    return normalizedBreaks;
  }

  return normalizedBreaks
    .split('\n')
    .map((line) => {
      const colonIndex = line.indexOf(':');
      if (colonIndex < 0) return line;
      const prefix = line.slice(0, colonIndex);
      if (!/(?:--?>>?|--?x|--?\)|<<--?>>?)/.test(prefix)) return line;
      return `${prefix}:${line.slice(colonIndex + 1).replace(/#/g, '#35;')}`;
    })
    .join('\n');
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
   * by build.mjs to comply with CSP (Content Security Policy).
   */
  loadMermaidScript(): Promise<void> {
    if (this.mermaidLoadPromise) return this.mermaidLoadPromise;
    if (this.getMermaid()) return Promise.resolve();

    this.mermaidLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // Load mermaid from local assets (copied by build.mjs) to comply with CSP.
      script.src = assetSrc('assets/mermaid.min.js');
      script.async = true;
      script.onload = () => {
        console.log('[MermaidRenderer] Mermaid loaded from local assets');
        resolve();
      };
      script.onerror = () => {
        console.error(
          '[MermaidRenderer] Failed to load Mermaid from local assets',
        );
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
      console.warn(
        '[MermaidRenderer] Mermaid not available on globalThis after load',
      );
      return;
    }

    // Detect dark mode to select appropriate Mermaid theme
    const isDarkMode =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
    const theme = isDarkMode ? 'dark' : 'default';

    // Keep this safe for untrusted markdown: strict sanitization and no autostart.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
    });
    this.mermaidInitialized = true;
    console.log(
      `[MermaidRenderer] Mermaid initialized (theme: ${theme}, strict security)`,
    );
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
      container.querySelectorAll<HTMLElement>(
        '.ai-mermaid-diagram[data-mermaid-b64]',
      ),
    );
    const sourceNodes = Array.from(
      container.querySelectorAll<HTMLElement>(
        '.ai-mermaid-source[data-mermaid-b64]',
      ),
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

      // Normalize the only inline HTML tag we intentionally support and escape
      // sequence-message hashes without touching flowchart color literals.
      code = normalizeMermaidSource(code);

      const renderId = `ai-mermaid-${Math.random().toString(36).slice(2)}`;
      host.classList.add('mermaid');
      host.textContent = '';

      try {
        // mermaid.render returns {svg, bindFunctions} in modern versions.
        // SECURITY: securityLevel:'strict' is the primary guard against SVG XSS.
        // The parsed SVG allowlist is a defense-in-depth backstop that preserves
        // Mermaid's generated theme CSS while rejecting active content.
        const result: any = await mermaid.render(renderId, code);
        const safeSvg = sanitizeMermaidSvg(result?.svg || '');
        if (!safeSvg) throw new Error('Mermaid returned invalid SVG');
        host.innerHTML = safeSvg;
        if (typeof result?.bindFunctions === 'function') {
          result.bindFunctions(host);
        }
        host.dataset.rendered = 'true';
      } catch (e) {
        console.warn('[MermaidRenderer] Mermaid render failed:', e);
        host.innerHTML = `<div class="ai-mermaid-error">${uiText(
          'Mermaid 渲染失败（请展开查看源码）',
          'Mermaid rendering failed (expand to view the source)',
        )}</div>`;
        host.dataset.rendered = 'true';
      }
    }
  }

  /**
   * Reset the renderer state (for testing or re-initialization).
   * Call this when the color scheme changes to re-initialize with the new theme.
   */
  reset(): void {
    this.mermaidInitialized = false;
    this.mermaidLoadPromise = null;
  }

  /**
   * Re-initialize Mermaid with the current theme (call on dark mode toggle).
   * Does not reload the script, only re-runs mermaid.initialize().
   */
  async reinitializeTheme(): Promise<void> {
    const mermaid = this.getMermaid();
    if (!mermaid) return;
    this.mermaidInitialized = false;
    await this.ensureMermaidInitialized();
  }
}

/**
 * Default singleton instance for convenient access.
 */
export const mermaidRenderer = new MermaidRenderer();
