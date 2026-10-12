/**
 * DSH tool definitions. Each tool is a thin, declarative binding: a parameter
 * schema for the model, a pure bounded parser, and the shared receipt renderer.
 * @module dsh-jvm-doctor/tools
 */
import {
  defineTool,
  parameterSchemaSpecToJsonSchema,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { renderEnvelope, envelope, type Envelope } from './core/receipt.ts'
import { assertWithinInput, clipToBytes } from './core/bytes.ts'
import { parseThreadDump } from './core/thread-dump.ts'
import { parseGcLog } from './core/gc-log.ts'
import { parseDependencyText } from './core/deps.ts'
import { parseStackTrace } from './core/stacktrace.ts'
import { diffSpringConfig } from './core/spring-config.ts'
import { DEFAULT_LIMITS, type Limits } from './limits.ts'

/** Tool groups, used by the `only` config filter and documentation. */
export type ToolGroup = 'jvm'

/** Shared meta schema for the receipt envelope. */
const META_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bytesIn: { type: 'integer', required: true, description: 'UTF-8 bytes read from the primary input.' },
    bytesOut: { type: 'integer', required: true, description: 'UTF-8 bytes of the canonical result.' },
    truncated: { type: 'boolean', required: true, description: 'True when a configured budget clipped input or output.' },
    notes: { type: 'array', items: { type: 'string' }, required: true, description: 'Ordered notes: budgets, fallbacks, unsupported syntax.' },
  },
} as const

/** Result schema slot for a body that does not declare one. */
const RESULT_SPEC = { type: 'json' } as const

/** Coverage fields every report family carries, so honesty is uniform. */
const COVERAGE_PROPERTIES = {
  parser_version: { type: 'string', required: true },
  total_lines: { type: 'integer', required: true },
  parsed_lines: { type: 'integer', required: true },
  unknown_lines: { type: 'integer', required: true },
  unknown_samples: { type: 'array', items: { type: 'string' }, required: true },
  coverage: { type: 'number', required: true },
  confidence: { type: 'string', required: true, enum: ['high', 'medium', 'low'] },
} as const

const FRAME_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: { type: 'string', required: true },
    file: { type: 'string', required: true },
    line: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    library: { type: 'boolean', required: true },
    source_line: { type: 'integer', required: true },
  },
} as const

const LOCK_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    raw: { type: 'string', required: true },
  },
} as const

const THREAD_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    tid: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    nid: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    state: { type: 'string', required: true },
    normalized_state: { type: 'string', required: true },
    daemon: { type: 'boolean', required: true },
    priority: { type: 'integer', required: true },
    type: { type: 'string', required: true },
    line: { type: 'integer', required: true },
    top_frames: { type: 'array', items: { type: 'string' }, required: true },
    frame_count: { type: 'integer', required: true },
    locked: { type: 'array', items: LOCK_SPEC, required: true },
    waiting_to_lock: { type: 'array', items: LOCK_SPEC, required: true },
    parking_to_wait_for: { type: 'array', items: LOCK_SPEC, required: true },
    ownable_synchronizers: { type: 'array', items: LOCK_SPEC, required: true },
    object_wait: { type: 'array', items: LOCK_SPEC, required: true },
    status: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

const THREAD_DUMP_RESULT: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...COVERAGE_PROPERTIES,
    eol: { type: 'string', required: true, enum: ['lf', 'crlf', 'mixed', 'none'] },
    source: { type: 'string', required: true },
    jvm_version: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    captured_at: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    thread_count: { type: 'integer', required: true },
    non_standard_thread_headers: { type: 'integer', required: true },
    state_histogram: { type: 'object', additionalProperties: true },
    raw_state_histogram: { type: 'object', additionalProperties: true },
    daemon_threads: { type: 'integer', required: true },
    parked_or_waiting: { type: 'integer', required: true },
    deadlock_marker: { type: 'boolean', required: true },
    deadlock_cycles: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          threads: { type: 'array', items: { type: 'string' }, required: true },
          locks: { type: 'array', items: { type: 'string' }, required: true },
          chain: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                thread: { type: 'string', required: true },
                waiting_for: { type: 'string', required: true },
                holding: { type: 'string', required: true },
              },
            },
          },
        },
      },
    },
    unresolved_locks: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { waited_by: { type: 'string', required: true }, lock: { type: 'string', required: true } },
      },
    },
    reported_deadlock_count: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    blocked_in_object_wait: { type: 'integer', required: true },
    blocked_holding_lock: { type: 'integer', required: true },
    ownable_synchronizer_threads: { type: 'integer', required: true },
    ownable_synchronizer_count: { type: 'integer', required: true },
    lock_contention_candidates: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string', required: true },
          thread_count: { type: 'integer', required: true },
          threads: { type: 'array', items: { type: 'string' }, required: true },
          states: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
    },
    status_lines: { type: 'array', items: { type: 'string' }, required: true },
    status_lines_omitted: { type: 'integer', required: true },
    threads: { type: 'array', items: THREAD_SPEC, required: true },
    threads_omitted: { type: 'integer', required: true },
  },
}

