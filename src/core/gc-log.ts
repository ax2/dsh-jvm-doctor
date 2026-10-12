/**
 * Deterministic parser for JVM GC logs, covering both JEP 158 unified logging
 * (`-Xlog:gc`) and the legacy pre-JDK 9 collector lines.
 *
 * The two grammars differ enough that a single regular expression is hopeless,
 * so they are separated here and every classified line is tagged with the syntax
 * family it came from — which is what makes `unknown_lines` honest.
 * @module dsh-jvm-doctor/core/gc-log
 */
import { confidenceOf, coverage, toLines } from './lines.ts'

/** Parser revision, bumped whenever the accepted grammar changes. */
export const GC_LOG_PARSER_VERSION = '1'

/** Syntax family of one recognized line. */
export type GcSyntax = 'unified' | 'legacy' | 'decorator'

/** Collector generation a pause belongs to. */
export type GcGeneration = 'young' | 'full_concurrent' | 'full' | 'mixed' | 'concurrent' | 'other'

/** One GC event recovered from the log. */
export interface GcEvent {
  /** 1-based source line. */
  line: number
  /** Syntax family that produced this event. */
  syntax: GcSyntax
  /** Unified-logging GC id, or `null` for legacy lines. */
  gc_id: number | null
  /** Pause reason, e.g. `Allocation Failure` or `G1 Evacuation Pause`. */
  reason: string
  /** Collector generation. */
  generation: GcGeneration
  /** `true` for stop-the-world pauses, `false` for concurrent phases. */
  pause: boolean
  /** Pause duration from the line itself, when the JVM printed one. */
  pause_ms: number | null
  /**
   * Which construct on the line supplied {@link pause_ms}. `none` means the line
   * printed no duration at all, so consumers can tell a measured pause from an
   * unmeasured one instead of reading `null` as zero.
   */
  pause_source: 'inline' | 'trailing_secs' | 'times_real' | 'none'
  /** Heap used before the cycle. */
  heap_before_bytes: number | null
  /** Heap used after the cycle. */
  heap_after_bytes: number | null
  /** Committed or reserved heap capacity. */
  heap_total_bytes: number | null
  /** Sample of the trailing decorator text, kept short for `non_gc_lines`. */
  detail: string
}

/** Summary of one distinct pause reason. */
export interface GcCauseSummary {
  /** Reason text. */
  reason: string
  /** Number of events carrying it. */
  count: number
  /** Mean pause in milliseconds across events that printed a duration. */
  mean_pause_ms: number | null
  /** Largest pause in milliseconds. */
  max_pause_ms: number | null
}

