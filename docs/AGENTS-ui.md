# Perfetto UI Agent Guide

Perfetto UI lives in `ui/`, uses TypeScript and Mithril, and embeds Trace
Processor through Wasm. Apply the [fork guide](AGENTS.md) and, in a SmartPerfetto
submodule checkout, the parent frontend/product contracts.

## Ownership and Commands

| Directory under `ui/src/` | Responsibility |
| --- | --- |
| `base/`, `widgets/`, `components/` | Shared utilities, reusable widgets and higher-level components/tracks |
| `public/` | Plugin API boundary |
| `core/`, `frontend/` | Managers and application rendering |
| `plugins/`, `core_plugins/` | Optional plugins and essential always-active plugins |
| `trace_processor/` | Engine protocol, typed query results and SQL helpers |
| `assets/`, component `.scss` | Styles and static assets |
| `test/` | Playwright integration scenarios |

Prefer a plugin when the public API supports the feature; do not promote an
optional feature into core just to access internal state. Read the maintained
[UI development guide](contributing/ui-getting-started.md) and
[plugin guide](contributing/ui-plugins.md) for setup and examples. The current
build uses Vite, pnpm, Vitest and Playwright; `ui/build.mjs`, its wrappers and
`ui/package.json` own the actual commands and dependencies.

Run from the Perfetto root:

```sh
ui/build                         # Prepare Wasm/generated assets and build production UI.
ui/run-dev-server                # Builds and serves with live reload at localhost:10000.
ui/build --typecheck              # Prepare build inputs and typecheck, without bundling.
tools/node ui/build.mjs --no-build --typecheck
ui/run-unittests --no-build --test-filter='OwningSuite'
ui/run-integrationtests --help
```

The `--no-build` checks reuse an already prepared output (default `out/ui`, or
pass the corresponding `--out`). They avoid acquiring a competing build lock
and repeating Wasm/assets/proto/stdlib preparation. On a fresh or changed
configuration, prepare the inputs first; missing prerequisites are not a pass.
Do not clear a watch lock until its owner is confirmed stopped. A unit filter
matches test names by regex, not file paths; confirm the expected tests ran.
Use the owning unit/DOM suite (`*_unittest.ts`, `*_jsdomtest.ts`) and relevant
Playwright scenarios for changed interaction behavior. A typecheck alone does
not prove rendering, lifecycle or the parent's shipped frontend.

## Plugins and Lifecycle

Use [public plugin types](../ui/src/public/plugin.ts) and the
[Trace API](../ui/src/public/trace.ts), not internal manager state. Plugin IDs,
settings and feature flags use unique reverse-DNS names; command IDs should be
descriptive without redundantly repeating their plugin name. Declare plugin
dependencies explicitly.

- Static `onActivate(app, args)` registers global commands/pages/sidebar items
  before trace loading.
- A trace-scoped plugin instance receives `Trace`; `onTraceLoad(trace, args)`
  registers trace-dependent tracks, tabs, commands and queries.
- `trace.onTraceReady` runs after all plugins finish `onTraceLoad`; use it when
  automation requires the completed track set.
- Pass `Trace` through components that need it. Use `trace.engine`, `tracks`,
  `selection`, `commands`, `tabs`, `timeline`, `workspaces` and `currentWorkspace`
  through their public interfaces. Keep persistent store data serializable and
  validate migrations; avoid class instances in saved state.
- Tie trace resources/listeners to `trace.trash` or the appropriate disposable
  lifecycle; do not retain resources or stale trace state after unloading.
- Prefer existing higher-level tracks, especially
  [SliceTrack](../ui/src/components/tracks/slice_track.ts), before implementing
  and registering a low-level track from scratch.

## Rendering and Async Data

Reuse `widgets/` and `components/` before adding another widget. Use `Anchor`
for links, `classNames()` for conditional CSS and `Gate` when hiding content
must preserve component state. Initialize non-DOM state in a constructor or
setup closure; use `oncreate` only for DOM-dependent work and compute cheap
render-derived values in `view()`.

Mithril DOM handlers and completed engine queries schedule redraws; manually
registered JS handlers may require one. Update state in event handlers, rather
than embedding data-fetching machinery there or in `oninit`/`onupdate`.

Use [AsyncMemo and AtomicTaskQueue](../ui/src/base/async_memo.ts) for keyed async
loading from synchronous `view()`/track render cycles:

- Instantiate a memo once per component/track, never inside `view()`. Its key
  contains every data dependency and compares by structural value through
  `stringifyJsonWithBigints`, including bigint values.
- Call `.use()` during rendering; handle missing data and `isPending` honestly.
  `retainOn` allows specified key changes to show stale data while loading;
  do not present it as fresh. Use dependency gating or wait for the prerequisite
  data before querying it.
- `compute` completion redraws automatically; do not call `m.redraw()` inside
  it. Superseded work is signalled through `isCancelled`; long/multi-step tasks
  should check it and return/throw `TASK_CANCELLED` to avoid caching cancelled
  work. Queue serialization does not interrupt already-running operations.
- Keep `compute` free of external state mutation. Temporary SQL tables/views/
  indexes must be cleaned up by the returned `AsyncDisposable`.
- Returned disposable cache values are disposed before replacement, on
  invalidation and on memo disposal, through the task queue so cleanup cannot
  interleave with in-flight work. Plain cached values can be retained during
  transitions. Call `.dispose()` at the owning lifecycle's end when early
  cancellation/resource cleanup is needed; never use a disposed memo again.
- Share one `AtomicTaskQueue` across memos touching the same temporary SQL
  resources so multi-step operations cannot interleave. Separate slow table
  preparation from frequently changing bounds/filter queries with dependent
  memos, rather than recreating tables for every pan or zoom.

## SQL and Types

Use typed query iteration from
[query_result.ts](../ui/src/trace_processor/query_result.ts). Preserve units and
nullability; do not rely on unsafe assertions or implicit conversions.

- Trace Processor allocation IDs (`track_id`, `upid`, `utid`, `slice.id`) use
  `NUM`/`NUM_NULL` and `number`.
- Nanosecond timestamps/durations use `LONG`/`LONG_NULL` and `bigint`; converting
  them to `number` can lose precision. Immediately convert query values with
  `Time.fromRaw`/`Duration.fromRaw` where applicable, using
  [time.ts](../ui/src/base/time.ts). `time` is branded; `duration` is a bigint
  alias. Use their arithmetic/formatting helpers instead of mixing domains or
  inventing unit conversions.
- Parse unknown input (JSON, saved configs, external data) with Zod/schema
  validation and type guards. Prefer `unknown` over `any`; a cast is not
  validation.
- Prefer readonly attrs/interfaces and `readonly T[]`, `undefined` for absent
  optional values, camelCase variables, explicit boolean conditions and
  exhaustive switches with `assertUnreachable()`. Match surrounding style and
  use the existing `base/` utilities for time, assertions and resource cleanup.

## Theme and Review

- Use stylesheets, `pf-` CSS classes and the established BEM-like naming.
  Avoid inline presentation styles and hard-coded colors; use semantic custom
  properties from [theme_provider.scss](../ui/src/frontend/theme_provider.scss).
  Check both light and dark themes.
- Keep changed UI behavior, rendering and accessibility covered by the owning
  tests/scenarios. Consult [UI review antipatterns](ui-review-antipatterns.md)
  for layer, state, performance and API mistakes, instead of copying examples
  into a new parallel implementation.
- New files use the current copyright year; do not change years in existing
  files merely because they were edited. Follow existing lint/formatting
  conventions and limit formatting to task-owned changes.
