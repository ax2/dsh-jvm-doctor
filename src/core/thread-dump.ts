/**
 * Deterministic parser for `jstack` and `jcmd <pid> Thread.print` output.
 *
 * The parser never guesses: every consumed line is recorded, every frame is
 * attributed to the thread that owns it, and lines that match no known shape are
 * reported as unknown lines together with an honest confidence label.
 * @module dsh-jvm-doctor/core/thread-dump
 */
import { confidenceOf, coverage, indentOf, toLines, type SourceLine } from './lines.ts'

/** Parser revision, bumped whenever the accepted grammar changes. */
export const THREAD_DUMP_PARSER_VERSION = '1'

/** One stack frame of a Java thread. */
export interface DumpFrame {
  /** Fully qualified `class.method`. */
  method: string
  /** Source file or native marker. */
  file: string
  /** 1-based line number when the JVM knew it. */
  line: number | null
  /** Original frame text. */
  raw: string
}

/** One monitor or synchronizer the thread interacted with. */
export interface DumpLock {
  /** Identity hash from `<0x...>`, or `unknown` when the JVM did not print one. */
  id: string
  /** `locked`, `waiting to lock`, `parking to wait for`, `waiting on` or `eliminated`. */
  kind: string
  /** Raw lock text. */
  raw: string
}

/** Thread type inferred from the name prefix. */
export type DumpThreadType = 'java' | 'vm' | 'gc' | 'compiler' | 'jit' | 'reference' | 'finalizer' | 'other'

/** Normalized thread state; `unknown` only for non-standard headers. */
export type DumpThreadState =
  | 'RUNNABLE'
  | 'BLOCKED'
  | 'WAITING'
  | 'TIMED_WAITING'
  | 'NEW'
  | 'TERMINATED'
  | 'unknown'

/** Per-thread summary in the canonical result. */
export interface DumpThread {
  /** Thread name. */
  name: string
  /** `tid` from the header, `null` for `jcmd` output that omits it. */
  tid: string | null
  /** Native thread id from `nid=0x...`. */
  nid: string | null
  /** Raw state token found in the header line. */
  state: string
  /** Normalized state. */
  normalized_state: DumpThreadState
  /** Whether the thread is a daemon. */
  daemon: boolean
  /** Thread priority parsed from `prio=`, defaulting to `0` when absent. */
  priority: number
  /** Thread type inferred from the name prefix. */
  type: DumpThreadType
  /** 1-based line of the header in the input. */
  line: number
  /** Up to five leading stack frames. */
  top_frames: string[]
  /** Total frames attributed to this thread. */
  frame_count: number
  /** Locks the thread owns. */
  locked: DumpLock[]
  /** Monitors the thread is waiting to enter. */
  waiting_to_lock: DumpLock[]
  /** Parking or wait targets. */
  parking_to_wait_for: DumpLock[]
  /** Ownable synchronizers (JDK 6+ `-l` output). */
  ownable_synchronizers: DumpLock[]
  /** `Object.wait()` participants. */
  object_wait: DumpLock[]
  /** Free-form header text between the state token and the first frame. */
  status: string[]
}

/** One edge of a detected Java-level deadlock cycle. */
export interface DeadlockCycleLink {
  /** Thread that cannot make progress. */
  thread: string
  /** Lock id that thread waits on. */
  waiting_for: string
  /** Lock id that thread already holds while waiting. */
  holding: string
}

/** A deadlock cycle with its lock ordering. */
export interface DeadlockCycle {
  /** Participating thread names, in cycle order. */
  threads: string[]
  /** Ordered lock chain. */
  locks: string[]
  /** Explicit thread → lock → held-lock triples. */
  chain: DeadlockCycleLink[]
}

/** A class whose top frame appears in many threads at once. */
export interface ContentionCandidate {
  /** Java-level top frame, e.g. `com.acme.OrderDao.save`. */
  method: string
  /** Number of threads whose top frame is this method. */
  thread_count: number
  /** Up to ten thread names, in input order. */
  threads: string[]
  /** Thread states among those threads. */
  states: string[]
}

/** Reported lock identity that could not be resolved to a thread. */
export interface UnresolvedLock {
  /** Thread that waits on the lock. */
  waited_by: string
  /** Lock identity. */
  lock: string
}