const GC_RESULT: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...COVERAGE_PROPERTIES,
    gc_event_count: { type: 'integer', required: true },
    non_gc_lines: { type: 'integer', required: true },
    pause_count: { type: 'integer', required: true },
    total_pause_ms: { type: 'number', required: true },
    mean_pause_ms: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    max_pause_ms: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    pause_percentiles: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            p50_ms: { type: 'number', required: true },
            p90_ms: { type: 'number', required: true },
            p99_ms: { type: 'number', required: true },
            max_ms: { type: 'number', required: true },
          },
        },
      ],
    },
    pause_samples: { type: 'integer', required: true },
    pause_percentiles_sampled: { type: 'boolean', required: true },
    young_pause_count: { type: 'integer', required: true },
    full_pause_count: { type: 'integer', required: true },
    concurrent_cycle_count: { type: 'integer', required: true },
    heap_before_min_bytes: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    heap_before_max_bytes: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    heap_after_min_bytes: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    heap_after_max_bytes: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    heap_total_max_bytes: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    cause_histogram: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          mean_pause_ms: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          max_pause_ms: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        },
      },
    },
    unique_causes: { type: 'integer', required: true },
    causes_omitted: { type: 'integer', required: true },
    estimated_allocation_rate: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            bytes_per_second: { type: 'number', required: true },
            bytes_per_hour: { type: 'number', required: true },
            window_seconds: { type: 'number', required: true },
            events_with_timestamp: { type: 'integer', required: true },
            method: { type: 'string', required: true },
          },
        },
      ],
    },
    promotion_failures: { type: 'integer', required: true },
    allocation_failures: { type: 'integer', required: true },
    metadata_gc_threshold_events: { type: 'integer', required: true },
    to_space_exhausted_events: { type: 'integer', required: true },
    findings: { type: 'array', items: { type: 'string' }, required: true },
  },
}

const DEP_EDGE_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true },
    depth: { type: 'integer', required: true },
    indent: { type: 'integer', required: true },
    artifact: { type: 'string', required: true },
    version: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    requested_version: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    connector: { type: 'string', required: true },
    classifier: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    omitted: { type: 'boolean', required: true },
    omitted_reason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    omitted_with: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    scope: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    raw: { type: 'string', required: true },
  },
} as const

const DEPS_RESULT: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...COVERAGE_PROPERTIES,
    source: { type: 'string', required: true, enum: ['maven', 'gradle', 'unknown'] },
    edge_count: { type: 'integer', required: true },
    artifact_count: { type: 'integer', required: true },
    omitted_edge_count: { type: 'integer', required: true },
    duplicate_markers: { type: 'integer', required: true },
    conflicts: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          artifact: { type: 'string', required: true },
          resolved_versions: { type: 'array', items: { type: 'string' }, required: true },
          omitted_versions: { type: 'array', items: { type: 'string' }, required: true },
          requested_versions: { type: 'array', items: { type: 'string' }, required: true },
          conflict_with: { type: 'array', items: { type: 'string' }, required: true },
          duplicate_edges: { type: 'integer', required: true },
          omitted_edges: { type: 'integer', required: true },
          min_depth: { type: 'integer', required: true },
          max_depth: { type: 'integer', required: true },
          depths: { type: 'array', items: { type: 'integer' }, required: true },
          kind: { type: 'string', required: true, enum: ['version_conflict', 'omitted_duplicate', 'removed_edge'] },
          summary: { type: 'string', required: true },
          edges: { type: 'array', items: DEP_EDGE_SPEC, required: true },
          edges_omitted: { type: 'integer', required: true },
        },
      },
    },
    conflicts_omitted: { type: 'integer', required: true },
    direct_edge_count: { type: 'integer', required: true },
    max_depth: { type: 'integer', required: true },
    findings: { type: 'array', items: { type: 'string' }, required: true },
  },
}

