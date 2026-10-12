/**
 * dsh-jvm-doctor — offline-only JVM production-report diagnostics for DeepSeek
 * Harness.
 *
 * Registers a family of deterministic parsers for the reports an operator
 * already has in hand: thread dumps, GC logs, dependency trees, exception
 * chains and Spring configuration. Every tool is pure: no `jcmd`, no `jstack`,
 * no network, no filesystem, no clock, no randomness. Every result carries byte
 * accounting and honest parse-coverage fields, and every budget refusal is
 * explicit.
 * @module dsh-jvm-doctor
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveLimits } from './limits.ts'
import { createTools } from './tools.ts'

export const name = 'jvm-doctor'

/** Requires the tool registry before `apply` runs. */
export const inject = ['tools']

export { Config }
export type { Config as JvmDoctorConfig } from './limits.ts'
export { resolveLimits, DEFAULT_LIMITS } from './limits.ts'
export type { Limits } from './limits.ts'
export { createTools, defineReceiptTool, compileParameters } from './tools.ts'
export type { ToolBody, ToolGroup, ToolFactoryOptions } from './tools.ts'
export { parseThreadDump, THREAD_DUMP_PARSER_VERSION } from './core/thread-dump.ts'
export type { ThreadDumpReport, DumpThread, DeadlockCycle } from './core/thread-dump.ts'
export { parseGcLog, GC_LOG_PARSER_VERSION, percentile } from './core/gc-log.ts'
export type { GcLogReport, GcEvent } from './core/gc-log.ts'
export { parseDependencyText, DEPS_PARSER_VERSION } from './core/deps.ts'
export type { DependencyReport, DependencyConflict } from './core/deps.ts'
export { parseStackTrace, STACK_TRACE_PARSER_VERSION } from './core/stacktrace.ts'
export type { StackTraceReport, TraceException } from './core/stacktrace.ts'
export { diffSpringConfig, SPRING_CONFIG_PARSER_VERSION } from './core/spring-config.ts'
export type { ConfigDiffReport } from './core/spring-config.ts'

/**
 * Register every enabled tool. Registration is effect-based, so unloading the
 * plugin unregisters the tools.
 * @param ctx - plugin context.
 * @param config - user configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = resolveLimits(config)
  const only = config.only ?? []
  const prefix = config.toolPrefix ?? ''
  for (const definition of createTools({ limits, prefix, only })) {
    ctx.tools.register(definition)
  }
}
