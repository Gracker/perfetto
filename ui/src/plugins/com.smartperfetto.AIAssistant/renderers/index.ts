/**
 * Renderers Module
 *
 * Schema-driven rendering utilities for DataEnvelope.
 * These utilities help render data based on column definitions
 * rather than hardcoding field names.
 *
 * @module renderers
 * @version 2.0.0
 */

// Export formatters
export * from './formatters';

// Export types from data contract
export type {
  ColumnDefinition,
  ColumnType,
  ColumnFormat,
  ClickAction,
  DataEnvelope,
  DataEnvelopeMeta,
  DataEnvelopeDisplay,
  DataPayload,
  DisplayLayer,
  DisplayLevel,
  DisplayFormat,
  HighlightRule,
  SqlQueryResult,
} from '../generated/data_contract.types';

// Export utility functions
export {
  isDataEvent,
  isDataEnvelope,
  inferColumnDefinition,
  buildColumnDefinitions,
  envelopeToSqlQueryResult,
} from '../generated/data_contract.types';