const STACK_TRACE_RESULT: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...COVERAGE_PROPERTIES,
    exception_count: { type: 'integer', required: true },
    root_cause: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    primary_message: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    chain: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', required: true },
          simple_type: { type: 'string', required: true },
          message: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          relation: { type: 'string', required: true, enum: ['primary', 'caused_by', 'suppressed', 'secondary'] },
          index: { type: 'integer', required: true },
          line: { type: 'integer', required: true },
          frames: { type: 'array', items: FRAME_SPEC, required: true },
          frame_count: { type: 'integer', required: true },
          folded_frames: { type: 'integer', required: true },
          folded_resolved: { type: 'integer', required: true },
          deepest_application_frame: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          hints: { type: 'array', items: { type: 'string' }, required: true },
          suppressed_lines: { type: 'integer', required: true },
        },
      },
    },
    total_frames: { type: 'integer', required: true },
    folded_frames_resolved: { type: 'integer', required: true },
    folded_frames_unresolved: { type: 'integer', required: true },
    exceptions_omitted: { type: 'integer', required: true },
    frames_omitted: { type: 'integer', required: true },
    deepest_application_frame: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    application_frames: { type: 'array', items: { type: 'string' }, required: true },
    library_prefixes: { type: 'array', items: { type: 'string' }, required: true },
    hints: { type: 'array', items: { type: 'string' }, required: true },
    test_failure: { type: 'boolean', required: true },
    non_frame_lines: { type: 'integer', required: true },
  },
}

const CONFIG_DIFF_RESULT: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    parser_version: { type: 'string', required: true },
    left_dialect: { type: 'string', required: true, enum: ['yaml', 'properties', 'unknown'] },
    right_dialect: { type: 'string', required: true, enum: ['yaml', 'properties', 'unknown'] },
    left_keys: { type: 'integer', required: true },
    right_keys: { type: 'integer', required: true },
    changes: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          op: { type: 'string', required: true, enum: ['add', 'remove', 'change'] },
          left: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          right: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          masked: { type: 'boolean', required: true },
        },
      },
    },
    changes_omitted: { type: 'integer', required: true },
    added: { type: 'integer', required: true },
    removed: { type: 'integer', required: true },
    changed: { type: 'integer', required: true },
    unchanged: { type: 'integer', required: true },
    empty: { type: 'boolean', required: true },
    masked_values: { type: 'integer', required: true },
    errors: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          side: { type: 'string', required: true, enum: ['left', 'right'] },
          message: { type: 'string', required: true },
          line: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
    },
    coverage: { type: 'number', required: true },
    confidence: { type: 'string', required: true, enum: ['high', 'medium', 'low'] },
    findings: { type: 'array', items: { type: 'string' }, required: true },
  },
}

/** One tool body: model-facing schema plus a bounded, synchronous implementation. */
export interface ToolBody {
  /** Tool name as the model sees it. */
  name: string
  /** Model-facing description; states the bounds and what the tool refuses. */
  description: string
  /** Parameter schema. */
  parameters: ParameterSchemaSpec
  /** Canonical result schema for the `result` field. */
  result: ValueSchemaSpec
  /** Group used by the `only` filter. */
  group: ToolGroup
  /** Implementation receiving validated arguments and the effective budgets. */
  run(args: Record<string, unknown>, limits: Limits): Envelope<JsonValue>
}

/**
 * Build a registry-ready definition with the shared receipt renderer.
 *
 * The registry validates the canonical value against the declared per-tool
 * `result` schema; only the author-facing generic is erased, because
 * `InferValue` collapses over a broad `ValueSchemaSpec` union. The pairing is
 * asserted by the tool tests instead.
 * @param body - tool body.
 * @param opts - budgets, name prefix, and allowlist for this plugin instance.
 */
