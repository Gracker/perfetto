import {expect, test} from '@playwright/test';

import {
  getActivityHintFromBufferTxTrackName,
  getMaxPinsForPattern,
  needsActiveDisambiguation,
} from '../plugins/com.smartperfetto.AIAssistant/auto_pin_utils';

test('getActivityHintFromBufferTxTrackName extracts activity short name', () => {
  expect(
    getActivityHintFromBufferTxTrackName(
      'BufferTX - com.example.wechatfriendforperformance/com.example.wechatfriendforperformance.MinimalLoadActivity#5960',
    ),
  ).toBe('MinimalLoadActivity');

  expect(
    getActivityHintFromBufferTxTrackName(
      'BufferTX - com.example.app/.MainActivity#1',
    ),
  ).toBe('MainActivity');

  expect(getActivityHintFromBufferTxTrackName('BufferTX')).toBeNull();
  expect(getActivityHintFromBufferTxTrackName('BufferTX - #1')).toBeNull();
});

test('needsActiveDisambiguation flags global graphics chain patterns', () => {
  expect(needsActiveDisambiguation('^BufferTX')).toBe(true);
  expect(needsActiveDisambiguation('^QueuedBuffer')).toBe(true);
  expect(needsActiveDisambiguation('BufferQueue')).toBe(true);
  expect(needsActiveDisambiguation('SurfaceTexture|updateTexImage')).toBe(true);
  expect(needsActiveDisambiguation('^[sS]urface[fF]linger')).toBe(false);
});

test('getMaxPinsForPattern caps noisy patterns', () => {
  expect(getMaxPinsForPattern('^[sS]urface[fF]linger')).toBe(1);
  expect(getMaxPinsForPattern('^BufferTX')).toBe(1);
  expect(getMaxPinsForPattern('^QueuedBuffer')).toBe(1);
  expect(getMaxPinsForPattern('BufferQueue')).toBe(1);
  expect(getMaxPinsForPattern('^RenderThread(\\\\s+\\\\d+)?$')).toBeUndefined();
});