/** Canonical payload of the `java_gc_log` tool. */
export interface GcLogReport {
  /** Parser revision. */
  parser_version: string
  /** Total lines in the input. */
  total_lines: number
  /** Lines attributed to a known GC shape. */
  parsed_lines: number
  /** Lines that matched no known shape. */
  unknown_lines: number
  /** Up to five unknown lines, verbatim. */
  unknown_samples: string[]
  /** Fraction of lines recognized, in `[0, 1]`. */
  coverage: number
  /** Honest confidence label. */
  confidence: 'high' | 'medium' | 'low'
  /** Number of GC events recovered. */
  gc_event_count: number
  /** Recognized lines that are not themselves events (decorators, heap dumps). */
  non_gc_lines: number
  /** Events that are stop-the-world pauses. */
  pause_count: number
  /** Sum of pause durations, in milliseconds. */
  total_pause_ms: number
  /** Mean pause duration, in milliseconds. */
  mean_pause_ms: number | null
  /** Largest pause duration, in milliseconds. */
  max_pause_ms: number | null
  /** Pause percentiles over the sampled pause list. */
  pause_percentiles: { p50_ms: number; p90_ms: number; p99_ms: number; max_ms: number } | null
  /** Pauses used for the percentile computation. */
  pause_samples: number
  /** True when the percentile list was clipped to the configured budget. */
  pause_percentiles_sampled: boolean
  /** Young-collection pause count. */
  young_pause_count: number
  /** Full-collection pause count. */
  full_pause_count: number
  /** Concurrent (non-pausing) cycle count. */
  concurrent_cycle_count: number
  /** Smallest heap-used value seen at cycle start. */
  heap_before_min_bytes: number | null
  /** Largest heap-used value seen at cycle start. */
  heap_before_max_bytes: number | null
  /** Smallest heap-used value seen at cycle end. */
  heap_after_min_bytes: number | null
  /** Largest heap-used value seen at cycle end. */
  heap_after_max_bytes: number | null
  /** Largest committed/reserved heap capacity seen. */
  heap_total_max_bytes: number | null
  /** Pause reason histogram. */
  cause_histogram: GcCauseSummary[]
  /** Unique reason strings seen. */
  unique_causes: number
  /** Reasons dropped from `cause_histogram` because `maxGcEvents` clipped it. */
  causes_omitted: number
  /** Estimated allocation rate derived from the first-to-last timestamp span. */
  estimated_allocation_rate: {
    /** Bytes allocated per second. */
    bytes_per_second: number
    /** Bytes allocated per hour. */
    bytes_per_hour: number
    /** Observed log span in seconds. */
    window_seconds: number
    /** Number of events with a wall-clock timestamp. */
    events_with_timestamp: number
    /** How the estimate was derived. */
    method: string
  } | null
  /** Confirmed promotion failures (`to-space exhausted`, `Promotion failed`). */
  promotion_failures: number
  /** Events whose cause is `Allocation Failure`. */
  allocation_failures: number
  /** Events whose cause is `Metadata GC Threshold`. */
  metadata_gc_threshold_events: number
  /** `to-space exhausted` / `to-space overflow` events. */
  to_space_exhausted_events: number
  /** Human-readable warnings derived only from the parsed numbers. */
  findings: string[]
}

/** Budgets that bound the GC report. */
export interface GcLogLimits {
  /** Maximum GC events serialized. */
  maxGcEvents: number
  /** Maximum pauses kept for percentile computation. */
  maxPauseSamples: number
  /** Maximum unknown-line samples. */
  sampleLimit: number
}

// Group names must be unique inside one pattern, so each heap figure gets its
// own numbered groups and the unit is split off the captured token afterwards.
const PAUSE_SIZE = (index: number): string => `(?<v${index}>\\d+(?:\\.\\d+)?)(?<u${index}>[KMGTP]?)(?:i?B)?`
const UNIFIED_PAUSE_RE = new RegExp(
  `GC\\((?<id>\\d+)\\)\\s+(?<reason>.+?)\\s+${PAUSE_SIZE(0)}->${PAUSE_SIZE(1)}\\(${PAUSE_SIZE(2)}\\)\\s+(?<pause>\\d+(?:\\.\\d+)?)ms`,
)
const LEGACY_PAUSE_RE = new RegExp(`${PAUSE_SIZE(0)}->${PAUSE_SIZE(1)}\\(${PAUSE_SIZE(2)}\\)(?:,\\s*(?<pause>\\d+(?:\\.\\d+)?)\\s*secs)?`)
const LEGACY_OPEN_RE = /\[(?<kind>GC|Full GC)\s*\((?<reason>[^)\]]*)\)/u
const UNIFIED_START_RE = /^(?:\d+(?:\.\d+)?s?:)?(?:\[[^\]]*\]\s*)*GC\((?<id>\d+)\)/u
const UPTIME_PREFIX_RE = /^\d+\.\d{2,}s?:\s*/u
const FIRST_DECORATOR_RE = /^\[(?<time>[^\]]+)\]/u
/** Unified logging tag pair `[time][info][gc]`; the `[gc]` tag marks GC output. */
const UNIFIED_DECORATOR_RE = /^\[[^\]]+\]\[[^\]]*\]\[(?<tag>gc|gc,)?[^\]]*\]/iu
/**
 * Legacy logs state the pause several ways on one line: inline after the heap
 * transition (`..., 0.0031234 secs]`), after the trailing `[Metaspace: ...]`
 * decorator, or only as the wall-clock `real=` field of `[Times: ...]`. They
 * measure the same pause, so the first present source wins and the coarse
 * `real=` value is the last resort.
 */
