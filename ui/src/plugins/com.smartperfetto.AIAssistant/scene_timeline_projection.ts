// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {SceneTimelineView, SceneSegmentView} from './generated/data_contract.types';
import type {DetectedScene} from './scene_navigation_bar';

export interface SceneTimelineScope {sessionId: string; runId: string; traceId: string}
export interface SceneTimelineProjection {
  timeline: SceneTimelineView;
  terminal: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nanoseconds(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 40;
}
function validSegment(value: unknown): value is SceneSegmentView {
  if (!record(value) || !record(value.segment)) return false;
  const segment = value.segment;
  return typeof segment.id === 'string' && segment.id.length > 0 &&
    nanoseconds(segment.startNs) && nanoseconds(segment.endNs) &&
    BigInt(segment.endNs) >= BigInt(segment.startNs) &&
    record(segment.object) && typeof segment.object.key === 'string' &&
    typeof segment.object.kind === 'string' &&
    ['userAction', 'deviceState', 'appResponse'].every(key => typeof segment[key] === 'string') &&
    Array.isArray(segment.evidenceRefs) && segment.evidenceRefs.every(reference => record(reference) &&
      Number.isSafeInteger(reference.rowIndex) && Number(reference.rowIndex) >= 0 &&
      ['evidenceRefId', 'artifactId', 'sourceToolCallId'].some(key => typeof reference[key] === 'string')) &&
    Array.isArray(segment.dependencies) && segment.dependencies.every(id => typeof id === 'string') &&
    Array.isArray(segment.supersedes) && segment.supersedes.every(id => typeof id === 'string') &&
    record(segment.boundaries) && record(segment.boundaries.start) && record(segment.boundaries.end) &&
    typeof value.contentFingerprint === 'string' && typeof value.dependencyFingerprint === 'string' &&
    Number.isSafeInteger(value.issuedRevision) && Number(value.issuedRevision) >= 0 &&
    typeof value.referencesResolved === 'boolean' && value.semanticStatus === 'unverified' &&
    Array.isArray(value.checks) && value.checks.every(check => record(check) &&
      typeof check.predicate === 'string' && ['passed', 'contradicted', 'unknown'].includes(String(check.status))) &&
    Array.isArray(value.diagnostics) && value.diagnostics.every(item => record(item) && typeof item.code === 'string');
}

/** Full snapshots replace one revision atomically; they never append duplicate scenes. */
export function projectSceneTimeline(
  current: SceneTimelineProjection | null,
  incoming: unknown,
  scope: SceneTimelineScope,
  terminal: boolean,
): SceneTimelineProjection | null {
  if (!record(incoming) || incoming.schemaVersion !== 'scene_timeline@1' ||
      incoming.sessionId !== scope.sessionId || incoming.runId !== scope.runId ||
      incoming.traceId !== scope.traceId || incoming.status !== 'partial' ||
      !Number.isSafeInteger(incoming.revision) || Number(incoming.revision) < 0 ||
      !Array.isArray(incoming.segments) || !incoming.segments.every(validSegment) ||
      !Array.isArray(incoming.unresolved) || !incoming.unresolved.every(value => typeof value === 'string') ||
      !Array.isArray(incoming.diagnostics) || !record(incoming.coverage) ||
      !Array.isArray(incoming.coverage.sources)) return current;
  const timeline = incoming as unknown as SceneTimelineView;
  const ids = new Set(timeline.segments.map(item => item.segment.id));
  if (ids.size !== timeline.segments.length) return current;
  if (current) {
    if (current.terminal || timeline.revision < current.timeline.revision) return current;
    if (timeline.revision === current.timeline.revision) {
      const restrictedSubset = timeline.segments.length < current.timeline.segments.length &&
        timeline.diagnostics.some(item => record(item) && item.code === 'scene_output_projection_restricted');
      if (!terminal || (timeline.segments.length !== current.timeline.segments.length && !restrictedSubset)) return current;
      const previous = new Map(current.timeline.segments.map(item => [item.segment.id, item]));
      if (timeline.segments.some(item => {
        const old = previous.get(item.segment.id);
        return !old || old.contentFingerprint !== item.contentFingerprint ||
          old.dependencyFingerprint !== item.dependencyFingerprint ||
          JSON.stringify(old) !== JSON.stringify(item);
      })) return current;
      if (restrictedSubset && timeline.segments.some(item =>
        item.segment.dependencies.some(id => !ids.has(id)))) return current;
    }
  }
  return {timeline, terminal};
}

export function sceneTimelineNavigation(timeline: SceneTimelineView): DetectedScene[] {
  return timeline.segments.map(item => ({
    id: item.segment.id,
    type: 'scene_observation',
    startTs: item.segment.startNs,
    endTs: item.segment.endNs,
    durationMs: Number(BigInt(item.segment.endNs) - BigInt(item.segment.startNs)) / 1e6,
    confidence: 0,
    label: item.segment.userAction,
    metadata: {canonical: true, semanticStatus: item.semanticStatus,
      objectKey: item.segment.object.key, deviceState: item.segment.deviceState,
      appResponse: item.segment.appResponse, referencesResolved: item.referencesResolved,
      contradicted: item.checks.some(check => check.status === 'contradicted')},
  }));
}

export const SCENE_TIMELINE_COLUMNS = [
  'ts', 'dur', 'event', 'dimension', 'segment_id', 'object_key', 'user_action', 'device_state', 'app_response', 'evidence_status',
];
export function sceneTimelineOverlayRows(timeline: SceneTimelineView, labels: Record<'userAction' | 'deviceState' | 'appResponse', string> = {userAction: 'User action', deviceState: 'Device state', appResponse: 'App response'}): unknown[][] {
  return timeline.segments.flatMap(item => (['userAction', 'deviceState', 'appResponse'] as const).map(dimension => [
    item.segment.startNs, (BigInt(item.segment.endNs) - BigInt(item.segment.startNs)).toString(),
    item.segment[dimension], labels[dimension], item.segment.id, item.segment.object.key, item.segment.userAction,
    item.segment.deviceState, item.segment.appResponse,
    item.checks.some(check => check.status === 'contradicted') ? 'contradicted' : 'unverified']));
}

/** Must run before observability/cursor/terminal mutations, including ordinary runs. */
export function agentStreamEventMatchesScope(value: unknown, scope: SceneTimelineScope): boolean {
  if (!record(value)) return false;
  const candidates = [value, value.observability];
  if (record(value.result)) candidates.push(value.result, value.result.observability, value.result.sceneTimeline, value.result.completion);
  if (record(value.data)) {
    candidates.push(value.data, value.data.observability);
    if (record(value.data.completion)) candidates.push(value.data.completion);
  }
  if (['analysis_completed', 'analysis_cancelled', 'error'].includes(String(value.type)) &&
      !candidates.some(candidate => record(candidate) && candidate.runId === scope.runId)) return false;
  return candidates.every(candidate => !record(candidate) ||
    (['runId', 'sessionId', 'traceId'] as const).every(key =>
      candidate[key] === undefined || candidate[key] === scope[key]));
}
