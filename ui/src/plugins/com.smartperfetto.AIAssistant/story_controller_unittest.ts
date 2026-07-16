// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {buildSceneProgressContent} from './story_controller';

describe('StoryController progress localization', () => {
  it('prefers the backend-localized message in Chinese', () => {
    const content = buildSceneProgressContent({
      eventType: 'progress',
      data: {phase: 'detecting', message: '正在读取场景证据'},
      language: 'zh-CN',
    });

    expect(content).toContain('场景还原中');
    expect(content).toContain('正在读取场景证据');
    expect(content).not.toContain('detecting');
  });

  it('prefers the backend-localized message in English', () => {
    const content = buildSceneProgressContent({
      eventType: 'phase_start',
      data: {phase: 'summarizing', message: 'Building the scene narrative'},
      language: 'en-US',
    });

    expect(content).toContain('Reconstructing scenes');
    expect(content).toContain('Building the scene narrative');
    expect(content).not.toContain('summarizing');
  });

  it('localizes a phase fallback instead of displaying its internal code', () => {
    expect(buildSceneProgressContent({
      eventType: 'progress',
      data: {phase: 'detecting'},
      language: 'en',
    })).toContain('Detecting scenes');
    expect(buildSceneProgressContent({
      eventType: 'phase_start',
      data: {phase: 'summarizing'},
      language: 'zh-CN',
    })).toContain('正在生成场景摘要');
  });
});
