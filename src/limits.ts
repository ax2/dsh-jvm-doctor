/**
 * Plugin configuration and the per-call budgets derived from it.
 * @module dsh-jvm-doctor/limits
 */
import z from '@deepseek-ai/schemastery'

/** Effective budgets for one plugin instance. */
export interface Limits {
  /** Hard ceiling on one pasted report, in UTF-8 bytes. */
  maxInputBytes: number
  /** Soft ceiling on a rendered result, in UTF-8 bytes. */
  maxOutputBytes: number
  /** Ceiling on thread summaries serialized by `java_thread_dump`. */
  maxThreads: number
  /** Ceiling on status lines serialized by `java_thread_dump`. */
  maxStatusLines: number
  /** Ceiling on lock-contention cohorts reported by `java_thread_dump`. */
  maxContention: number
  /** Ceiling on non-pause GC lines serialized by `java_gc_log`. */
  maxGcEvents: number
  /** Ceiling on pause durations kept for percentile computation. */
  maxPauseSamples: number
  /** Ceiling on conflicting artifacts reported by `java_dependency_conflicts`. */
  maxConflicts: number
  /** Ceiling on edges serialized per conflicting artifact. */
  maxEdgesPerConflict: number
  /** Ceiling on exceptions serialized by `java_stack_trace`. */
  maxExceptions: number
  /** Ceiling on frames serialized per exception. */
  maxFramesPerException: number
  /** Ceiling on differences reported by `spring_config_diff`. */
  maxChanges: number
  /** Ceiling on flattened keys read per configuration document. */
  maxKeys: number
  /** Ceiling on handwritten unknown-line samples. */
  sampleLimit: number
}

/** Default budgets: generous enough for one pasted production report. */
export const DEFAULT_LIMITS: Limits = {
  maxInputBytes: 2_097_152,
  maxOutputBytes: 262_144,
  maxThreads: 200,
  maxStatusLines: 40,
  maxContention: 20,
  maxGcEvents: 500,
  maxPauseSamples: 5_000,
  maxConflicts: 100,
  maxEdgesPerConflict: 20,
  maxExceptions: 25,
  maxFramesPerException: 60,
  maxChanges: 500,
  maxKeys: 5_000,
  sampleLimit: 5,
}

/** User-facing configuration. */
export interface Config {
  /** Hard ceiling on one pasted report, in UTF-8 bytes. */
  maxInputBytes?: number
  /** Soft ceiling on a rendered result, in UTF-8 bytes. */
  maxOutputBytes?: number
  /** Ceiling on thread summaries serialized by `java_thread_dump`. */
  maxThreads?: number
  /** Ceiling on status lines serialized by `java_thread_dump`. */
  maxStatusLines?: number
  /** Ceiling on lock-contention cohorts reported by `java_thread_dump`. */
  maxContention?: number
  /** Ceiling on GC events serialized by `java_gc_log`. */
  maxGcEvents?: number
  /** Ceiling on pause durations kept for percentile computation. */
  maxPauseSamples?: number
  /** Ceiling on conflicting artifacts reported by `java_dependency_conflicts`. */
  maxConflicts?: number
  /** Ceiling on edges serialized per conflicting artifact. */
  maxEdgesPerConflict?: number
  /** Ceiling on exceptions serialized by `java_stack_trace`. */
  maxExceptions?: number
  /** Ceiling on frames serialized per exception. */
  maxFramesPerException?: number
  /** Ceiling on differences reported by `spring_config_diff`. */
  maxChanges?: number
  /** Ceiling on flattened keys read per configuration document. */
  maxKeys?: number
  /** Ceiling on unknown-line samples attached to every parse receipt. */
  sampleLimit?: number
  /** Tool-name prefix, e.g. `jvm` yields `jvm__java_thread_dump`. Empty by default. */
  toolPrefix?: string
  /** Register only these tool names (empty or omitted registers every tool). */
  only?: string[]
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  maxInputBytes: z.natural().default(2_097_152).description('Hard ceiling on one pasted report, in UTF-8 bytes.'),
  maxOutputBytes: z.natural().default(262_144).description('Soft ceiling on rendered results, in UTF-8 bytes.'),
  maxThreads: z.natural().default(200).description('Thread summaries serialized by java_thread_dump.'),
  maxStatusLines: z.natural().default(40).description('Thread status lines serialized by java_thread_dump.'),
  maxContention: z.natural().default(20).description('Lock-contention cohorts reported by java_thread_dump.'),
  maxGcEvents: z.natural().default(500).description('GC cause/event rows serialized by java_gc_log.'),
  maxPauseSamples: z.natural().default(5_000).description('Pause durations used for GC percentiles.'),
  maxConflicts: z.natural().default(100).description('Conflicting artifacts reported by java_dependency_conflicts.'),
  maxEdgesPerConflict: z.natural().default(20).description('Edges serialized per conflicting artifact.'),
  maxExceptions: z.natural().default(25).description('Exceptions serialized by java_stack_trace.'),
  maxFramesPerException: z.natural().default(60).description('Frames serialized per exception.'),
  maxChanges: z.natural().default(500).description('Differences reported by spring_config_diff.'),
  maxKeys: z.natural().default(5_000).description('Flattened keys read per configuration document.'),
  sampleLimit: z.natural().default(5).description('Unknown-line samples attached to every parse receipt.'),
  toolPrefix: z.string().default('').description('Optional prefix for registered tool names.'),
  only: z.array(z.string()).default([]).description('Register only these tool names; empty registers every tool.'),
})

/**
 * Merge user configuration over the defaults. Non-finite, zero and negative
 * values fall back to the default so a bad profile cannot disable a budget.
 * @param config - user configuration, possibly empty.
 */
export function resolveLimits(config: Config = {}): Limits {
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  return {
    maxInputBytes: pick(config.maxInputBytes, DEFAULT_LIMITS.maxInputBytes),
    maxOutputBytes: pick(config.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
    maxThreads: pick(config.maxThreads, DEFAULT_LIMITS.maxThreads),
    maxStatusLines: pick(config.maxStatusLines, DEFAULT_LIMITS.maxStatusLines),
    maxContention: pick(config.maxContention, DEFAULT_LIMITS.maxContention),
    maxGcEvents: pick(config.maxGcEvents, DEFAULT_LIMITS.maxGcEvents),
    maxPauseSamples: pick(config.maxPauseSamples, DEFAULT_LIMITS.maxPauseSamples),
    maxConflicts: pick(config.maxConflicts, DEFAULT_LIMITS.maxConflicts),
    maxEdgesPerConflict: pick(config.maxEdgesPerConflict, DEFAULT_LIMITS.maxEdgesPerConflict),
    maxExceptions: pick(config.maxExceptions, DEFAULT_LIMITS.maxExceptions),
    maxFramesPerException: pick(config.maxFramesPerException, DEFAULT_LIMITS.maxFramesPerException),
    maxChanges: pick(config.maxChanges, DEFAULT_LIMITS.maxChanges),
    maxKeys: pick(config.maxKeys, DEFAULT_LIMITS.maxKeys),
    sampleLimit: pick(config.sampleLimit, DEFAULT_LIMITS.sampleLimit),
  }
}