export function defineReceiptTool(body: ToolBody, opts: ToolFactoryOptions) {
  const { limits, prefix = '' } = opts
  if (opts.only !== undefined && opts.only.length > 0 && !opts.only.includes(body.name)) return undefined
  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { result: body.result ?? RESULT_SPEC, meta: META_SPEC },
  } as const
  const options = {
    name: prefix.length > 0 ? `${prefix}__${body.name}` : body.name,
    description: body.description,
    parameters: body.parameters,
    output: {
      schema: outputSchema,
      render: (_args: unknown, value: Envelope<unknown>) => {
        // Text rendering is clipped at an author boundary so the clipping note
        // travels with the payload instead of being applied invisibly.
        const body = typeof value.result === 'string' ? value.result : JSON.stringify(value.result, null, 2)
        const clipped = clipToBytes(body, limits.maxOutputBytes)
        const notes = [...value.meta.notes]
        if (clipped.truncated) {
          notes.push(`rendered text clipped to maxOutputBytes=${limits.maxOutputBytes}; the payload tail is not shown but meta.bytesOut reports the true size`)
        }
        return renderEnvelope({ result: clipped.text, meta: { ...value.meta, truncated: value.meta.truncated || clipped.truncated, notes } })
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal }) {
      exec.signal.throwIfAborted()
      return body.run(args as Record<string, unknown>, limits)
    },
  }
  // `defineTool`'s const generics recurse through `InferObject` over the broad
  // `ParameterSchemaSpec` union; the schema is still compiled and checked below,
  // so only the erased generic is dropped here.
  const compile = defineTool as unknown as (input: unknown) => ToolDefinition
  return compile(options)
}

/** Compile a parameter schema to JSON Schema, proving the DSL node is valid. */
export function compileParameters(spec: ParameterSchemaSpec) {
  return parameterSchemaSpecToJsonSchema(spec)
}

const TEXT_INPUT = {
  type: 'string',
  required: true,
  description: 'Report text pasted inline. The tool never reads files, sockets or processes.',
} as const

/** Options shared by every tool built for one plugin instance. */
export interface ToolFactoryOptions {
  /** Effective budgets. */
  limits: Limits
  /** Optional tool-name prefix, joined with `__`. */
  prefix?: string
  /** Register only these base tool names; empty registers every tool. */
  only?: readonly string[]
}

/**
 * Every tool this package registers, in registration order.
 * @param opts - budgets, name prefix, and optional allowlist.
 */
