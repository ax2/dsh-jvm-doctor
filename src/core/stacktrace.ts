/**
 * Deterministic parser for Java exception / stack-trace chains.
 *
 * `... N more` folding is the one thing a naive line reader gets wrong: the
 * omitted frames belong to the *enclosing* trace, so the parser resolves the
 * fold against the parent frame list and reports how many frames that recovered.
 * @module dsh-jvm-doctor/core/stacktrace
 */
import { confidenceOf, coverage, toLines } from './lines.ts'

/** Parser revision, bumped whenever the accepted grammar changes. */
export const STACK_TRACE_PARSER_VERSION = '1'

/** One `at class.method(file:line)` frame. */
export interface TraceFrame {
  /** Fully qualified `class.method`. */
  method: string
  /** Source file, or `Unknown Source` / `Native Method`. */
  file: string
  /** 1-based line number when the JVM knew it. */
  line: number | null
  /** `true` when the frame is inside the JDK or a known framework. */
  library: boolean
  /** 1-based source line of the frame. */
  source_line: number
}

/** One exception in the `Caused by:` / `Suppressed:` chain. */
export interface TraceException {
  /** Fully qualified exception class. */
  type: string
  /** Simple class name. */
  simple_type: string
  /** Message text after the first `:`, or `null`. */
  message: string | null
  /** Relation to the enclosing exception. */
  relation: 'primary' | 'caused_by' | 'suppressed' | 'secondary'
  /** Zero-based position in the chain. */
  index: number
  /** 1-based source line of the header. */
  line: number
  /** Frames belonging to this exception, in printed order. */
  frames: TraceFrame[]
  /** Raw frame count including the frames hidden behind `... N more`. */
  frame_count: number
  /** `... N more` value, when printed. */
  folded_frames: number
  /** Frames the parser recovered from the enclosing trace for the fold. */
  folded_resolved: number
  /** Deepest application frame of this exception. */
  deepest_application_frame: string | null
  /** Up to three hints derived from the type, message and frames. */
  hints: string[]
  /** Nested exceptions printed by `` `Caused by` `` indentation, without a `Caused by:` header. */
  suppressed_lines: number
}

/** Canonical payload of the `java_stack_trace` tool. */
export interface StackTraceReport {
  /** Parser revision. */
  parser_version: string
  /** Total lines in the input. */
  total_lines: number
  /** Lines attributed to a known shape. */
  parsed_lines: number
  /** Lines that matched no known shape. */
  unknown_lines: number
  /** Up to five unknown lines, verbatim. */
  unknown_samples: string[]
  /** Fraction of lines recognized, in `[0, 1]`. */
  coverage: number
  /** Honest confidence label. */
  confidence: 'high' | 'medium' | 'low'
  /** Number of exceptions in the chain. */
  exception_count: number
  /** Root exception is the last `Caused by:` entry, or the primary exception. */
  root_cause: string | null
  /** Message of the primary exception. */
  primary_message: string | null
  /** The whole chain, outermost first. */
  chain: TraceException[]
  /** Frames printed across the whole chain, folds excluded. */
  total_frames: number
  /** Frames recovered from `... N more` folds. */
  folded_frames_resolved: number
  /** Frames still hidden because no enclosing trace was available. */
  folded_frames_unresolved: number
  /** Exceptions dropped because `maxExceptions` clipped the chain. */
  exceptions_omitted: number
  /** Frames dropped across the chain because `maxFramesPerException` clipped them. */
  frames_omitted: number
  /** Deepest application frame of the primary exception. */
  deepest_application_frame: string | null
  /** Distinct application frames across the chain, in first-seen order. */
  application_frames: string[]
  /** Library packages the parser hides from application frames. */
  library_prefixes: string[]
  /** Ordered, human-readable hints for the whole trace. */
  hints: string[]
  /** Whether a test-framework frame was detected. */
  test_failure: boolean
  /** Lines that were part of the trace but carried no frames or exception. */
  non_frame_lines: number
}