/** Canonical payload of the `java_thread_dump` tool. */
export interface ThreadDumpReport {
  /** Parser revision. */
  parser_version: string
  /** Normalized line ending of the input. */
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
  /** `jstack` or `jcmd`, inferred from the preamble. */
  source: string
  /** Reported JVM version, when present. */
  jvm_version: string | null
  /** Preamble line that looked like a timestamp, when present. */
  captured_at: string | null
  /** Total lines in the input. */
  total_lines: number
  /** Lines the parser attributed to a known shape. */
  parsed_lines: number
  /** Lines that matched no known shape. */
  unknown_lines: number
  /** Up to five unknown lines, verbatim. */
  unknown_samples: string[]
  /** Fraction of lines recognized, in `[0, 1]`. */
  coverage: number
  /** Honest confidence label. */
  confidence: 'high' | 'medium' | 'low'
  /** Number of thread blocks found. */
  thread_count: number
  /** Threads whose header did not use the `"name"...prio=` form. */
  non_standard_thread_headers: number
  /** State histogram over normalized states. */
  state_histogram: Record<string, number>
  /** Raw-state histogram, verbatim tokens. */
  raw_state_histogram: Record<string, number>
  /** Daemon thread count. */
  daemon_threads: number
  /** Threads that are parked or waiting. */
  parked_or_waiting: number
  /** Explicit thread-level deadlock marker seen. */
  deadlock_marker: boolean
  /** Deadlock cycles recovered from the `Found one Java-level deadlock` section. */
  deadlock_cycles: DeadlockCycle[]
  /** Locks named in the deadlock section that no thread block resolved. */
  unresolved_locks: UnresolvedLock[]
  /** `Found N deadlocks.` summary value, when printed. */
  reported_deadlock_count: number | null
  /** Threads blocked on `Object.wait()` or `parking to wait for`. */
  blocked_in_object_wait: number
  /** Waiting threads that also hold a lock they will not release. */
  blocked_holding_lock: number
  /** Threads with at least one ownable synchronizer. */
  ownable_synchronizer_threads: number
  /** Total ownable synchronizers across all threads. */
  ownable_synchronizer_count: number
  /** Top-frame cohorts with more than one thread. */
  lock_contention_candidates: ContentionCandidate[]
  /** Non-null status lines, capped at the report budget. */
  status_lines: string[]
  /** Status lines over the report budget. */
  status_lines_omitted: number
  /** Per-thread summaries, capped at the report budget. */
  threads: DumpThread[]
  /** Threads over the report budget. */
  threads_omitted: number
}

/** Budgets that bound the thread-dump report. */
export interface ThreadDumpLimits {
  /** Maximum threads serialized into `threads`. */
  maxThreads: number
  /** Maximum status lines serialized. */
  maxStatusLines: number
  /** Maximum unknown-line samples. */
  sampleLimit: number
  /** Maximum contention candidates. */
  maxContention: number
}

const THREAD_HEADER_FULL =
  /^"(?<name>.*?)"\s+(?<attrs>.*?)(?:java\.lang\.Thread\.State:\s*(?<state>[A-Z_]+))?$/
const THREAD_HEADER_BARE = /^"(?<name>.*?)"\s+(?<rest>.*?)(?:nid=(?<nid>\S+))?\s*(?:java\.lang\.Thread\.State:\s*(?<state>[A-Z_]+))?$/
const FRAME_RE = /^at\s+(?<method>.+?)(?:\((?<file>[^()]*)\))?$/
const LOCK_RE =
  /^-\s+(?<kind>parking to wait for|waiting to lock|waiting on|locked|eliminated)\s+<\s*(?<id>0x[0-9a-fA-F]+)\s*>/
const OWNABLE_RE = /^-\s+<\s*(?<id>0x[0-9a-fA-F]+)\s*>\s*(?<describe>.*)$/
// The raw state is kept verbatim, including the parenthesised reason
// (`BLOCKED (on object monitor)`), because that reason is the actionable part.
const STATE_TAIL_RE = /java\.lang\.Thread\.State:\s*(?<state>[A-Z_]+(?:\s*\([^)]*\))?)/u
const JVM_TITLE_RE = /Full thread dump\s*(?<version>.*?)\s*(?:\(|$)/
const AT_TIMESTAMP_RE = /^#?\s*(?<time>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{4}|Z)?)/

/** Map a raw state token onto the normalized enum, ignoring any `(reason)` tail. */
export function normalizeState(raw: string): DumpThreadState {
  const token = (raw.replace(/\([^)]*\)/gu, '').replace(/[,\s]+$/u, '').trim().toUpperCase() || raw.trim().toUpperCase())
  if (token === 'RUNNABLE' || token === 'BLOCKED' || token === 'NEW' || token === 'TERMINATED') return token
  if (token === 'WAITING' || token === 'WAITING (ON OBJECT MONITOR)' || token === 'WAITING (PARKING)') return 'WAITING'
  if (token.startsWith('TIMED_WAITING')) return 'TIMED_WAITING'
  if (token === 'UNKNOWN') return 'RUNNABLE'
  return 'unknown'
}