export function createTools(opts: ToolFactoryOptions) {
  const tools: (ReturnType<typeof defineReceiptTool>)[] = [
    // ------------------------------------------------------------------ jvm ---
    defineReceiptTool(
      {
        name: 'java_thread_dump',
        group: 'jvm',
        description:
          'Diagnose a pasted jstack or `jcmd <pid> Thread.print` dump without touching the JVM: thread-state histogram, daemon count, per-thread top frames, Java-level deadlock cycles with the lock chain, Object.wait/park counts, ownable synchronizers, and lock-contention cohorts. Offline only: it parses the text you paste and never runs jcmd, jstack or any network or filesystem call. Refuses (throws) when the text exceeds maxInputBytes; refuses to guess: unrecognized lines are counted in unknown_lines with samples and lower confidence.',
        parameters: { text: TEXT_INPUT },
        result: THREAD_DUMP_RESULT,
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes, 'thread dump')
          const report = parseThreadDump(text, {
            maxThreads: limits.maxThreads,
            maxStatusLines: limits.maxStatusLines,
            sampleLimit: limits.sampleLimit,
            maxContention: limits.maxContention,
          })
          const notes: string[] = []
          if (report.unknown_lines > 0) {
            notes.push(
              `${report.unknown_lines} of ${report.total_lines} line(s) matched no known dump shape (coverage ${(report.coverage * 100).toFixed(1)}%); they are sampled in unknown_samples, not silently dropped`,
            )
          }
          const clippedRows = report.threads_omitted > 0 || report.status_lines_omitted > 0
          if (report.threads_omitted > 0) notes.push(`thread list clipped to maxThreads=${limits.maxThreads} (${report.threads_omitted} omitted)`)
          if (report.status_lines_omitted > 0) notes.push(`status lines clipped to maxStatusLines=${limits.maxStatusLines}`)
          if (report.thread_count === 0) notes.push('no thread header matched `"name" ... prio= ... nid=0x...`; the input may not be a thread dump')
          return envelope(report as unknown as JsonValue, bytesIn, notes, clippedRows)
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'java_gc_log',
        group: 'jvm',
        description:
          'Summarize a pasted JVM GC log in either grammar: JEP 158 unified logging (`-Xlog:gc`) and legacy pre-JDK 9 collector lines. Returns event and pause counts, total/mean/max pause, p50/p90/p99/max pause percentiles, Young vs Full split, heap before/after ranges in bytes, a pause-cause histogram (Allocation Failure, to-space exhausted, Metadata GC Threshold), promotion failures, and an allocation-rate estimate when timestamps allow. Offline only: no file reads, no `jstat`, no network. Refuses (throws) when the text exceeds maxInputBytes; lines that match neither grammar are reported in unknown_lines with samples instead of being ignored.',
        parameters: { text: TEXT_INPUT },
        result: GC_RESULT,
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes, 'GC log')
          const report = parseGcLog(text, {
            maxGcEvents: limits.maxGcEvents,
            maxPauseSamples: limits.maxPauseSamples,
            sampleLimit: limits.sampleLimit,
          })
          const notes: string[] = []
          if (report.unknown_lines > 0) {
            notes.push(
              `${report.unknown_lines} of ${report.total_lines} line(s) matched neither the unified nor the legacy GC grammar (coverage ${(report.coverage * 100).toFixed(1)}%)`,
            )
          }
          if (report.pause_percentiles_sampled) notes.push(`percentiles computed over the first maxPauseSamples=${limits.maxPauseSamples} pauses`)
          if (report.causes_omitted > 0) notes.push(`cause histogram clipped to maxGcEvents=${limits.maxGcEvents} (${report.causes_omitted} cause(s) omitted of ${report.unique_causes})`)
          if (report.gc_event_count === 0) notes.push('no GC event matched; check that the log uses -Xlog:gc or legacy `[GC (reason) ...]` lines')
          return envelope(report as unknown as JsonValue, bytesIn, notes, report.pause_percentiles_sampled || report.causes_omitted > 0)
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'java_dependency_conflicts',
        group: 'jvm',
        description:
          'Find classpath version conflicts in pasted Maven `dependency:tree -Dverbose` or Gradle `dependencies` / `dependencyInsight` text: same artifact at several resolved versions, `omitted for conflict with X`, `omitted for duplicate`, the depths where each edge appears, and per-artifact summaries. Offline only: it never invokes Maven, Gradle or a resolver and never reads a local repository. Refuses (throws) when the text exceeds maxInputBytes; build-tool chatter it cannot classify is reported in unknown_lines with samples rather than dropped.',
        parameters: { text: TEXT_INPUT },
        result: DEPS_RESULT,
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes, 'dependency tree')
          const report = parseDependencyText(text, {
            maxConflicts: limits.maxConflicts,
            maxEdgesPerConflict: limits.maxEdgesPerConflict,
            sampleLimit: limits.sampleLimit,
          })
          const notes: string[] = []
          if (report.unknown_lines > 0) {
            notes.push(`${report.unknown_lines} of ${report.total_lines} line(s) matched no known dependency shape (coverage ${(report.coverage * 100).toFixed(1)}%)`)
          }
          if (report.conflicts_omitted > 0) notes.push(`conflict list clipped to maxConflicts=${limits.maxConflicts} (${report.conflicts_omitted} omitted)`)
          const edgesOmitted = report.conflicts.reduce((sum, conflict) => sum + conflict.edges_omitted, 0)
          if (edgesOmitted > 0) notes.push(`edge list clipped to maxEdgesPerConflict=${limits.maxEdgesPerConflict} (${edgesOmitted} edge(s) omitted)`)
          if (report.source === 'unknown') notes.push('build tool could not be identified from the text; Maven and Gradle grammar were both attempted')
          return envelope(report as unknown as JsonValue, bytesIn, notes, report.conflicts_omitted > 0 || edgesOmitted > 0)
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'java_stack_trace',
        group: 'jvm',
        description:
          'Parse a pasted Java exception or stack-trace chain: exception type and message, frames with class.method(file:line), the `Caused by:` chain, `Suppressed:` blocks, `... N more` folding resolved against the enclosing trace, the deepest application frame, and up to three likely-cause hints (NullPointerException, ClassNotFoundException, NoSuchMethodError, OutOfMemoryError variants, timeouts). Offline only: no log-file reads, no network. Refuses (throws) when the text exceeds maxInputBytes; prose lines that are not exception headers or frames are counted in unknown_lines with samples.',
        parameters: { text: TEXT_INPUT },
        result: STACK_TRACE_RESULT,
        run: (args, limits) => {
          const text = String(args.text)
          const bytesIn = assertWithinInput(text, limits.maxInputBytes, 'stack trace')
          const report = parseStackTrace(text, {
            maxExceptions: limits.maxExceptions,
            maxFramesPerException: limits.maxFramesPerException,
            sampleLimit: limits.sampleLimit,
          })
          const notes: string[] = []
          if (report.unknown_lines > 0) {
            notes.push(`${report.unknown_lines} of ${report.total_lines} line(s) were neither exception headers nor frames (coverage ${(report.coverage * 100).toFixed(1)}%)`)
          }
          if (report.folded_frames_unresolved > 0) {
            notes.push(`${report.folded_frames_unresolved} frame(s) hidden behind \`... N more\` could not be resolved because the enclosing trace was truncated or absent`)
          }
          if (report.exceptions_omitted > 0) notes.push(`exception chain clipped to maxExceptions=${limits.maxExceptions} (${report.exceptions_omitted} omitted)`)
          if (report.frames_omitted > 0) notes.push(`frame list clipped to maxFramesPerException=${limits.maxFramesPerException} (${report.frames_omitted} frame(s) omitted)`)
          if (report.exception_count === 0) notes.push('no exception header matched; the input may be a log line rather than a Java stack trace')
          // `truncated` means a *budget* clipped something. A fold the input
          // itself printed (`... 15 more`) is evidence about the report, not an
          // effect of our limits, so it is carried by the note alone.
          const clipped = report.exceptions_omitted > 0 || report.frames_omitted > 0
          return envelope(report as unknown as JsonValue, bytesIn, notes, clipped)
        },
      },
      opts,
    ),
    defineReceiptTool(
      {
        name: 'spring_config_diff',
        group: 'jvm',
        description:
          'Diff two pasted Spring configuration documents (`application.yml` or `.properties`) key by key after flattening both to dotted keys, classifying each difference as add, remove or change. Values whose key matches password|secret|token|key|credential are replaced with *** before they reach the payload. Offline only: no environment variable reads, no profile resolution, no placeholder substitution. Refuses (throws) when either document exceeds maxInputBytes; unparsable lines are returned in `errors` with line numbers and the result is still successful.',
        parameters: {
          left: { type: 'string', required: true, description: 'Original document, passed inline.' },
          right: { type: 'string', required: true, description: 'Revised document, passed inline.' },
          dialect: {
            type: 'string',
            enum: ['auto', 'yaml', 'properties'],
            description: 'Force one dialect for both documents; auto detects per side (default).',
          },
        },
        result: CONFIG_DIFF_RESULT,
        run: (args, limits) => {
          const left = String(args.left)
          const right = String(args.right)
          const bytesIn =
            assertWithinInput(left, limits.maxInputBytes, 'left document') + assertWithinInput(right, limits.maxInputBytes, 'right document')
          const dialect = args.dialect === 'yaml' || args.dialect === 'properties' ? args.dialect : 'auto'
          const report = diffSpringConfig(left, right, { maxChanges: limits.maxChanges, maxKeys: limits.maxKeys, sampleLimit: limits.sampleLimit }, dialect)
          const notes: string[] = []
          if (report.changes_omitted > 0) notes.push(`difference list clipped to maxChanges=${limits.maxChanges} (${report.changes_omitted} omitted)`)
          if (report.errors.length > 0) notes.push(`${report.errors.length} line(s) failed to parse; see errors[]`)
          return envelope(report as unknown as JsonValue, bytesIn, notes, report.changes_omitted > 0)
        },
      },
      opts,
    ),
  ]
  return tools.filter((tool): tool is NonNullable<typeof tool> => tool !== undefined)
}