/** Budgets that bound the stack-trace report. */
export interface StackTraceLimits {
  /** Maximum exceptions serialized across the chain. */
  maxExceptions: number
  /** Maximum frames serialized per exception. */
  maxFramesPerException: number
  /** Maximum unknown-line samples. */
  sampleLimit: number
}

/** Packages treated as library code rather than application code. */
export const LIBRARY_PREFIXES: readonly string[] = ['java.', 'javax.', 'jdk.', 'sun.', 'com.sun.', 'org.springframework.']

const HEADER_RE = /^(?<prefix>Caused by:|Suppressed:)?\s*(?<type>(?:[\w$]+\.)+[\w$]+)(?::\s?(?<message>.*))?$/u
const FRAME_RE = /^\s*at\s+(?<method>.+?)(?:\((?<file>[^()]*)\))?$/u
const FOLD_RE = /^\s*\.\.\.\s+(?<count>\d+)\s+more\s*$/u
const TEST_FRAME_RE = /(?:junit|testng|org\.junit|org\.testng|kotlin\.test)/iu
const GENERATED_RE = /^\s*(?:Caused by:|Suppressed:)/u
const VERSIONED_CLASS_RE = /^[\w$]+(?:\.[\w$]+)+$/u

/**
 * Parse a pasted Java stack trace or exception chain.
 * @param text - raw trace text.
 * @param limits - report budgets.
 */
