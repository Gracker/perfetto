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

import m from 'mithril';
import {uiText} from './ui_language';
import type {Trace} from '../../public/trace';
import {Time} from '../../base/time';

/**
 * 导航书签 - 表示trace中的关键时间点
 */
export interface NavigationBookmark {
  id: string;
  timestamp: number;
  label: string;
  type: 'jank' | 'anr' | 'slow_function' | 'binder_slow' | 'custom';
  description?: string;
  context?: {
    threadName?: string;
    processName?: string;
    sliceName?: string;
  };
}

export interface NavigationBookmarkBarAttrs {
  bookmarks: NavigationBookmark[];
  trace: Trace;
  onBookmarkClick?: (bookmark: NavigationBookmark, index: number) => void;
}

// 主题颜色
const COLORS = {
  primary: '#6366f1',
  primaryHover: '#4f46e5',
  primaryLight: 'rgba(99, 102, 241, 0.1)',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
  jank: '#f59e0b', // 橙色 - 掉帧
  anr: '#ef4444', // 红色 - ANR
  slow: '#f59e0b', // 橙色 - 慢函数
  custom: '#6366f1', // 蓝色 - 自定义
};

// 样式
const STYLES = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    background: 'var(--chat-bg-secondary)',
    borderBottom: '1px solid var(--chat-border)',
    overflowX: 'auto' as const,
  },
  navControls: {
    display: 'flex',
    gap: '4px',
    flexShrink: 0,
  },
  navBtn: {
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: '500',
    color: 'var(--chat-text)',
    background: 'var(--chat-bg)',
    border: '1px solid var(--chat-border)',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  navBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  bookmarkList: {
    display: 'flex',
    gap: '6px',
    flex: 1,
    overflowX: 'auto' as const,
  },
  bookmark: {
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: '500',
    background: 'var(--chat-bg)',
    border: '1px solid var(--chat-border)',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  bookmarkActive: {
    background: COLORS.primary,
    borderColor: COLORS.primary,
    color: 'white',
  },
  bookmarkIcon: {
    fontSize: '14px',
  },
  summary: {
    fontSize: '11px',
    color: 'var(--chat-text-secondary)',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
};

/**
 * 导航书签栏组件
 * 显示AI识别出的关键时间点，支持快速跳转和前后切换
 */
export class NavigationBookmarkBar
  implements m.ClassComponent<NavigationBookmarkBarAttrs>
{
  private currentIndex: number = 0;

  view(vnode: m.Vnode<NavigationBookmarkBarAttrs>): m.Children {
    const {bookmarks, trace, onBookmarkClick} = vnode.attrs;

    // 如果没有书签，不显示
    if (bookmarks.length === 0) {
      return null;
    }

    // Clamp stale index if bookmarks list shrank (e.g. after clear + re-analyze).
    if (this.currentIndex >= bookmarks.length) {
      this.currentIndex = Math.max(0, bookmarks.length - 1);
    }

    return m('div', {style: STYLES.container}, [
      // 导航控制按钮
      m('div', {style: STYLES.navControls}, [
        m(
          'button',
          {
            style: {
              ...STYLES.navBtn,
              ...(this.currentIndex === 0 ? STYLES.navBtnDisabled : {}),
            },
            disabled: this.currentIndex === 0,
            onclick: () =>
              this.jumpToPrevious(bookmarks, trace, onBookmarkClick),
            title: uiText('上一个关键点', 'Previous key point'),
          },
          [m('span', '←'), m('span', uiText('上一个', 'Previous'))],
        ),

        m(
          'button',
          {
            style: {
              ...STYLES.navBtn,
              ...(this.currentIndex === bookmarks.length - 1
                ? STYLES.navBtnDisabled
                : {}),
            },
            disabled: this.currentIndex === bookmarks.length - 1,
            onclick: () => this.jumpToNext(bookmarks, trace, onBookmarkClick),
            title: uiText('下一个关键点', 'Next key point'),
          },
          [m('span', uiText('下一个', 'Next')), m('span', '→')],
        ),
      ]),

      // 书签列表
      m(
        'div',
        {style: STYLES.bookmarkList},
        bookmarks.map((bookmark, index) =>
          m(
            'button',
            {
              key: bookmark.id,
              style: {
                ...STYLES.bookmark,
                ...(index === this.currentIndex ? STYLES.bookmarkActive : {}),
                borderColor: this.getBookmarkColor(bookmark.type),
              },
              onclick: () =>
                this.jumpTo(index, bookmarks, trace, onBookmarkClick),
              title: bookmark.description || bookmark.label,
            },
            [
              m(
                'span',
                {style: STYLES.bookmarkIcon},
                this.getBookmarkIcon(bookmark.type),
              ),
              m('span', bookmark.label),
            ],
          ),
        ),
      ),

      // 统计信息
      m(
        'div',
        {style: STYLES.summary},
        uiText(
          `${bookmarks.length} 个关键点`,
          `${bookmarks.length} key points`,
        ),
      ),
    ]);
  }

  /**
   * 跳转到指定书签
   */
  private jumpTo(
    index: number,
    bookmarks: NavigationBookmark[],
    trace: Trace,
    onBookmarkClick?: (bookmark: NavigationBookmark, index: number) => void,
  ): void {
    if (index < 0 || index >= bookmarks.length) {
      return;
    }

    this.currentIndex = index;
    const bookmark = bookmarks[index];

    // 使用 Perfetto API 跳转
    trace.scrollTo({
      time: {
        start: Time.fromRaw(BigInt(bookmark.timestamp)),
        end: Time.fromRaw(BigInt(bookmark.timestamp + 1000000)), // +1ms
        behavior: 'focus',
      },
    });

    // 触发回调
    if (onBookmarkClick) {
      onBookmarkClick(bookmark, index);
    }

    m.redraw();
  }

  /**
   * 跳转到上一个书签
   */
  private jumpToPrevious(
    bookmarks: NavigationBookmark[],
    trace: Trace,
    onBookmarkClick?: (bookmark: NavigationBookmark, index: number) => void,
  ): void {
    if (this.currentIndex > 0) {
      this.jumpTo(this.currentIndex - 1, bookmarks, trace, onBookmarkClick);
    }
  }

  /**
   * 跳转到下一个书签
   */
  private jumpToNext(
    bookmarks: NavigationBookmark[],
    trace: Trace,
    onBookmarkClick?: (bookmark: NavigationBookmark, index: number) => void,
  ): void {
    if (this.currentIndex < bookmarks.length - 1) {
      this.jumpTo(this.currentIndex + 1, bookmarks, trace, onBookmarkClick);
    }
  }

  /**
   * 获取书签类型对应的图标
   */
  private getBookmarkIcon(type: NavigationBookmark['type']): string {
    const icons = {
      jank: '🎯', // 掉帧
      anr: '⚠️', // ANR
      slow_function: '🐌', // 慢函数
      binder_slow: '🔗', // Binder慢
      custom: '📍', // 自定义
    };
    return icons[type] || '📍';
  }

  /**
   * 获取书签类型对应的颜色
   */
  private getBookmarkColor(type: NavigationBookmark['type']): string {
    const colors = {
      jank: COLORS.jank,
      anr: COLORS.error,
      slow_function: COLORS.warning,
      binder_slow: COLORS.warning,
      custom: COLORS.custom,
    };
    return colors[type] || COLORS.custom;
  }

  /**
   * 重置当前索引（当书签列表变化时调用）
   */
  public resetIndex(): void {
    this.currentIndex = 0;
  }
}