/** Infer the thread family from its name. */
export function threadTypeOf(name: string): DumpThreadType {
  if (name.startsWith('VM ')) return 'vm'
  if (name.startsWith('GC ')) return 'gc'
  if (name.startsWith('C') && /^C\d+\b/u.test(name)) return 'compiler'
  if (name.startsWith('JIT')) return 'jit'
  if (name.startsWith('Reference Handler') || name.startsWith('Reference Queue')) return 'reference'
  if (name.startsWith('Finalizer')) return 'finalizer'
  if (/^(main|DestroyJavaVM|Signal Dispatcher|Attach Listener|Notification Thread|Common-Cleaner)/u.test(name)) return 'other'
  return 'java'
}

/** Detect a Java-level top frame, i.e. one that is not JDK or framework glue. */
export function isApplicationFrame(method: string): boolean {
  return !/^(?:java|javax|jdk|sun|com\.sun|org\.springframework)\./u.test(method)
}

/**
 * Parse one pasted thread dump.
 * @param text - raw dump text.
 * @param limits - report budgets.
 */
export function parseThreadDump(text: string, limits: ThreadDumpLimits): ThreadDumpReport {
  const lines = toLines(text)
  const consumed = new Set<number>()
  const threads: DumpThread[] = []
  const statusLines: string[] = []
  let nonStandardHeaders = 0
  let deadlockSection = false
  let deadlockMarker = false
  let reportedDeadlockCount: number | null = null
  let jvmVersion: string | null = null
  let capturedAt: string | null = null

  const framesByLine = new Map<number, DumpFrame[]>()
  const headerLineByThread = new Map<string, number>()

  const refreshState = (thread: DumpThread, joined: string): void => {
    const match = STATE_TAIL_RE.exec(joined)
    if (match?.groups?.state) thread.state = match.groups.state
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const raw = line.text
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      consumed.add(line.number)
      index += 1
      continue
    }

    // ------------------------------------------------------------ preamble ---
    if (trimmed === 'Full thread dump' || trimmed.startsWith('Full thread dump')) {
      consumed.add(line.number)
      const title = JVM_TITLE_RE.exec(trimmed)
      if (title?.groups?.version) jvmVersion = title.groups.version.trim()
      index += 1
      continue
    }
    if (/^JNI global refs:/u.test(trimmed) || /^Heap$/u.test(trimmed) || /^java\.lang\.Thread\.State/u.test(trimmed)) {
      consumed.add(line.number)
      index += 1
      continue
    }
    if (/^(?:Locked ownable synchronizers|Number of locked synchronizers)/u.test(trimmed)) {
      // `jstack` closes a dump with a synchronizer roll-up. It is part of the
      // grammar, so its header and every entry under it are recognized lines.
      consumed.add(line.number)
      let cursor = index + 1
      while (cursor < lines.length) {
        const probe = lines[cursor]!.text.trim()
        if (/^-?\s*(?:None|<0x[0-9a-fA-F]+>)/u.test(probe)) {
          consumed.add(lines[cursor]!.number)
          cursor += 1
          continue
        }
        break
      }
      index = cursor
      continue
    }
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/u.test(trimmed) && capturedAt === null) {
      capturedAt = preambleTimestamp(trimmed) ?? trimmed
      consumed.add(line.number)
      index += 1
      continue
    }

    // Section banners and deadlock separators carry no payload but are part of
    // every real dump, so they are recognized rather than reported as unknown.
    if (/^[=~_-]{3,}$/u.test(trimmed) || /^-{10,}$/u.test(trimmed)) {
      consumed.add(line.number)
      index += 1
      continue
    }
    if (/^\d+\.\d+: Heap$/u.test(trimmed) || /^Heap$/u.test(trimmed)) {
      consumed.add(line.number)
      index += 1
      continue
    }

    // -------------------------------------------------------- deadlock body ---
    if (/^Found one Java-level deadlock:/u.test(trimmed)) {
      deadlockMarker = true
      deadlockSection = true
      consumed.add(line.number)
      index += 1
      continue
    }
    if (/^Found \d+ deadlock/u.test(trimmed)) {
      const count = /^Found (?<count>\d+) deadlock/u.exec(trimmed)
      reportedDeadlockCount = count?.groups?.count ? Number(count.groups.count) : 0
      deadlockSection = false
      consumed.add(line.number)
      index += 1
      continue
    }
    if (/^"\S.*":$/u.test(trimmed) && deadlockSection) {
      consumed.add(line.number)
      index += 1
      continue
    }
    if (
      /^Java stack information for the threads listed above/u.test(trimmed) ||
      /^Threads class SMR info/u.test(trimmed)
    ) {
      // The trailing `Java stack information` section repeats frames for the
      // deadlocked threads. They carry no new information, but they are part of
      // the dump, so they are recognized line by line rather than reported as
      // unknown syntax.
      consumed.add(line.number)
      let cursor = index + 1
      while (cursor < lines.length) {
        const probe = lines[cursor]!.text.trim()
        if (probe.length === 0) break
        if (/^-{5,}$/u.test(probe) || /^[=~]{3,}$/u.test(probe)) {
          consumed.add(lines[cursor]!.number)
          cursor += 1
          continue
        }
        if (
          /^"[^"]+":?$/u.test(probe) ||
          /^at\s/u.test(probe) ||
          /^-?\s*(?:waiting to lock|locked|parking to wait for|waiting on)\s+</u.test(probe) ||
          /^(?:Locked ownable synchronizers|JNI global refs)/u.test(probe) ||
          /^[\s-]*None$/u.test(probe)
        ) {
          consumed.add(lines[cursor]!.number)
          cursor += 1
          continue
        }
        // `Found N deadlock.` ends the section; the main loop reports it.
        break
      }
      index = cursor
      continue
    }
    if (deadlockSection && /^(?:- )?(?:waiting to lock|locked)\b/u.test(trimmed) && /0x[0-9a-fA-F]+/u.test(trimmed)) {
      consumed.add(line.number)
      index += 1
      continue
    }

    // ----------------------------------------------------------- thread block ---
    // A full header is a quoted name plus the `prio=`/`nid=` attribute pair; a
    // bare header is a quoted name with a `java.lang.Thread.State:` tail only.
    const candidate = deadlockSection ? null : (THREAD_HEADER_FULL.exec(raw) ?? THREAD_HEADER_FULL.exec(trimmed))
    const header =
      candidate?.groups?.attrs !== undefined && /prio=(?<prio>-?\d+)/u.test(candidate.groups.attrs) && /nid=/u.test(candidate.groups.attrs)
        ? candidate
        : null
    if (header?.groups) {
      const groups = header.groups
      consumed.add(line.number)
      const frameStart = index + 1
      const end = findFrameEnd(lines, frameStart)
      let endIndex = end.endIndex
      const status: string[] = []
      let cursor = frameStart
      // `jcmd Thread.print` prints the state on the header line; `jstack` on the
      // next indented line, and interleaves extra status text before the frames.
      while (cursor < lines.length) {
        const probe = lines[cursor]!
        const probeTrimmed = probe.text.trim()
        if (probeTrimmed.startsWith('at ')) break
        if (probeTrimmed.startsWith('- ') || probeTrimmed.startsWith('<') || /^-{10,}$/u.test(probeTrimmed)) break
        if (/^"/u.test(probeTrimmed) || /^Found /u.test(probeTrimmed) || /^JNI global refs/u.test(probeTrimmed)) break
        if (probeTrimmed.length > 0) {
          status.push(probeTrimmed)
          consumed.add(probe.number)
        } else {
          // Blank separators between thread blocks are structure, not syntax.
          consumed.add(probe.number)
          break
        }
        cursor += 1
      }
      // `jcmd Thread.print` puts the state on the header line itself; recover it
      // from there so the raw state is never lost when `attrs` stopped early.
      const inline = /java\.lang\.Thread\.State:\s*(?<state>[A-Z_]+(?:\s*\([^)]*\))?)/u.exec(raw)
      if (inline?.groups?.state !== undefined && !status.some((entry) => entry.includes('java.lang.Thread.State'))) {
        status.push(inline.groups.state)
      }
      const frames: DumpFrame[] = []
      const locked: DumpLock[] = []
      const waiting: DumpLock[] = []
      const parking: DumpLock[] = []
      const ownable: DumpLock[] = []
      const objectWait: DumpLock[] = []
      let ownableSection = false
      let scan = frameStart
      while (scan < endIndex) {
        const probe = lines[scan]!
        const probeTrimmed = probe.text.trim()
        consumed.add(probe.number)
        if (probeTrimmed.startsWith('at ')) {
          const frame = parseFrame(probeTrimmed)
          if (frame !== null) frames.push(frame)
          scan += 1
          continue
        }
        const lock = LOCK_RE.exec(probeTrimmed)
        if (lock?.groups?.kind) {
          const kind = lock.groups.kind
          const entry: DumpLock = {
            id: lock.groups.id ? lock.groups.id.toLowerCase() : 'unknown',
            kind,
            raw: probeTrimmed,
          }
          if (kind === 'locked' || kind === 'eliminated') locked.push(entry)
          else if (kind === 'waiting to lock') waiting.push(entry)
          else if (kind === 'parking to wait for') parking.push(entry)
          else objectWait.push(entry)
          scan += 1
          continue
        }
        if (/^Number of locked synchronizers = \d+/u.test(probeTrimmed)) {
          ownableSection = true
          scan += 1
          continue
        }
        if (ownableSection) {
          const inner = OWNABLE_RE.exec(probeTrimmed)
          if (inner?.groups?.id) {
            ownable.push({ id: inner.groups.id.toLowerCase(), kind: 'ownable synchronizer', raw: probeTrimmed })
            scan += 1
            continue
          }
        }
        scan += 1
      }
      endIndex = Math.max(endIndex, scan)
      const attrs = groups.attrs ?? ''
      // Attribute order varies across JDK versions and vendors, and a thread name
      // may contain spaces, so each attribute is read independently.
      const rawState = groups.state ?? 'unknown'
      const thread: DumpThread = {
        name: groups.name ?? '',
        tid: /tid=(?<tid>\S+)/u.exec(attrs)?.groups?.tid ?? null,
        nid: /nid=(?<nid>\S+)/u.exec(attrs)?.groups?.nid ?? null,
        state: rawState,
        normalized_state: normalizeState(rawState),
        daemon: /(?:^|\s)daemon(?:\s|$)/u.test(attrs),
        priority: Number.parseInt(/prio=(?<prio>-?\d+)/u.exec(attrs)?.groups?.prio ?? '0', 10) || 0,
        type: threadTypeOf(groups.name ?? ''),
        line: line.number,
        top_frames: frames.slice(0, 5).map((frame) => frame.method),
        frame_count: frames.length,
        locked,
        waiting_to_lock: waiting,
        parking_to_wait_for: parking,
        ownable_synchronizers: ownable,
        object_wait: objectWait,
        status,
      }
      refreshState(thread, rawState)
      refreshState(thread, attrs)
      for (const extra of status) refreshState(thread, extra)
      thread.normalized_state = normalizeState(thread.state)
      framesByLine.set(line.number, frames)
      headerLineByThread.set(thread.name, line.number)
      threads.push(thread)
      for (const extra of status) if (statusLines.length < limits.maxStatusLines) statusLines.push(extra)
      index = endIndex
      continue
    }

    const bare = deadlockSection ? null : THREAD_HEADER_BARE.exec(trimmed)
    if (bare?.groups && trimmed.startsWith('"')) {
      nonStandardHeaders += 1
      consumed.add(line.number)
      const rest = bare.groups.rest ?? ''
      const stateMatch = STATE_TAIL_RE.exec(rest)
      const state = bare.groups.state ?? stateMatch?.groups?.state ?? 'unknown'
      const frameStart = index + 1
      const end = findFrameEnd(lines, frameStart)
      const frames: DumpFrame[] = []
      for (let scan = frameStart; scan < end.endIndex; scan += 1) {
        const probe = lines[scan]!
        consumed.add(probe.number)
        if (probe.text.trim().startsWith('at ')) {
          const frame = parseFrame(probe.text.trim())
          if (frame !== null) frames.push(frame)
        }
      }
      const thread: DumpThread = {
        name: bare.groups.name ?? '',
        tid: null,
        nid: bare.groups.nid ?? /nid=(?<nid>\S+)/u.exec(rest)?.groups?.nid ?? null,
        state,
        normalized_state: normalizeState(state),
        daemon: false,
        priority: 0,
        type: threadTypeOf(bare.groups.name ?? ''),
        line: line.number,
        top_frames: frames.slice(0, 5).map((frame) => frame.method),
        frame_count: frames.length,
        locked: [],
        waiting_to_lock: [],
        parking_to_wait_for: [],
        ownable_synchronizers: [],
        object_wait: [],
        status: rest.length > 0 ? [rest] : [],
      }
      framesByLine.set(line.number, frames)
      headerLineByThread.set(thread.name, line.number)
      threads.push(thread)
      index = end.endIndex
      continue
    }

    if (/^-{10,}$/u.test(trimmed)) {
      consumed.add(line.number)
      index += 1
      continue
    }

    // Anything else is honestly unknown.
    index += 1
  }

  // ------------------------------------------------------------- deadlocks ---
  // The `Found one Java-level deadlock:` section names the holder of each lock,
  // so it is the authoritative wait-for graph. Entries appear in two shapes:
  // `- waiting to lock <0x..> (a Type)` followed by `- locked <0x..>` (the
  // holder), and a single `waiting to lock monitor 0x.. (object 0x.., a Type),
  // which is held by "thread"` line. Everything the parser reads here is marked
  // consumed, because recognizing a line and reporting it as unknown at the same
  // time would be dishonest.
  const deadlockEdges: { thread: string; lock: string; holder: string | null }[] = []
  const holderByLock = new Map<string, string>()
  const seenEdge = new Set<string>()
  index = 0
  let inSection = false
  let currentThread: string | null = null
  let pendingWait: string | null = null
  const pushEdge = (thread: string, lock: string, holder: string | null): void => {
    const key = `${thread}|${lock}`
    if (seenEdge.has(key)) return
    seenEdge.add(key)
    deadlockEdges.push({ thread, lock, holder })
  }
  while (index < lines.length) {
    const line = lines[index]!
    const trimmed = line.text.trim()
    if (/^Found one Java-level deadlock:/u.test(trimmed)) {
      inSection = true
      currentThread = null
      pendingWait = null
      consumed.add(line.number)
      index += 1
      continue
    }
    if (/^Found \d+ deadlock/u.test(trimmed) || /^Java stack information/u.test(trimmed)) {
      inSection = false
      currentThread = null
      pendingWait = null
      consumed.add(line.number)
      index += 1
      continue
    }
    if (!inSection) {
      index += 1
      continue
    }
    const named = /^"(?<name>[^"]+)":/u.exec(trimmed)
    if (named?.groups?.name !== undefined) {
      currentThread = named.groups.name
      pendingWait = null
      consumed.add(line.number)
      index += 1
      continue
    }
    // The verbatim dump wraps this sentence over two lines
    // (`... a com.acme.order.Inventory),` / `  which is held by "deadlock-B"`),
    // so the continuation line is joined before matching.
    const joined = `${trimmed} ${(lines[index + 1]?.text ?? '').trim()}`
    const inline = /waiting to lock monitor \S+\s+\(object (?<lock>0x[0-9a-fA-F]+)[^)]*\)[\s\S]*?"(?<holder>[^"]+)"/u.exec(joined)
    if (inline?.groups?.lock !== undefined && currentThread !== null) {
      const lock = inline.groups.lock.toLowerCase()
      pushEdge(currentThread, lock, inline.groups.holder ?? null)
      consumed.add(line.number)
      index += 1
      continue
    }
    const waiting = /^-?\s*waiting to lock\s+<\s*(?<lock>0x[0-9a-fA-F]+)\s*>/u.exec(trimmed)
    if (waiting?.groups?.lock !== undefined && currentThread !== null) {
      const lock = waiting.groups.lock.toLowerCase()
      pendingWait = lock
      pushEdge(currentThread, lock, null)
      consumed.add(line.number)
      index += 1
      continue
    }
    const locked = /^-?\s*locked\s+<\s*(?<lock>0x[0-9a-fA-F]+)\s*>/u.exec(trimmed)
    if (locked?.groups?.lock !== undefined && currentThread !== null) {
      const lock = locked.groups.lock.toLowerCase()
      holderByLock.set(lock, currentThread)
      // The `- locked` line immediately after a `- waiting to lock` line names
      // the thread that holds the awaited lock.
      if (pendingWait !== null && pendingWait !== lock) holderByLock.set(pendingWait, currentThread)
      pendingWait = null
      consumed.add(line.number)
      index += 1
      continue
    }
    if (
      /^at\s/u.test(trimmed) ||
      /^\.\.\./u.test(trimmed) ||
      /which is held by/u.test(trimmed) ||
      /^(?:Locked ownable synchronizers|Number of locked synchronizers|[\s-]*None)/u.test(trimmed)
    ) {
      consumed.add(line.number)
      index += 1
      continue
    }
    index += 1
  }

  // ------------------------------------------------------------ wait graph ---
  const threadLocks = new Map<string, string[]>()
  for (const thread of threads) {
    if (threadLocks.has(thread.name)) continue
    threadLocks.set(thread.name, [...thread.locked, ...thread.ownable_synchronizers].map((lock) => lock.id))
  }
  const waitByThread = new Map<string, { thread: string; lock: string; holding: string; holder: string | null }>()
  for (const edge of deadlockEdges) {
    const holder = edge.holder !== null ? edge.holder : holderByLock.get(edge.lock) ?? null
    const held = threadLocks.get(edge.thread) ?? []
    const previous = waitByThread.get(edge.thread)
    if (previous === undefined) {
      waitByThread.set(edge.thread, { thread: edge.thread, lock: edge.lock, holding: held.find((lock) => lock !== edge.lock) ?? held[0] ?? '', holder })
    } else if (previous.holder === null && holder !== null) {
      waitByThread.set(edge.thread, { ...previous, lock: edge.lock, holder })
    }
  }

  const cycles: DeadlockCycle[] = []
  const unresolved: UnresolvedLock[] = []
  for (const [thread, edge] of waitByThread) {
    if (edge.holder === null) unresolved.push({ waited_by: thread, lock: edge.lock })
  }
  const visited = new Set<string>()
  for (const start of waitByThread.keys()) {
    if (visited.has(start)) continue
    const chain: DeadlockCycleLink[] = []
    const seen = new Set<string>()
    let cursor: string | undefined = start
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor)
      const edge = waitByThread.get(cursor)
      if (edge === undefined) break
      chain.push({ thread: cursor, waiting_for: edge.lock, holding: edge.holding })
      if (edge.holder === null || edge.holder === start) break
      cursor = edge.holder
    }
    if (chain.length === 0) continue
    for (const link of chain) visited.add(link.thread)
    const threadNames: string[] = []
    for (const link of chain) if (!threadNames.includes(link.thread)) threadNames.push(link.thread)
    const locks: string[] = []
    for (const link of chain) {
      if (!locks.includes(link.waiting_for)) locks.push(link.waiting_for)
      if (link.holding.length > 0 && !locks.includes(link.holding)) locks.push(link.holding)
    }
    cycles.push({ threads: threadNames, locks, chain })
  }

  // ------------------------------------------------------------ aggregates ---
  const stateHistogram: Record<string, number> = {}
  const rawStateHistogram: Record<string, number> = {}
  let daemonThreads = 0
  let parkedOrWaiting = 0
  let blockedInObjectWait = 0
  let blockedHoldingLock = 0
  let ownableThreads = 0
  let ownableCount = 0
  const topFrameThreads = new Map<string, { threads: string[]; states: string[] }>()
  for (const thread of threads) {
    stateHistogram[thread.normalized_state] = (stateHistogram[thread.normalized_state] ?? 0) + 1
    rawStateHistogram[thread.state] = (rawStateHistogram[thread.state] ?? 0) + 1
    if (thread.daemon) daemonThreads += 1
    if (thread.normalized_state === 'WAITING' || thread.normalized_state === 'TIMED_WAITING') parkedOrWaiting += 1
    const waits = thread.object_wait.length + thread.parking_to_wait_for.length
    if (waits > 0) {
      blockedInObjectWait += 1
      if (thread.locked.length > 0 || thread.ownable_synchronizers.length > 0) blockedHoldingLock += 1
    }
    if (thread.ownable_synchronizers.length > 0) {
      ownableThreads += 1
      ownableCount += thread.ownable_synchronizers.length
    }
    const top = thread.top_frames[0]
    if (top !== undefined && isApplicationFrame(top)) {
      const bucket = topFrameThreads.get(top) ?? { threads: [], states: [] }
      if (bucket.threads.length < 10) bucket.threads.push(thread.name)
      bucket.states.push(thread.normalized_state)
      topFrameThreads.set(top, bucket)
    }
  }
  const contention: ContentionCandidate[] = [...topFrameThreads.entries()]
    .filter(([, bucket]) => bucket.threads.length > 1)
    .map(([method, bucket]) => ({
      method,
      thread_count: bucket.states.length,
      threads: bucket.threads,
      states: [...new Set(bucket.states)],
    }))
    .sort((left, right) => right.thread_count - left.thread_count || left.method.localeCompare(right.method))
    .slice(0, limits.maxContention)

  const cover = coverage(lines, consumed, limits.sampleLimit)
  const signal = deadlockMarker || reportedDeadlockCount !== null ? 'clean' : threads.length === 0 ? 'suspicious' : 'neutral'
  // No input means no evidence: report the weakest confidence rather than full
  // coverage of an empty document.
  const confidence = text.trim().length === 0 ? 'low' : confidenceOf(cover.ratio, signal)
  const eol = detectEol(text)
  const boundedThreads = threads.slice(0, limits.maxThreads)

  return {
    parser_version: THREAD_DUMP_PARSER_VERSION,
    eol,
    source: /jcmd|JVM thread dump|Thread\.print/iu.test(text) ? 'jcmd' : 'jstack',
    jvm_version: jvmVersion,
    captured_at: capturedAt,
    total_lines: lines.length,
    parsed_lines: cover.parsed,
    unknown_lines: cover.unknown,
    unknown_samples: cover.samples,
    coverage: Number(cover.ratio.toFixed(4)),
    confidence,
    thread_count: threads.length,
    non_standard_thread_headers: nonStandardHeaders,
    state_histogram: stateHistogram,
    raw_state_histogram: rawStateHistogram,
    daemon_threads: daemonThreads,
    parked_or_waiting: parkedOrWaiting,
    deadlock_marker: deadlockMarker,
    deadlock_cycles: cycles,
    unresolved_locks: unresolved,
    reported_deadlock_count: reportedDeadlockCount,
    blocked_in_object_wait: blockedInObjectWait,
    blocked_holding_lock: blockedHoldingLock,
    ownable_synchronizer_threads: ownableThreads,
    ownable_synchronizer_count: ownableCount,
    lock_contention_candidates: contention,
    status_lines: statusLines.slice(0, limits.maxStatusLines),
    status_lines_omitted: Math.max(0, statusLines.length - limits.maxStatusLines),
    threads: boundedThreads,
    threads_omitted: Math.max(0, threads.length - boundedThreads.length),
  }
}