export function parseStackTrace(text: string, limits: StackTraceLimits): StackTraceReport {
  const lines = toLines(text)
  const consumed = new Set<number>()
  const chain: TraceException[] = []
  let current: TraceException | null = null
  let nonFrameLines = 0
  let unresolvedFolds = 0

  for (const line of lines) {
    const trimmed = line.text.trim()
    if (trimmed.length === 0) {
      consumed.add(line.number)
      continue
    }
    const fold = FOLD_RE.exec(trimmed)
    if (fold?.groups?.count !== undefined && current !== null) {
      const count = Number(fold.groups.count)
      // A fold repeats the tail of the *enclosing* trace. Only the immediately
      // enclosing exception is a sound donor: folding against a grandparent or a
      // sibling `Caused by:` would fabricate frames the JVM never printed, so a
      // fold that the enclosing trace cannot satisfy is reported as unresolved.
      const donor = current.index > 0 ? chain[current.index - 1] : undefined
      const recovered = donor === undefined ? 0 : Math.min(count, donor.frames.length)
      current.folded_frames = count
      current.folded_resolved = recovered
      if (donor !== undefined && recovered > 0) current.frames.push(...donor.frames.slice(donor.frames.length - recovered))
      current.frame_count = current.frames.length + (count - recovered)
      if (recovered < count) unresolvedFolds += count - recovered
      consumed.add(line.number)
      continue
    }
    const header = HEADER_RE.exec(trimmed)
    if (header?.groups?.type !== undefined && VERSIONED_CLASS_RE.test(header.groups.type)) {
      const prefixed = header.groups.prefix
      const relation: TraceException['relation'] =
        prefixed === 'Caused by:' ? 'caused_by' : prefixed === 'Suppressed:' ? 'suppressed' : chain.length === 0 ? 'primary' : 'secondary'
      const type = header.groups.type
      const exception: TraceException = {
        type,
        simple_type: type.slice(type.lastIndexOf('.') + 1),
        message: header.groups.message ?? null,
        relation,
        index: chain.length,
        line: line.number,
        frames: [],
        frame_count: 0,
        folded_frames: 0,
        folded_resolved: 0,
        deepest_application_frame: null,
        hints: [],
        suppressed_lines: relation === 'suppressed' ? 1 : 0,
      }
      chain.push(exception)
      current = exception
      consumed.add(line.number)
      continue
    }
    const frame = FRAME_RE.exec(line.text)
    if (frame?.groups?.method !== undefined && current !== null) {
      const location = frame.groups.file ?? ''
      const lineMatch = /:(?<line>\d+)$/u.exec(location)
      const method = frame.groups.method.trim()
      current.frames.push({
        method,
        file: location.replace(/:\d+$/u, ''),
        line: lineMatch?.groups?.line !== undefined ? Number(lineMatch.groups.line) : null,
        library: isLibraryFrame(method),
        source_line: line.number,
      })
      current.frame_count = current.frames.length
      consumed.add(line.number)
      continue
    }
    const tabbed = /^\s+at\s+/u.test(line.text)
    if (tabbed && current !== null) {
      consumed.add(line.number)
      continue
    }
    if (current !== null && /^(?:\.\.\.|at\s)/u.test(trimmed)) {
      consumed.add(line.number)
      nonFrameLines += 1
      continue
    }
  }

  for (const exception of chain) {
    exception.deepest_application_frame = deepestApplicationFrame(exception.frames)
    exception.hints = hintsFor(exception)
  }

  const allFrames = chain.flatMap((exception) => exception.frames)
  const applicationFrames: string[] = []
  for (const frame of allFrames) {
    if (frame.library) continue
    if (!applicationFrames.includes(frame.method)) applicationFrames.push(frame.method)
  }
  const cover = coverage(lines, consumed, limits.sampleLimit)
  const foldedResolved = chain.reduce((sum, exception) => sum + exception.folded_resolved, 0)
  // Most-chain-order hints first, then the outermost summary hints, so the
  // most specific diagnosis is never squeezed out by a generic one.
  const aggregateHints: string[] = []
  for (const exception of chain.slice().reverse()) {
    for (const hint of exception.hints) if (!aggregateHints.includes(hint)) aggregateHints.push(hint)
  }

  const testFailure = allFrames.some((frame) => TEST_FRAME_RE.test(frame.method))
  const rawConfidence = confidenceOf(cover.ratio, chain.length === 0 ? 'suspicious' : unresolvedFolds > 0 ? 'suspicious' : 'neutral')
  // Clipping is reported, never silent: a caller that loses exceptions or frames
  // to a budget must be able to see exactly how many disappeared.
  const kept = chain.slice(0, limits.maxExceptions).map((exception) => ({
    ...exception,
    frames: exception.frames.slice(0, limits.maxFramesPerException),
  }))
  const exceptionsOmitted = chain.length - kept.length
  const framesOmitted = kept.reduce((sum, exception, index) => sum + (chain[index]!.frames.length - exception.frames.length), 0)
  return {
    parser_version: STACK_TRACE_PARSER_VERSION,
    total_lines: lines.length,
    parsed_lines: cover.parsed,
    unknown_lines: cover.unknown,
    unknown_samples: cover.samples,
    coverage: Number(cover.ratio.toFixed(4)),
    // Unresolved folds mean frames are missing from the printed report, which is
    // weaker evidence than a clean parse even when every line was recognized.
    confidence: unresolvedFolds > 0 && rawConfidence === 'high' ? 'medium' : rawConfidence,
    exception_count: chain.length,
    root_cause: chain.length > 0 ? (chain[chain.length - 1] as TraceException).type : null,
    primary_message: chain[0]?.message ?? null,
    chain: kept,
    total_frames: allFrames.length,
    folded_frames_resolved: foldedResolved,
    folded_frames_unresolved: unresolvedFolds,
    exceptions_omitted: exceptionsOmitted,
    frames_omitted: framesOmitted,
    deepest_application_frame: chain[0] !== undefined ? deepestApplicationFrame(chain[0].frames) : null,
    application_frames: applicationFrames.slice(0, 50),
    library_prefixes: [...LIBRARY_PREFIXES],
    hints: aggregateHints.slice(0, 6),
    test_failure: testFailure,
    non_frame_lines: nonFrameLines,
  }
}

/** True when a frame belongs to the JDK or to a framework prefix. */
export function isLibraryFrame(method: string): boolean {
  return LIBRARY_PREFIXES.some((prefix) => method.startsWith(prefix))
}

