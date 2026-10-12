# Perfetto Fork Agent Guide

This checkout is the SmartPerfetto fork of Perfetto. When working inside the
SmartPerfetto submodule, follow the parent project's agent and area rules too.
Preserve unrelated edits and inspect the current source and build configuration
before choosing commands. Reuse existing utilities and keep changes scoped to
the affected architecture boundary.

## Ownership and Landing

| Area | Source | Contract |
| --- | --- | --- |
| Tracing services and probes | `src/traced`, `src/traced_probes`, `src/tracing` | Target-device collection; respect OS support |
| Tracing SDKs | `src/tracing`, `include/perfetto/tracing`, `include/perfetto/public` | Preserve public C++ and C API compatibility |
| Trace Processor | `src/trace_processor` | Offline parsing, SQLite query engine and Wasm |
| UI | `ui/` | Read [UI agent rules](AGENTS-ui.md); keep plugins on the public API |
| Other tools | `tools/`, `src/tools` | Follow the owning target and existing tests |

For this fork, push changes to `fork` (Gracker/perfetto), never upstream
`origin` (google/perfetto). Before the parent project publishes a gitlink,
ensure the commit is reachable from `fork/main`, following the parent Git
rules. UI source/generated-output changes also require the parent's committed
frontend refresh and verification; documentation-only changes do not.
Upstream contributions use the separate
[contributing workflow](contributing/getting-started.md).

## Native Build and Verification

Commands below run from the Perfetto root. Read the
[build instructions](contributing/build-instructions.md) for dependency setup,
configuration and generators, and [testing](contributing/testing.md) for
platform prerequisites and test ownership.

1. Use `$OUT` when it identifies an appropriate configured build; otherwise
   inspect existing `out/*/args.gn` and select the host/configuration needed by
   the change. Do not blindly choose the newest directory or assume a Linux
   output path on another OS. Set a concrete `OUT` once before running commands.
   If no suitable build exists, configure it via the build instructions;
   report unavailable prerequisites instead of claiming validation.
2. GN is the build source of truth. Update the owning `BUILD.gn` for added or
   removed sources. After `.gn`/`.gni` changes run `tools/gn gen --check "$OUT"`
   and, for include/dependency changes, `tools/gn check "$OUT"`.
   Add direct dependencies to the target that needs them; do not widen
   `public_deps` just to silence an include error.
3. Android.bp and Bazel BUILD are generated. Use the repository generators as
   described in the build instructions when GN changes require them; never
   hand-edit generated outputs or defer required generation to an unspecified
   later process.
4. Build the affected targets, then run their owning suites. Reuse unchanged
   passing evidence; widen verification for actual shared-code, platform or
   unresolved risk, rather than rebuilding every configuration by default.

| Changed code/test | Build target | Verification |
| --- | --- | --- |
| Native unit tests (`*_unittest.cc`) | `perfetto_unittests` | Google Test suite filter |
| Integration tests (`*_integrationtest.cc`) | `perfetto_integrationtests` | Owning suite and supported OS prerequisites |
| Performance (`*_benchmark.cc`) | `perfetto_benchmarks` | Google Benchmark regex filter |
| Trace parsing, schema, SQL stdlib or metrics | `trace_processor_shell` and required descriptors | Trace Processor diff tests |

With `OUT` set to the selected configured directory, examples are:

```sh
tools/ninja -C "$OUT" trace_processor_shell perfetto_unittests
"$OUT/perfetto_unittests" --gtest_brief=1 --gtest_filter='SuiteName.*'
"$OUT/perfetto_benchmarks" --benchmark_filter='BenchmarkName'
tools/diff_test_trace_processor.py "$OUT/trace_processor_shell" \
  --keep-input --quiet --name-filter='SuiteName:case_name'
```

Prefer an owning test suite to one individual case. Google Test filters are
globs; benchmark and diff-test filters are regexes. Diff-test names omit the
`test_` method prefix and use `SuiteName:case_name`. Check that the requested
tests actually ran; an empty
selection is not evidence. Diff outputs should compare semantic columns, not
unstable allocation IDs such as `upid`, `utid` or `id`. Keep SQL units explicit
and follow the [PerfettoSQL style guide](analysis/style-guide.md).

Use an existing ASan/MSan configuration for changes needing those checks and
set the matching symbolizer from that configuration's toolchain. Do not assume
Linux sanitizer paths work on all hosts. Device/ftrace integration checks need
their documented platform, permissions and runtime; native and cross-platform
verification are separate evidence.

## Native Implementation Contracts

- Follow the surrounding style and the C++17 policy in the contributing guide.
  Do not add exceptions or unnecessary templates/dependencies. Prefer existing
  `include/perfetto/base/` and `include/perfetto/ext/base/` utilities.
- Keep headers private alongside implementation where possible. `include/perfetto/ext`
  is non-public; changes to public SDK headers require API review. C SDK headers
  belong under `include/perfetto/public`. Include `perfetto/...`, not
  `include/perfetto/...`.
- Prefer forward declarations in headers and implementation includes in `.cc`.
  Pass out/inout arguments by pointer. Delete unneeded copy/move constructors;
  follow existing patterns when they are required.
- Use `PERFETTO_CHECK`/`PERFETTO_DCHECK` for violated invariants; never put side
  effects in a `PERFETTO_DCHECK` because release builds omit it. Use Perfetto's
  logging macros and preserve existing error handling.
- Respect supported OSes. Use `perfetto/base/build_config.h` and
  `PERFETTO_BUILDFLAG(PERFETTO_OS_...)`, never the underlying DEFINE macros
  directly. Tracing services have narrower OS support than Trace Processor/SDK.
- Match local naming/style and use clear names for cross-file interfaces.
  Commit summaries conventionally use `tp:`, `ui:` or `perfetto:` according to
  the changed area; follow the user's requested landing workflow.