const LEGACY_PAUSE_SECS_RE = /\],\s*(?<pause>\d+(?:\.\d+)?)\s*secs\]/u
const LEGACY_TIMES_RE = /\[Times:\s*[^\]]*?real=(?<real>\d+(?:\.\d+)?)\s*secs?/iu
const LEGACY_PREFIX_RE = /\[(?:(?:Full|ParNew|PS|G1|CMS|DefNew|Tenured|Copy|MarkSweep|Metaspace|Age|Times|CMS-concurrent)[^\]]*|[0-9.]+ secs)\]/iu

/** Scale a `<number><unit>` pair from a GC line to bytes. */
export function sizeToBytes(value: string, unit: string): number {
  const scale: Record<string, number> = { '': 1, B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }
  const factor = scale[unit.toUpperCase()] ?? 1
  return Math.round(Number.parseFloat(value) * factor)
}

/** Derive the collector generation from the pause reason. */
export function generationOf(reason: string): GcGeneration {
  if (/to-space (?:exhausted|overflow)/iu.test(reason)) return 'full'
  if (/Full|MarkSweepCompact|MarkSweep|Compacting|ConcurrentMarkSweep|CMS Initial Mark/iu.test(reason)) {
    if (/CMS-concurrent|concurrent-/iu.test(reason)) return 'concurrent'
    return 'full'
  }
  if (/Mixed/iu.test(reason)) return 'mixed'
  if (/Young|Allocation Failure|Evacuation|Scavenge|ParNew|DefNew|Copy/iu.test(reason)) return 'young'
  if (/Initial Mark|Remark|Cleanup|Concurrent/iu.test(reason)) return 'concurrent'
  return 'other'
}

function isoFromMatch(match: RegExpExecArray): string | null {
  const candidate = match.groups?.time ?? null
  if (candidate !== null && /^\d{4}-\d{2}-\d{2}T/u.test(candidate)) return candidate
  for (let index = 1; index < match.length; index += 1) {
    const value = match[index]
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value)) return value
  }
  return null
}

/**
 * Parse a pasted GC log.
 * @param text - raw log text.
 * @param limits - report budgets.
 */