/** First frame in printed order that is not library code. */
export function deepestApplicationFrame(frames: readonly TraceFrame[]): string | null {
  for (const frame of frames) {
    if (!frame.library && frame.method.length > 0) return frame.method
  }
  return null
}

/** Derive up to three honest hints from type, message and frames. */
export function hintsFor(exception: TraceException): string[] {
  const hints: string[] = []
  const type = exception.type
  const message = exception.message ?? ''
  const simple = exception.simple_type
  const frames = exception.frames
  const firstFrame = frames[0]?.method ?? null
  const appFrame = deepestApplicationFrame(frames)
  const callish = frames.find(
    (frame) => !/\.(?:get|getValue|valueOf|toString|intValue|asText)$/u.test(frame.method) && /\.(?:get[A-Z]\w*|get|valueOf|asText)\b/u.test(frame.method),
  )

  if (/^java\.lang\.NullPointerException$/u.test(type)) {
    const where = callish !== undefined ? callish.method : firstFrame
    hints.push(
      where !== null
        ? `NullPointerException dereferences a null receiver or return value at ${where}; inspect the value read on the line above that call`
        : 'NullPointerException: inspect the receiver of the first application frame for a null return value',
    )
  }
  if (/^java\.lang\.ClassNotFoundException$/u.test(type) || /^java\.lang\.NoClassDefFoundError$/u.test(type)) {
    hints.push(
      `${simple} for ${message || 'an unnamed class'}: the runtime classpath is missing this class at execution time even though it compiled; check the packaged artifact and the launcher classpath`,
    )
  }
  if (/^java\.lang\.NoSuchMethodError$/u.test(type) || /^java\.lang\.AbstractMethodError$/u.test(type) || /^java\.lang\.IncompatibleClassChangeError$/u.test(type)) {
    hints.push(
      `${simple} on ${message || 'an unnamed member'}: two versions of the same library are on the classpath; align the dependency versions (see java_dependency_conflicts)`,
    )
  }
  if (/^java\.lang\.OutOfMemoryError$/u.test(type)) {
    if (/heap space/iu.test(message)) {
      hints.push('OutOfMemoryError: Java heap space means live objects did not fit; take a heap histogram and check for unbounded caches or batch sizes')
    } else if (/Metaspace/iu.test(message)) {
      hints.push('OutOfMemoryError: Metaspace means class metadata did not fit; look for repeated class-loader creation or a low MaxMetaspaceSize')
    } else if (/GC overhead limit/iu.test(message)) {
      hints.push('OutOfMemoryError: GC overhead limit exceeded means the collector spent nearly all time reclaiming almost nothing')
    } else if (/Direct buffer memory/iu.test(message)) {
      hints.push('OutOfMemoryError: Direct buffer memory means off-heap byte buffers exceeded MaxDirectMemorySize')
    } else {
      hints.push(`OutOfMemoryError (${message || 'no message'}): identify which memory pool is exhausted before tuning anything`)
    }
  }
  if (/TimeoutException|SocketTimeoutException/u.test(type)) {
    hints.push(`${simple}: a remote call exceeded its deadline; correlate with the downstream latency rather than retrying blindly`)
  }
  if (/^org\.springframework\.[\w.]*Exception$/u.test(type) && appFrame !== null) {
    hints.push(`${simple} surfaced through ${appFrame}; the application frame is the boundary to inspect, the Spring frames are plumbing`)
  }
  return hints.slice(0, 3)
}

/** True when the text looks like a Java exception chain rather than unrelated prose. */
export function looksLikeStackTrace(text: string): boolean {
  return /(?:^|\n)(?:Caused by:\s*)?(?:[\w$]+\.)+[\w$]+(?:Exception|Error|Throwable)\b/u.test(text) || /^\s*at\s+/mu.test(text)
}

/** Exported for the golden tests: lines that only look like generated headers. */
export function isGeneratedHeader(text: string): boolean {
  return GENERATED_RE.test(text)
}
