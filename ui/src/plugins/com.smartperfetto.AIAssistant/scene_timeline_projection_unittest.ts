// SPDX-License-Identifier: AGPL-3.0-or-later
import {describe, expect, it} from 'vitest';
import type {SceneTimelineView} from './generated/data_contract.types';
import {agentStreamEventMatchesScope, projectSceneTimeline, sceneTimelineNavigation, sceneTimelineOverlayRows} from './scene_timeline_projection';

const scope = {sessionId: 'session-a', runId: 'run-a', traceId: 'trace-a'};
function timeline(revision = 1): SceneTimelineView {
  return {schemaVersion: 'scene_timeline@1', ...scope, revision, status: 'partial',
    coverage: {status: 'unknown', captureStatus: 'unknown', reason: 'capture_unknown', sources: []},
    unresolved: ['Input coverage is incomplete'], diagnostics: [], segments: [{
      segment: {id: 'segment-a', startNs: '9007199254740993', endNs: '9007199254740994',
        object: {kind: 'window', key: 'window-a'}, userAction: 'Observed input', deviceState: 'Unknown',
        appResponse: 'No response evidence', evidenceRefs: [{evidenceRefId: 'ev-a', rowIndex: 0}],
        boundaries: {start: {source: 'evidence'}, end: {source: 'evidence'}}, dependencies: [], supersedes: []},
      contentFingerprint: 'content-a', dependencyFingerprint: 'dep-a', issuedRevision: revision,
      referencesResolved: true, semanticStatus: 'unverified', checks: [{predicate: 'window', status: 'passed'}], diagnostics: [],
    }]};
}

describe('canonical scene timeline projection', () => {
  it('rejects another trace, session or run and leaves the current revision intact', () => {
    const current = projectSceneTimeline(null, timeline(), scope, false)!;
    for (const key of ['traceId', 'sessionId', 'runId']) {
      expect(projectSceneTimeline(current, {...timeline(2), [key]: 'other'}, scope, false)).toBe(current);
    }
  });
  it('replaces higher full snapshots, refuses lower revisions and never appends duplicate scenes', () => {
    const first = projectSceneTimeline(null, timeline(), scope, false)!;
    const newer = projectSceneTimeline(first, timeline(2), scope, false)!;
    expect(newer.timeline.segments).toHaveLength(1);
    expect(projectSceneTimeline(newer, timeline(1), scope, false)).toBe(newer);
    const duplicate = timeline(3); duplicate.segments = [...duplicate.segments, ...duplicate.segments];
    expect(projectSceneTimeline(newer, duplicate, scope, false)).toBe(newer);
  });
  it('allows only a consistent candidate-to-final upgrade at the same revision', () => {
    const current = projectSceneTimeline(null, timeline(), scope, false)!;
    expect(projectSceneTimeline(current, timeline(), scope, false)).toBe(current);
    const changed = timeline(); changed.segments[0].segment.userAction = 'A different claim';
    expect(projectSceneTimeline(current, changed, scope, true)).toBe(current);
    for (const patch of [{checks: []}, {referencesResolved: false}, {issuedRevision: 2},
      {diagnostics: [{code: 'changed'}]}]) {
      const altered = timeline(); Object.assign(altered.segments[0], patch);
      expect(projectSceneTimeline(current, altered, scope, true)).toBe(current);
    }
    const final = projectSceneTimeline(current, timeline(), scope, true)!;
    expect(final.terminal).toBe(true);
    expect(projectSceneTimeline(final, timeline(10), scope, false)).toBe(final);
  });
  it('accepts a final restricted subset only when content is unchanged and dependencies remain present', () => {
    const candidate = timeline();
    const a = candidate.segments[0];
    const b = {...a, segment: {...a.segment, id: 'segment-b', dependencies: ['segment-a']}};
    const c = {...a, segment: {...a.segment, id: 'segment-c'}};
    candidate.segments = [a, b, c];
    const current = projectSceneTimeline(null, candidate, scope, false)!;
    const restricted = {...candidate, diagnostics: [{code: 'scene_output_projection_restricted',
      message: 'Final output restriction'}]};
    for (const segments of [[], [c]]) {
      const final = projectSceneTimeline(current, {...restricted, segments}, scope, true)!;
      expect(final.terminal).toBe(true);
      expect(final.timeline.segments).toEqual(segments);
      expect(sceneTimelineOverlayRows(final.timeline)).toHaveLength(segments.length * 3);
      expect(final.timeline.status).toBe('partial');
    }
    expect(projectSceneTimeline(current, {...restricted, segments: [b]}, scope, true)).toBe(current);
    expect(projectSceneTimeline(current, {...candidate, segments: [c]}, scope, true)).toBe(current);
    expect(projectSceneTimeline(current, {...restricted, segments: [c]}, scope, false)).toBe(current);
    const changed = {...c, segment: {...c.segment, userAction: 'Rewritten'}};
    expect(projectSceneTimeline(current, {...restricted, segments: [changed]}, scope, true)).toBe(current);
    const added = {...c, segment: {...c.segment, id: 'segment-d'}};
    expect(projectSceneTimeline(current, {...restricted, segments: [added]}, scope, true)).toBe(current);
  });
  it('preserves exact ns, stable ids and all three narratives without inventing a scene class or performance', () => {
    const value = timeline();
    const rows = sceneTimelineOverlayRows(value);
    expect(rows.map(row => row[2])).toEqual(['Observed input', 'Unknown', 'No response evidence']);
    expect(rows.every(row => row[0] === '9007199254740993' && row[1] === '1')).toBe(true);
    expect(sceneTimelineNavigation(value)[0]).toMatchObject({id: 'segment-a', type: 'scene_observation',
      durationMs: 0.000001, metadata: {semanticStatus: 'unverified', contradicted: false}});
  });
  it('retains the last segment of a 2000-segment timeline', () => {
    const value = timeline(); value.segments = Array.from({length: 2000}, (_, i) => ({...value.segments[0],
      segment: {...value.segments[0].segment, id: `segment-${i}`}}));
    expect(sceneTimelineNavigation(value)).toHaveLength(2000);
    expect(sceneTimelineOverlayRows(value)).toHaveLength(6000);
    expect(sceneTimelineOverlayRows(value)[5999][4]).toBe('segment-1999');
  });
  it('rejects stale completed/error event scope before any observable stream mutation', () => {
    for (const type of ['analysis_completed', 'error', 'scene_timeline_updated']) {
      expect(agentStreamEventMatchesScope({type, runId: 'old-run', data: {}}, scope)).toBe(false);
      expect(agentStreamEventMatchesScope({type, runId: scope.runId, data: {observability: {traceId: 'other'}}}, scope)).toBe(false);
      expect(agentStreamEventMatchesScope({type, ...scope, data: {}}, scope)).toBe(true);
      if (type !== 'scene_timeline_updated') expect(agentStreamEventMatchesScope({type, data: {}}, scope)).toBe(false);
    }
  });
});