export function parseGcLog(text: string, limits: GcLogLimits): GcLogReport {
  const lines = toLines(text)
  const consumed = new Set<number>()
  const events: GcEvent[] = []
  const timestamps: { seconds: number; heapAfter: number | null }[] = []
  let nonGcLines = 0

  for (const line of lines) {
    const trimmed = line.text.trim()
    if (trimmed.length === 0) {
      consumed.add(line.number)
      continue
    }
    // Legacy `[GC (reason) ...]` must win over the unified `GC(id)` shape: an
    // explicit bracket marker is the discriminator between the two grammars.
    const legacyOpen = LEGACY_OPEN_RE.exec(trimmed)
    const gcStart = UNIFIED_START_RE.exec(trimmed)
    let syntax: GcSyntax | null = null
    let time: string | null = null
    if (legacyOpen !== null || /^\[Full GC\s*\(/u.test(trimmed)) {
      syntax = 'legacy'
    } else if (gcStart !== null) {
      syntax = 'unified'
      const decorated = FIRST_DECORATOR_RE.exec(trimmed)
      if (decorated !== null) time = isoFromMatch(decorated)
    } else if (UPTIME_PREFIX_RE.test(trimmed) && /\[(?:GC|Full GC)\s*\(/u.test(trimmed)) {
      syntax = 'legacy'
    }

    if (syntax === 'unified') {
      consumed.add(line.number)
      const pause = UNIFIED_PAUSE_RE.exec(trimmed)
      if (pause?.groups?.reason !== undefined) {
        const groups = pause.groups
        const reason = groups.reason!.trim()
        events.push({
          line: line.number,
          syntax,
          gc_id: groups.id !== undefined ? Number(groups.id) : null,
          reason,
          generation: generationOf(reason),
          pause: true,
          pause_ms: groups.pause !== undefined ? Number.parseFloat(groups.pause) : null,
          pause_source: groups.pause !== undefined ? 'inline' : 'none',
          heap_before_bytes: sizeToBytes(groups.v0 ?? '0', groups.u0 ?? ''),
          heap_after_bytes: sizeToBytes(groups.v1 ?? '0', groups.u1 ?? ''),
          heap_total_bytes: sizeToBytes(groups.v2 ?? '0', groups.u2 ?? ''),
          detail: trimmed.slice(0, 120),
        })
      } else {
        const concurrent = /GC\((?<id>\d+)\)\s+(?<reason>.+?)(?:\s+\d+(?:\.\d+)?ms)?$/u.exec(trimmed)
        const reason = concurrent?.groups?.reason?.trim() ?? trimmed.slice(0, 120)
        events.push({
          line: line.number,
          syntax,
          gc_id: concurrent?.groups?.id !== undefined ? Number(concurrent.groups.id) : null,
          reason: /^Pause\b/u.test(reason) ? 'Pause (unparsed tail)' : reason,
          generation: generationOf(reason),
          pause: false,
          pause_ms: null,
          pause_source: 'none',
          heap_before_bytes: null,
          heap_after_bytes: null,
          heap_total_bytes: null,
          detail: trimmed.slice(0, 120),
        })
      }
      if (time !== null) {
        const seconds = Date.parse(time)
        if (Number.isFinite(seconds)) timestamps.push({ seconds: seconds / 1000, heapAfter: events[events.length - 1]?.heap_after_bytes ?? null })
      }
      continue
    }

    if (syntax === 'legacy') {
      consumed.add(line.number)
      const open = legacyOpen
      const pause = LEGACY_PAUSE_RE.exec(trimmed)
      const kind = open?.groups?.kind ?? (/^\[Full GC\s*\(/u.test(trimmed) ? 'Full GC' : 'GC')
      const reason = open?.groups?.reason?.trim() ?? ''
      const generation = generationOf(`${kind} ${reason}`)
      const groups = pause?.groups
      const seconds = LEGACY_PAUSE_SECS_RE.exec(trimmed)
      const times = LEGACY_TIMES_RE.exec(trimmed)
      const inlineMs = groups?.pause !== undefined ? Number.parseFloat(groups.pause) * 1000 : null
      const secondsMs = seconds?.groups?.pause !== undefined ? Number.parseFloat(seconds.groups.pause) * 1000 : null
      const realMs = times?.groups?.real !== undefined ? Number.parseFloat(times.groups.real) * 1000 : null
      const pauseMs = inlineMs ?? secondsMs ?? realMs
      events.push({
        line: line.number,
        syntax,
        gc_id: null,
        reason: reason.length > 0 ? reason : kind,
        generation,
        pause: true,
        pause_ms: pauseMs,
        pause_source: inlineMs !== null ? 'inline' : secondsMs !== null ? 'trailing_secs' : realMs !== null ? 'times_real' : 'none',
        heap_before_bytes: groups?.v0 !== undefined ? sizeToBytes(groups.v0, groups.u0 ?? '') : null,
        heap_after_bytes: groups?.v1 !== undefined ? sizeToBytes(groups.v1, groups.u1 ?? '') : null,
        heap_total_bytes: groups?.v2 !== undefined ? sizeToBytes(groups.v2, groups.u2 ?? '') : null,
        detail: trimmed.slice(0, 120),
      })
      continue
    }

    if (LEGACY_PREFIX_RE.test(trimmed)) {
      // Decorator-only legacy lines (survivor age tables, `Times: user=...`,
      // concurrent-phase markers) carry no heap transition.
      consumed.add(line.number)
      nonGcLines += 1
      continue
    }

    if (UNIFIED_DECORATOR_RE.test(trimmed)) {
      // Unified logging emits JVM configuration on the same `[gc]` tag stream
      // (`Using G1`, `Periodic GC enabled`). Those lines are recognized as
      // non-GC output rather than reported as unknown syntax.
      consumed.add(line.number)
      nonGcLines += 1
      continue
    }

    // A unified line whose decorator names the GC tag but whose body matched no
    // pause shape is a real gap: leave it unconsumed so coverage reports it.
  }

  // ------------------------------------------------------------- summaries ---
  const pauses = events.filter((event) => event.pause && event.pause_ms !== null).map((event) => event.pause_ms as number)
  const sampled = pauses.length > limits.maxPauseSamples ? pauses.slice(0, limits.maxPauseSamples) : pauses
  const sorted = [...sampled].sort((left, right) => left - right)
  const totalPause = pauses.reduce((sum, value) => sum + value, 0)
  const percentiles =
    sorted.length === 0
      ? null
      : {
          p50_ms: round3(percentile(sorted, 50)),
          p90_ms: round3(percentile(sorted, 90)),
          p99_ms: round3(percentile(sorted, 99)),
          max_ms: round3(sorted[sorted.length - 1] as number),
        }

  const heapBefore = valuesOf(events, (event) => event.heap_before_bytes)
  const heapAfter = valuesOf(events, (event) => event.heap_after_bytes)
  const heapTotal = valuesOf(events, (event) => event.heap_total_bytes)

  const causes = new Map<string, { count: number; pauses: number[] }>()
  for (const event of events) {
    const bucket = causes.get(event.reason) ?? { count: 0, pauses: [] }
    bucket.count += 1
    if (event.pause_ms !== null) bucket.pauses.push(event.pause_ms)
    causes.set(event.reason, bucket)
  }
  const causeHistogram: GcCauseSummary[] = [...causes.entries()]
    .map(([reason, bucket]) => ({
      reason,
      count: bucket.count,
      mean_pause_ms:
        bucket.pauses.length > 0 ? round3(bucket.pauses.reduce((sum, value) => sum + value, 0) / bucket.pauses.length) : null,
      max_pause_ms: bucket.pauses.length > 0 ? round3(Math.max(...bucket.pauses)) : null,
    }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))

  let allocation: GcLogReport['estimated_allocation_rate'] = null
  if (timestamps.length >= 2) {
    const first = timestamps[0] as { seconds: number }
    const last = timestamps[timestamps.length - 1] as { seconds: number }
    const windowSeconds = last.seconds - first.seconds
    let allocated = 0
    let samples = 0
    for (let index = 1; index < timestamps.length; index += 1) {
      const previous = timestamps[index - 1] as { heapAfter: number | null }
      const current = timestamps[index] as { heapAfter: number | null }
      if (previous.heapAfter === null || current.heapAfter === null) continue
      const delta = current.heapAfter - previous.heapAfter
      if (delta > 0) {
        allocated += delta
        samples += 1
      }
    }
    if (windowSeconds > 0 && samples > 0) {
      const perSecond = allocated / windowSeconds
      allocation = {
        bytes_per_second: Math.round(perSecond),
        bytes_per_hour: Math.round(perSecond * 3600),
        window_seconds: round3(windowSeconds),
        events_with_timestamp: timestamps.length,
        method: 'sum of positive post-GC heap deltas divided by the first-to-last timestamp span',
      }
    }
  }

  const cover = coverage(lines, consumed, limits.sampleLimit)
  const promotionFailures = events.filter((event) => /to-space (?:exhausted|overflow)|Promotion failed/iu.test(event.reason)).length
  const allocationFailures = events.filter((event) => /Allocation Failure/iu.test(event.reason)).length
  const metadataEvents = events.filter((event) => /Metadata GC Threshold/iu.test(event.reason)).length
  const toSpaceEvents = events.filter((event) => /to-space (?:exhausted|overflow)/iu.test(event.reason)).length
  const fullPauses = events.filter((event) => event.pause && (event.generation === 'full' || event.generation === 'full_concurrent')).length
  const youngPauses = events.filter((event) => event.pause && (event.generation === 'young' || event.generation === 'mixed')).length
  const concurrentCycles = events.filter((event) => !event.pause).length
  const findings = deriveFindings({ fullPauses, promotionFailures, metadataEvents, percentiles, heapBefore, heapTotal })

  return {
    parser_version: GC_LOG_PARSER_VERSION,
    total_lines: lines.length,
    parsed_lines: cover.parsed,
    unknown_lines: cover.unknown,
    unknown_samples: cover.samples,
    coverage: Number(cover.ratio.toFixed(4)),
    confidence: confidenceOf(cover.ratio, events.length === 0 ? 'suspicious' : 'neutral'),
    gc_event_count: events.length,
    non_gc_lines: nonGcLines,
    pause_count: pauses.length,
    total_pause_ms: round3(totalPause),
    mean_pause_ms: pauses.length > 0 ? round3(totalPause / pauses.length) : null,
    max_pause_ms: pauses.length > 0 ? round3(Math.max(...pauses)) : null,
    pause_percentiles: percentiles,
    pause_samples: sampled.length,
    pause_percentiles_sampled: sampled.length !== pauses.length,
    young_pause_count: youngPauses,
    full_pause_count: fullPauses,
    concurrent_cycle_count: concurrentCycles,
    heap_before_min_bytes: heapBefore.min,
    heap_before_max_bytes: heapBefore.max,
    heap_after_min_bytes: heapAfter.min,
    heap_after_max_bytes: heapAfter.max,
    heap_total_max_bytes: heapTotal.max,
    cause_histogram: causeHistogram.slice(0, limits.maxGcEvents),
    unique_causes: causeHistogram.length,
    causes_omitted: Math.max(0, causeHistogram.length - limits.maxGcEvents),
    estimated_allocation_rate: allocation,
    promotion_failures: promotionFailures,
    allocation_failures: allocationFailures,
    metadata_gc_threshold_events: metadataEvents,
    to_space_exhausted_events: toSpaceEvents,
    findings,
  }
}

function deriveFindings(input: {
  fullPauses: number
  promotionFailures: number
  metadataEvents: number
  percentiles: { p50_ms: number; p90_ms: number; p99_ms: number; max_ms: number } | null
  heapBefore: { min: number | null; max: number | null }
  heapTotal: { min: number | null; max: number | null }
}): string[] {
  const findings: string[] = []
  if (input.promotionFailures > 0) {
    findings.push(`${input.promotionFailures} promotion failure(s): the young generation could not be evacuated, so the collector degraded to a full GC`)
  }
  if (input.metadataEvents > 0) {
    findings.push(`${input.metadataEvents} pause(s) triggered by Metadata GC Threshold: class-loader or metaspace pressure is forcing collections`)
  }
  if (input.fullPauses > 0) {
    findings.push(`${input.fullPauses} full-collection pause(s) present; check old-generation occupancy and humongous allocations`)
  }
  if (
    input.percentiles !== null &&
    input.heapBefore.max !== null &&
    input.heapTotal.max !== null &&
    input.heapTotal.max > 0
  ) {
    const occupancy = input.heapBefore.max / input.heapTotal.max
    if (occupancy >= 0.9) {
      findings.push(`heap occupancy reached ${(occupancy * 100).toFixed(1)}% before a collection: collections are running close to exhaustion`)
    }
  }
  return findings
}

function valuesOf(events: readonly GcEvent[], pick: (event: GcEvent) => number | null): { min: number | null; max: number | null } {
  let min: number | null = null
  let max: number | null = null
  for (const event of events) {
    const value = pick(event)
    if (value === null) continue
    if (min === null || value < min) min = value
    if (max === null || value > max) max = value
  }
  return { min, max }
}

/** Nearest-rank percentile with linear interpolation inside the rank gap. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0] as number
  const position = (fraction / 100) * (sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const low = sorted[lower] as number
  const high = sorted[upper] as number
  return low + (high - low) * (position - lower)
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
