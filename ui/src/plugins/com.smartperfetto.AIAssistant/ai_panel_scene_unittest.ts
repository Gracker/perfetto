// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AIPanel} from './ai_panel';
import {resetAISharedState} from './ai_shared_state';
import * as overlay from './track_overlay';

function panel() {
  const value = new AIPanel() as any;
  value.state.backendTraceId = 'trace-a';
  value.state.agentSessionId = 'session-a';
  value.state.agentRunId = 'run-a';
  value.serverStatus = {connected: true, activeProvider: {id: 'provider-a'}};
  value.isAiDisabled = vi.fn(() => false);
  value.setLoadingState = vi.fn((loading: boolean) => {value.state.isLoading = loading;});
  value.saveCurrentSession = vi.fn(); value.flushSessionSave = vi.fn();
  value.resetStreamingFlow = vi.fn(); value.resetStreamingAnswer = vi.fn();
  value.upsertSseStatusMessage = vi.fn();
  return value;
}
function stream(text: string) {
  return new Response(new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode(text)); controller.close();
  }}));
}

describe('AIPanel canonical scene flow', () => {
  afterEach(() => {vi.restoreAllMocks(); resetAISharedState();});
  it('opens and starts in one action, while reopening attaches without a second POST', async () => {
    const value = panel();
    value.fetchBackend = vi.fn(async () => new Response(JSON.stringify({success: true, sessionId: 'scene-session', runId: 'scene-run'})));
    value.listenToAgentSSE = vi.fn(async () => {});
    await value.handleSceneReconstructCommand();
    const flight = value.storyStartFlight;
    await value.handleSceneReconstructCommand();
    await flight;
    expect(value.state.showStorySidebar).toBe(true);
    expect(value.fetchBackend).toHaveBeenCalledOnce();
    expect(JSON.parse(value.fetchBackend.mock.calls[0][1].body).providerId).toBe('provider-a');
    expect(value.state.storyState.runId).toBe('scene-run');
    expect(value.listenToAgentSSE).toHaveBeenCalledWith('scene-session');
    expect(value.state.storyState.status).toBe('running');
  });
  it('drops an old fetch completion before observability, cursor or terminal mutations', async () => {
    const value = panel(); let oldResolve!: (value: Response) => void; let newResolve!: (value: Response) => void;
    value.fetchBackend = vi.fn().mockImplementationOnce(() => new Promise(done => {oldResolve = done;}))
      .mockImplementationOnce(() => new Promise(done => {newResolve = done;}));
    value.applyAgentObservability = vi.fn(); value.handleSSEEvent = vi.fn();
    const old = value.listenToAgentSSE('session-a');
    value.state.agentSessionId = 'session-b'; value.state.agentRunId = 'run-b'; value.state.backendTraceId = 'trace-b';
    const current = value.listenToAgentSSE('session-b'); const currentController = value.sseAbortController;
    oldResolve(stream('id: 99\nevent: analysis_completed\ndata: {"runId":"run-a","data":{}}\n\n'));
    await old;
    expect(value.applyAgentObservability).not.toHaveBeenCalled(); expect(value.handleSSEEvent).not.toHaveBeenCalled();
    expect(value.state.sseLastEventId).toBeNull(); expect(value.sseAbortController).toBe(currentController);
    expect(currentController.signal.aborted).toBe(false);
    value.cancelSSEConnection(); newResolve(stream('')); await current;
  });
  it('ignores a buffered old-run terminal before its event id can advance the current stream', async () => {
    const value = panel();
    value.fetchBackend = vi.fn(async () => stream('id: 4\nevent: error\ndata: {"runId":"old-run","data":{}}\n\nid: 5\nevent: analysis_completed\ndata: {"runId":"run-a","data":{"success":true}}\n\n'));
    value.applyAgentObservability = vi.fn(); value.handleSSEEvent = vi.fn();
    await value.listenToAgentSSE('session-a');
    expect(value.handleSSEEvent).toHaveBeenCalledOnce();
    expect(value.handleSSEEvent.mock.calls[0][0]).toBe('analysis_completed');
    expect(value.state.sseLastEventId).toBe(5);
    expect(value.applyAgentObservability).toHaveBeenCalledOnce();
  });
  it('does not treat EOF as completion when no terminal result can be recovered', async () => {
    const value = panel(); value.state.sseMaxRetries = 0;
    value.state.storyState = {...value.state.storyState, traceId: 'trace-a', sessionId: 'session-a', runId: 'run-a', status: 'running'};
    value.fetchBackend = vi.fn(async () => stream('')); value.checkSessionStatus = vi.fn(async () => false);
    await value.listenToAgentSSE('session-a');
    expect(value.state.storyState.status).toBe('failed');
    expect(value.state.storyState.lastError).toContain('before a confirmed terminal');
  });
  it('does not let a failed quick detection clear a timeline started after that request', async () => {
    const value = panel(); let reject!: (reason: Error) => void;
    value.fetchBackend = vi.fn(() => new Promise((_resolve, fail) => {reject = fail;}));
    const detection = value.detectScenesQuick();
    value.storyGeneration++; value.state.storyState.traceId = 'trace-a';
    value.state.detectedScenes = [{id: 'canonical-segment'}];
    reject(new Error('late failure')); await detection;
    expect(value.state.detectedScenes).toEqual([{id: 'canonical-segment'}]);
  });
  it('invalidates candidate overlay work when the same revision final removes restricted segments', () => {
    const value = panel(); value.trace = {};
    const create = vi.spyOn(overlay, 'createOverlayTrack').mockResolvedValue();
    const candidate = {schemaVersion: 'scene_timeline@1', traceId: 'trace-a', sessionId: 'session-a',
      runId: 'run-a', revision: 1, status: 'partial', coverage: {sources: []}, unresolved: [], diagnostics: [],
      segments: [{segment: {id: 'a', startNs: '1', endNs: '2', object: {key: 'a', kind: 'window'},
        userAction: 'Input', deviceState: 'Unknown', appResponse: 'Unknown', evidenceRefs: [],
        dependencies: [], supersedes: [], boundaries: {start: {}, end: {}}},
        contentFingerprint: 'a', dependencyFingerprint: 'a', issuedRevision: 1,
        referencesResolved: false, semanticStatus: 'unverified', checks: [], diagnostics: []}]};
    value.applyCanonicalSceneTimeline(candidate, false);
    const candidateIsCurrent = create.mock.calls[0][4]!;
    expect(candidateIsCurrent()).toBe(true);
    value.applyCanonicalSceneTimeline({...candidate, segments: [],
      diagnostics: [{code: 'scene_output_projection_restricted'}]}, true);
    expect(candidateIsCurrent()).toBe(false);
    expect(value.state.detectedScenes).toEqual([]);
    expect(create.mock.calls[1][3]).toEqual([]);
    expect(create.mock.calls[1][4]!()).toBe(true);
  });
  it('rejects mismatched status scopes before recovering a terminal or clearing loading', async () => {
    const value = panel(); value.handleSSEEvent = vi.fn();
    for (const payload of [{observability: {runId: 'old-run'}}, {result: {runId: 'old-run'}},
      {result: {sceneTimeline: {traceId: 'other-trace'}}}, {result: {completion: {sessionId: 'other-session'}}}]) {
      value.fetchBackend = vi.fn(async () => new Response(JSON.stringify({status: 'completed', ...payload})));
      expect(await value.checkSessionStatus('session-a', new AbortController().signal)).toBe(false);
    }
    expect(value.handleSSEEvent).not.toHaveBeenCalled();
    expect(value.setLoadingState).not.toHaveBeenCalled();
    value.fetchBackend = vi.fn(async () => new Response(JSON.stringify({status: 'completed',
      observability: {runId: 'run-a'}, result: {partial: true}})));
    expect(await value.checkSessionStatus('session-a', new AbortController().signal)).toBe(true);
    expect(value.handleSSEEvent).toHaveBeenCalledOnce();
  });
  it('clears previous canonical tracks synchronously when a rerun later fails before any proposal', async () => {
    const value = panel(); value.trace = {};
    const cleanup = vi.spyOn(overlay, 'cleanupOverlayTracks').mockImplementation(() => {});
    value.state.storyState = {...value.state.storyState, traceId: 'trace-a', sessionId: 'session-a',
      runId: 'run-a', status: 'partial', timeline: {revision: 1}};
    let reject!: (error: Error) => void;
    value.fetchBackend = vi.fn(() => new Promise((_resolve, fail) => {reject = fail;}));
    const started = value.handleStoryConfirm({forceRefresh: true});
    expect(cleanup).toHaveBeenCalledWith(value.trace, 'scene_canonical');
    expect(value.state.storyState.timeline).toBeNull();
    reject(new Error('new run unavailable')); await started;
    expect(value.state.storyState.status).toBe('failed');
    expect(value.state.detectedScenes).toEqual([]);
  });
  it.each([null, {revision: 1}])('settles unrecoverable scene history and permits an explicit retry', async timeline => {
    const value = panel();
    value.state.storyState = {...value.state.storyState, traceId: 'trace-a', sessionId: 'session-a',
      runId: 'run-a', status: 'running', timeline};
    const controller = {markTerminal: vi.fn(), start: vi.fn(async () => ({sessionId: 'session-b', runId: 'run-b'})), isDisposed: () => false};
    value.storyController = controller; value.getOrCreateStoryController = () => controller;
    value.fetchBackend = vi.fn(async () => new Response(JSON.stringify({code: 'SESSION_NOT_FOUND'}), {status: 404}));
    expect(await value.tryRecoverMissingSseSession('session-a')).toBe('notRecoverable');
    expect(value.state.storyState.status).toBe(timeline ? 'partial' : 'failed');
    expect(value.state.storyState.timeline).toBe(timeline);
    expect(controller.markTerminal).toHaveBeenCalledWith('run-a');
    value.listenToAgentSSE = vi.fn(async () => {});
    await value.handleStoryConfirm({forceRefresh: true});
    expect(controller.start).toHaveBeenCalledOnce();
    expect(value.state.storyState.runId).toBe('run-b');
  });
  it('shows the product termination reason for a scene run that committed no segment', () => {
    const value = panel();
    value.storyController = {markTerminal: vi.fn()};
    value.state.storyState = {...value.state.storyState, traceId: 'trace-a', sessionId: 'session-a', runId: 'run-a',
      status: 'running', timeline: {revision: 0, segments: []}};
    value.handleSSEEvent('analysis_completed', {data: {success: false,
      terminationMessage: 'Scene reconstruction produced no accepted timeline revision.'}});
    expect(value.state.storyState.status).toBe('failed');
    expect(value.state.storyState.lastError).toBe('Scene reconstruction produced no accepted timeline revision.');
    const rendered = JSON.stringify(value.renderStoryCompleted());
    expect(rendered).toContain('valid scene timeline');
    expect(rendered).not.toContain('Revision 0');
  });
  it('consumes the stop-and-redirect intent after confirmed canonical cancellation', async () => {
    const value = panel();
    value.state.storyState = {...value.state.storyState, traceId: 'trace-a', sessionId: 'session-a', runId: 'run-a', status: 'running'};
    value.storyController = {cancel: vi.fn(async () => ({status: 'cancelled'}))};
    value.focusChatInput = vi.fn();
    await value.stopAndRedirectAnalysis();
    expect(value.state.storyState.status).toBe('cancelled');
    expect(value.focusChatInput).toHaveBeenCalledOnce();
    expect(value.redirectAfterCancellation).toBe(false);
  });
  it.each(['completed', 'failed', 'quota_exceeded'])('consumes redirect when %s wins the cancellation race', async status => {
    const value = panel();
    value.state.storyState = {...value.state.storyState, traceId: 'trace-a', sessionId: 'session-a', runId: 'run-a', status: 'running'};
    value.storyController = {cancel: vi.fn(async () => ({status}))};
    value.focusChatInput = vi.fn(); value.listenToAgentSSE = vi.fn(async () => {});
    await value.stopAndRedirectAnalysis();
    expect(value.focusChatInput).toHaveBeenCalledOnce();
    expect(value.redirectAfterCancellation).toBe(false);
    expect(value.listenToAgentSSE).toHaveBeenCalledWith('session-a', true);
  });
  it.each(['completed', 'failed'])('consumes a pending pre-receipt redirect when matching %s is recovered', async status => {
    const value = panel();
    value.state.storyState = {...value.state.storyState, traceId: 'trace-a', sessionId: 'session-a', runId: 'run-a', status: 'running'};
    value.redirectAfterCancellation = true; value.focusChatInput = vi.fn();
    value.fetchBackend = vi.fn(async () => new Response(JSON.stringify({status,
      observability: {runId: 'run-a'}, result: {success: status === 'completed', partial: true, conclusion: 'Partial'}})));
    expect(await value.checkSessionStatus('session-a', new AbortController().signal)).toBe(true);
    expect(value.focusChatInput).toHaveBeenCalledOnce();
    expect(value.redirectAfterCancellation).toBe(false);
  });
});
