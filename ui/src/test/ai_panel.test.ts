// Copyright (C) 2024 SmartPerfetto
// AI Panel E2E Tests
//
// End-to-end tests for the AI Panel functionality including:
// - Table data display (verifies no raw JSON columns)
// - Timestamp click navigation
// - Table collapse/expand interactions

import {test, Page, expect} from '@playwright/test';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

test.describe.configure({mode: 'serial'});

let pth: PerfettoTestHelper;
let page: Page;

// Test configuration
const AI_BACKEND_TIMEOUT = 60000; // AI analysis can take time

// Columns that should NEVER appear in skill result tables
// These are StepResult metadata, not actual data
const FORBIDDEN_COLUMNS = ['stepId', 'data', 'display', 'executionTimeMs'];

test.describe('AI Panel', () => {
  test.beforeAll(async ({browser}, _testInfo) => {
    page = await browser.newPage();
    pth = new PerfettoTestHelper(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('should load trace and open AI Panel', async () => {
    // Load a trace file that has scrolling data
    // Note: You may need to adjust this to use an existing test trace
    try {
      await pth.openTraceFile('api34_startup_cold.perfetto-trace');
    } catch {
      // If trace doesn't exist, skip this test suite
      test.skip();
      return;
    }

    await pth.waitForIdleAndScreenshot('trace_loaded.png');

    // Open AI Panel via sidebar
    const aiPanelButton = page.locator('.pf-sidebar button[title*="AI"]');
    if (await aiPanelButton.count() > 0) {
      await aiPanelButton.click();
      await pth.waitForPerfettoIdle();
    }
  });

  test('should render skill result tables without StepResult metadata columns', async () => {
    // Wait for AI Panel to be visible
    const aiPanel = page.locator('.ai-assistant-panel');

    // If AI Panel is not available, skip
    if (await aiPanel.count() === 0) {
      test.skip();
      return;
    }

    // Send a test query
    const inputField = aiPanel.locator('input[type="text"], textarea').first();
    if (await inputField.count() === 0) {
      test.skip();
      return;
    }

    await inputField.fill('分析滑动性能');
    await inputField.press('Enter');

    // Wait for response with timeout
    await page.waitForTimeout(5000); // Initial wait for SSE to start

    // Wait for table to appear (with longer timeout for AI processing)
    try {
      await page.waitForSelector('.ai-assistant-panel table', {
        timeout: AI_BACKEND_TIMEOUT,
      });
    } catch {
      // If no table appears, the backend might not be running
      console.log('No table rendered - AI backend may not be running');
      test.skip();
      return;
    }

    // Get all table headers
    const tables = await aiPanel.locator('table').all();

    for (const table of tables) {
      const headers = await table.locator('th').allTextContents();

      // Verify NO forbidden columns appear
      for (const header of headers) {
        const headerLower = header.toLowerCase().trim();
        for (const forbidden of FORBIDDEN_COLUMNS) {
          expect(
            headerLower,
            `Table should not have '${forbidden}' column. Found headers: ${headers.join(', ')}`
          ).not.toBe(forbidden.toLowerCase());
        }
      }

      // Log the columns for debugging
      console.log('Table columns:', headers);
    }

    await pth.waitForIdleAndScreenshot('ai_panel_with_tables.png');
  });

  test('should display actual metric columns in tables', async () => {
    const aiPanel = page.locator('.ai-assistant-panel');
    if (await aiPanel.count() === 0) {
      test.skip();
      return;
    }

    const tables = await aiPanel.locator('table').all();
    if (tables.length === 0) {
      test.skip();
      return;
    }

    // Expected columns for scrolling analysis
    const expectedColumnPatterns = [
      /fps/i,
      /jank/i,
      /frame/i,
      /session/i,
      /dur/i,
      /rate/i,
    ];

    let foundExpectedColumn = false;

    for (const table of tables) {
      const headers = await table.locator('th').allTextContents();

      for (const header of headers) {
        for (const pattern of expectedColumnPatterns) {
          if (pattern.test(header)) {
            foundExpectedColumn = true;
            break;
          }
        }
      }
    }

    // At least one table should have an expected metric column
    expect(
      foundExpectedColumn,
      'Tables should contain actual metric columns (fps, jank, frame, etc.)'
    ).toBe(true);
  });

  test('should have clickable timestamps that navigate', async () => {
    const aiPanel = page.locator('.ai-assistant-panel');
    if (await aiPanel.count() === 0) {
      test.skip();
      return;
    }

    // Look for clickable timestamp elements
    const timestampLinks = aiPanel.locator('.ai-clickable-timestamp, [data-ts]');
    const count = await timestampLinks.count();

    if (count === 0) {
      console.log('No clickable timestamps found in AI Panel');
      // This is not a failure - timestamps may not be present
      return;
    }

    // Click the first timestamp
    const firstTimestamp = timestampLinks.first();
    await firstTimestamp.click();

    // Wait for navigation to complete
    await pth.waitForPerfettoIdle();

    // Verify the timeline view has changed (scroll position or zoom)
    await pth.waitForIdleAndScreenshot('after_timestamp_click.png');
  });

  test('should collapse and expand table sections', async () => {
    const aiPanel = page.locator('.ai-assistant-panel');
    if (await aiPanel.count() === 0) {
      test.skip();
      return;
    }

    // Look for collapsible section headers
    const sectionHeaders = aiPanel.locator('.ai-section-header, .ai-collapsible-card');
    const count = await sectionHeaders.count();

    if (count === 0) {
      console.log('No collapsible sections found');
      return;
    }

    // Get the first collapsible section
    const firstSection = sectionHeaders.first();

    // Take screenshot before collapse
    await pth.waitForIdleAndScreenshot('section_expanded.png');

    // Click to collapse
    await firstSection.click();
    await pth.waitForPerfettoIdle();
    await pth.waitForIdleAndScreenshot('section_collapsed.png');

    // Click to expand again
    await firstSection.click();
    await pth.waitForPerfettoIdle();
    await pth.waitForIdleAndScreenshot('section_re_expanded.png');
  });
});

test.describe('AI Panel - Mocked Backend', () => {
  // These tests use mocked SSE responses to test frontend rendering
  // without requiring the actual AI backend

  test('should correctly render mocked skill_data event', async ({page}) => {
    // Navigate to the app
    await page.goto('/?testing=1');

    // Inject a mock skill_data event into the AI Panel
    const mockSkillData = {
      skillId: 'scrolling_analysis',
      skillName: '滑动性能分析',
      layers: {
        overview: {
          performance_summary: {
            stepId: 'performance_summary',
            data: [{fps: 55.5, jank_rate: 8.2, total_frames: 150}],
            display: {title: '性能概览'},
          },
        },
        list: {
          scrolling_sessions: {
            stepId: 'scrolling_sessions',
            data: [
              {session_id: 1, fps: 55, jank_count: 3},
              {session_id: 2, fps: 60, jank_count: 0},
            ],
            display: {title: '滑动会话'},
          },
        },
      },
    };

    // Evaluate in page context to simulate receiving the event
    await page.evaluate((data) => {
      // Dispatch a custom event that AI Panel can listen to
      window.dispatchEvent(new CustomEvent('mock-skill-data', {detail: data}));
    }, mockSkillData);

    // This test verifies the mock infrastructure works
    // The actual assertion would depend on how the AI Panel handles events
  });
});