/** Parse one `at class.method(file:line)` frame. */
export function parseFrame(text: string): DumpFrame | null {
  const match = FRAME_RE.exec(text)
  if (match?.groups?.method === undefined) return null
  const location = match.groups.file ?? ''
  const lineMatch = /:(?<line>\d+)$/u.exec(location)
  return {
    method: match.groups.method.trim(),
    file: location.replace(/:\d+$/u, ''),
    line: lineMatch?.groups?.line ? Number(lineMatch.groups.line) : null,
    raw: text,
  }
}

/**
 * Locate the end of one thread block: the next thread header, the deadlock
 * section, or the end of the document. Indented `- locked`/`- parking to wait
 * for` lines belong to the block and must stay inside it.
 */
function findFrameEnd(lines: readonly SourceLine[], start: number): { endIndex: number } {
  let cursor = start
  while (cursor < lines.length) {
    const trimmed = lines[cursor]!.text.trim()
    if (trimmed.length === 0) {
      // A blank line ends the block and is consumed by the caller; stopping here
      // keeps a following `Found N deadlock.` summary out of the last thread.
      break
    }
    if (trimmed.startsWith('"') && /^"[^"]*"/u.test(trimmed)) break
    if (/^Found one Java-level deadlock:/u.test(trimmed)) break
    if (/^Found \d+ deadlock/u.test(trimmed)) break
    if (/^JNI global refs:/u.test(trimmed)) break
    if (/^(?:Locked ownable synchronizers|Threads class SMR info)/u.test(trimmed)) break
    cursor += 1
  }
  return { endIndex: cursor }
}

/** Detect the dominant line terminator of a document. */
export function detectEol(text: string): 'lf' | 'crlf' | 'mixed' | 'none' {
  const crlf = (text.match(/\r\n/gu) ?? []).length
  const lf = (text.match(/(?<!\r)\n/gu) ?? []).length
  if (crlf === 0 && lf === 0) return 'none'
  if (crlf > 0 && lf > 0) return 'mixed'
  return crlf > 0 ? 'crlf' : 'lf'
}

/** True when the text looks like a thread dump rather than an unrelated paste. */
export function looksLikeThreadDump(text: string): boolean {
  return /^\s*"/mu.test(text) && /\bnid=0x[0-9a-fA-F]+/u.test(text)
}

/** Timestamp preamble detector, exported for the golden tests. */
export function preambleTimestamp(text: string): string | null {
  const match = AT_TIMESTAMP_RE.exec(text.trim())
  return match?.groups?.time ?? null
}
