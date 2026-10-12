/**
 * Golden tests for the pure report parsers.
 *
 * Every fixture below is a realistic (if abridged) production report. The
 * assertions pin exact numbers so a grammar regression fails loudly instead of
 * producing a plausible-looking wrong answer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseThreadDump, normalizeState, threadTypeOf, isApplicationFrame } from '../src/core/thread-dump.ts'
import { parseGcLog, percentile, sizeToBytes, generationOf } from '../src/core/gc-log.ts'
import { parseDependencyText } from '../src/core/deps.ts'
import { parseStackTrace, isLibraryFrame, deepestApplicationFrame } from '../src/core/stacktrace.ts'
import { diffSpringConfig, flattenYaml, isSecretKey, parseProperties } from '../src/core/spring-config.ts'
import { DEFAULT_LIMITS } from '../src/limits.ts'

/** Budgets used by the parser-level tests. */
const LIMITS = {
  maxThreads: DEFAULT_LIMITS.maxThreads,
  maxStatusLines: DEFAULT_LIMITS.maxStatusLines,
  maxContention: DEFAULT_LIMITS.maxContention,
  maxGcEvents: DEFAULT_LIMITS.maxGcEvents,
  maxPauseSamples: DEFAULT_LIMITS.maxPauseSamples,
  maxConflicts: DEFAULT_LIMITS.maxConflicts,
  maxEdgesPerConflict: DEFAULT_LIMITS.maxEdgesPerConflict,
  maxExceptions: DEFAULT_LIMITS.maxExceptions,
  maxFramesPerException: DEFAULT_LIMITS.maxFramesPerException,
  maxChanges: DEFAULT_LIMITS.maxChanges,
  maxKeys: DEFAULT_LIMITS.maxKeys,
  sampleLimit: DEFAULT_LIMITS.sampleLimit,
}

/** A real `jstack -l` dump of a small Spring application with one deadlock. */
const JSTACK = `2026-01-02 03:04:05
Full thread dump OpenJDK 64-Bit Server VM (21.0.4+7-LTS-103 mixed mode, sharing):

"Reference Handler" #9 daemon prio=10 os_prio=0 cpu=1.42ms elapsed=812.33s tid=0x0000023b8c1a9a00 nid=0x1e4c waiting on condition  [0x000000d3a4bfe000]
   java.lang.Thread.State: RUNNABLE
	at java.lang.ref.Reference.waitForReferencePendingList(java.base@21.0.4/Native Method)
	at java.lang.ref.Reference.processPendingReferences(java.base@21.0.4/Reference.java:246)
	at java.lang.ref.Reference$ReferenceHandler.run(java.base@21.0.4/Reference.java:208)

"main" #1 prio=5 os_prio=0 cpu=310.55ms elapsed=812.94s tid=0x0000023b8c018800 nid=0x1f14 waiting on condition  [0x000000d3a46fe000]
   java.lang.Thread.State: WAITING (parking)
	at jdk.internal.misc.Unsafe.park(java.base@21.0.4/Native Method)
	- parking to wait for  <0x0000000712a1b3d0> (a java.util.concurrent.CountDownLatch$Sync)
	at java.util.concurrent.locks.LockSupport.park(LockSupport.java:371)
	at java.util.concurrent.CountDownLatch.await(CountDownLatch.java:230)
	at com.acme.boot.Bootstrap.awaitReady(Bootstrap.java:88)
	at com.acme.boot.Bootstrap.main(Bootstrap.java:41)

"worker-1" #21 prio=5 os_prio=0 cpu=92.10ms elapsed=812.10s tid=0x0000023b8c2f1800 nid=0x2a10 waiting for monitor entry  [0x000000d3a52fe000]
   java.lang.Thread.State: BLOCKED (on object monitor)
	at com.acme.order.OrderDao.save(OrderDao.java:142)
	- waiting to lock <0x0000000712b00a88> (a com.acme.order.OrderDao)
	at com.acme.order.OrderService.place(OrderService.java:77)
	- locked <0x0000000712b00a88> (a com.acme.order.OrderDao)
	at com.acme.web.OrderController.post(OrderController.java:52)
	at java.base@21.0.4/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)

"worker-2" #22 prio=5 os_prio=0 cpu=88.44ms elapsed=812.09s tid=0x0000023b8c2f2c00 nid=0x2a11 waiting for monitor entry  [0x000000d3a54fe000]
   java.lang.Thread.State: BLOCKED (on object monitor)
	at com.acme.order.OrderDao.save(OrderDao.java:142)
	- waiting to lock <0x0000000712b00a88> (a com.acme.order.OrderDao)
	at com.acme.order.OrderService.place(OrderService.java:77)
	at com.acme.web.OrderController.post(OrderController.java:52)

"worker-3" #23 prio=5 os_prio=0 cpu=91.02ms elapsed=812.09s tid=0x0000023b8c2f4000 nid=0x2a12 waiting for monitor entry  [0x000000d3a56fe000]
   java.lang.Thread.State: BLOCKED (on object monitor)
	at com.acme.order.OrderDao.save(OrderDao.java:142)
	- waiting to lock <0x0000000712b00a88> (a com.acme.order.OrderDao)
	at com.acme.order.OrderService.place(OrderService.java:77)

"pool-1-thread-1" #24 prio=5 os_prio=0 cpu=12.00ms elapsed=800.00s tid=0x0000023b8c2f5400 nid=0x2a13 waiting on condition  [0x000000d3a58fe000]
   java.lang.Thread.State: TIMED_WAITING (sleeping)
	at java.base@21.0.4/java.lang.Thread.sleep0(Native Method)
	at java.base@21.0.4/java.lang.Thread.sleep(Thread.java:509)
	at com.acme.timer.Heartbeat.tick(Heartbeat.java:33)
	- locked <0x0000000712c00120> (a com.acme.timer.Heartbeat)

"Common-Cleaner" #15 daemon prio=8 os_prio=1 cpu=3.20ms elapsed=811.00s tid=0x0000023b8c1c2000 nid=0x1f30 in Object.wait()  [0x000000d3a4dfe000]
   java.lang.Thread.State: TIMED_WAITING (on object monitor)
	at java.base@21.0.4/java.lang.Object.wait0(Native Method)
	- waiting on <0x0000000712a00010> (a java.lang.ref.ReferenceQueue$Lock)
	at java.base@21.0.4/java.lang.ref.ReferenceQueue.remove(ReferenceQueue.java:155)
	- locked <0x0000000712a00010> (a java.lang.ref.ReferenceQueue$Lock)
	at java.base@21.0.4/jdk.internal.ref.CleanerImpl.run(CleanerImpl.java:148)

"deadlock-A" #40 prio=5 os_prio=0 cpu=5.00ms elapsed=100.00s tid=0x0000023b8c400000 nid=0x2b00 waiting for monitor entry  [0x000000d3a60fe000]
   java.lang.Thread.State: BLOCKED (on object monitor)
	at com.acme.order.Inventory.reserve(Inventory.java:61)
	- waiting to lock <0x0000000712d00020> (a com.acme.order.Inventory)
	at com.acme.order.OrderService.place(OrderService.java:80)
	- locked <0x0000000712c00010> (a com.acme.order.OrderDao)

"deadlock-B" #41 prio=5 os_prio=0 cpu=4.00ms elapsed=100.00s tid=0x0000023b8c401000 nid=0x2b01 waiting for monitor entry  [0x000000d3a61fe000]
   java.lang.Thread.State: BLOCKED (on object monitor)
	at com.acme.order.OrderDao.save(OrderDao.java:150)
	- waiting to lock <0x0000000712c00010> (a com.acme.order.OrderDao)
	at com.acme.order.Inventory.reserve(Inventory.java:70)
	- locked <0x0000000712d00020> (a com.acme.order.Inventory)

Found one Java-level deadlock:
=============================
"deadlock-A":
  waiting to lock monitor 0x0000023b8c50a1c8 (object 0x0000000712d00020, a com.acme.order.Inventory),
  which is held by "deadlock-B"
"deadlock-B":
  waiting to lock monitor 0x0000023b8c50a2d8 (object 0x0000000712c00010, a com.acme.order.OrderDao),
  which is held by "deadlock-A"

Java stack information for the threads listed above:
===================================================
"deadlock-A":
	at com.acme.order.Inventory.reserve(Inventory.java:61)
	- waiting to lock <0x0000000712d00020> (a com.acme.order.Inventory)
	- locked <0x0000000712c00010> (a com.acme.order.OrderDao)
"deadlock-B":
	at com.acme.order.OrderDao.save(OrderDao.java:150)
	- waiting to lock <0x0000000712c00010> (a com.acme.order.OrderDao)
	- locked <0x0000000712d00020> (a com.acme.order.Inventory)

Found 1 deadlock.

JNI global refs: 42, weak refs: 7

Locked ownable synchronizers:
	- None
`

test('java_thread_dump: thread census, states and daemon count are exact', () => {
  const report = parseThreadDump(JSTACK, LIMITS)
  assert.equal(report.parser_version, '1')
  assert.equal(report.source, 'jstack')
  assert.equal(report.jvm_version, 'OpenJDK 64-Bit Server VM')
  assert.equal(report.eol, 'lf')
  assert.equal(report.thread_count, 9)
  assert.equal(report.daemon_threads, 2)
  assert.equal(report.non_standard_thread_headers, 0)
  assert.deepEqual(report.state_histogram, { RUNNABLE: 1, WAITING: 1, BLOCKED: 5, TIMED_WAITING: 2 })
  // The raw histogram keeps the JVM's own wording, including the `(reason)` tail
  // and any `@version` module prefix, so nothing the dump printed is normalized away.
  assert.deepEqual(report.raw_state_histogram, {
    RUNNABLE: 1,
    'WAITING (parking)': 1,
    'BLOCKED (on object monitor)': 5,
    'TIMED_WAITING (sleeping)': 1,
    'TIMED_WAITING (on object monitor)': 1,
  })
  assert.equal(report.parked_or_waiting, 3)
  assert.equal(report.total_lines, 95)
  assert.equal(report.parsed_lines, 95)
  assert.equal(report.unknown_lines, 0)
  assert.equal(report.coverage, 1)
  assert.equal(report.confidence, 'high')
})

test('java_thread_dump: deadlock marker and the recovered lock cycle', () => {
  const report = parseThreadDump(JSTACK, LIMITS)
  assert.equal(report.deadlock_marker, true)
  // The dump states its own deadlock count; it is reported verbatim.
  assert.equal(report.reported_deadlock_count, 1)
  assert.equal(report.deadlock_cycles.length, 1)
  const cycle = report.deadlock_cycles[0]!
  assert.deepEqual(cycle.threads, ['deadlock-A', 'deadlock-B'])
  assert.deepEqual(cycle.locks, ['0x0000000712d00020', '0x0000000712c00010'])
  assert.deepEqual(cycle.chain, [
    { thread: 'deadlock-A', waiting_for: '0x0000000712d00020', holding: '0x0000000712c00010' },
    { thread: 'deadlock-B', waiting_for: '0x0000000712c00010', holding: '0x0000000712d00020' },
  ])
  assert.deepEqual(report.unresolved_locks, [])
})

test('java_thread_dump: a declared deadlock count is reported verbatim', () => {
  const withSummary = `${JSTACK}
Found 2 deadlock.
`
  const report = parseThreadDump(withSummary, LIMITS)
  assert.equal(report.reported_deadlock_count, 2)
  assert.equal(report.deadlock_marker, true)
  assert.equal(report.unknown_lines, 0)
})

test('java_thread_dump: per-thread frames, locks and wait/park attribution', () => {
  const report = parseThreadDump(JSTACK, LIMITS)
  const worker1 = report.threads.find((thread) => thread.name === 'worker-1')!
  assert.equal(worker1.tid, '0x0000023b8c2f1800')
  assert.equal(worker1.nid, '0x2a10')
  assert.equal(worker1.state, 'BLOCKED (on object monitor)')
  assert.equal(worker1.normalized_state, 'BLOCKED')
  assert.equal(worker1.priority, 5)
  assert.equal(worker1.daemon, false)
  assert.equal(worker1.type, 'java')
  assert.equal(worker1.frame_count, 4)
  assert.deepEqual(worker1.top_frames, [
    'com.acme.order.OrderDao.save',
    'com.acme.order.OrderService.place',
    'com.acme.web.OrderController.post',
    'java.base@21.0.4/jdk.internal.reflect.DirectMethodHandleAccessor.invoke',
  ])
  assert.deepEqual(
    worker1.waiting_to_lock.map((lock) => lock.id),
    ['0x0000000712b00a88'],
  )
  assert.deepEqual(
    worker1.locked.map((lock) => lock.id),
    ['0x0000000712b00a88'],
  )

  const main = report.threads.find((thread) => thread.name === 'main')!
  assert.equal(main.normalized_state, 'WAITING')
  assert.deepEqual(
    main.parking_to_wait_for.map((lock) => lock.id),
    ['0x0000000712a1b3d0'],
  )

  const cleaner = report.threads.find((thread) => thread.name === 'Common-Cleaner')!
  assert.equal(cleaner.daemon, true)
  assert.deepEqual(
    cleaner.object_wait.map((lock) => lock.id),
    ['0x0000000712a00010'],
  )
})

test('java_thread_dump: contention cohorts and wait counters', () => {
  const report = parseThreadDump(JSTACK, LIMITS)
  assert.equal(report.blocked_in_object_wait, 2)
  assert.equal(report.blocked_holding_lock, 1)
  assert.deepEqual(report.lock_contention_candidates, [
    { method: 'com.acme.order.OrderDao.save', thread_count: 4, threads: ['worker-1', 'worker-2', 'worker-3', 'deadlock-B'], states: ['BLOCKED'] },
  ])
})

test('java_thread_dump: fixture truncation degrades coverage honestly instead of guessing', () => {
  const garbled = `${JSTACK}
jcmd 1234 Thread.print
some operator wrote this line by hand
{"json": "pasted by mistake"}
[2026-01-02T03:04:05.678+0800][info][gc] GC(42) Pause Young (Normal) (G1 Evacuation Pause) 128M->45M(512M) 12.345ms
`
  const report = parseThreadDump(garbled, LIMITS)
  assert.equal(report.thread_count, 9)
  assert.equal(report.total_lines - report.parsed_lines, report.unknown_lines)
  assert.equal(report.unknown_lines, 4)
  assert.equal(report.coverage, 0.96)
  assert.ok(report.coverage < 0.98)
  assert.equal(report.total_lines, 100)
  // The blank lines of the dump are structure, not syntax: they must not appear
  // as evidence of an unrecognized grammar.
  assert.equal(report.confidence, 'medium')
  assert.deepEqual(report.unknown_samples, [
    'jcmd 1234 Thread.print',
    'some operator wrote this line by hand',
    '{"json": "pasted by mistake"}',
    '[2026-01-02T03:04:05.678+0800][info][gc] GC(42) Pause Young (Normal) (G1 Evacuation Pause) 128M->45M(512M) 12.345ms',
  ])
})

test('java_thread_dump: an empty paste is a low-confidence report, never a crash', () => {
  const report = parseThreadDump('', LIMITS)
  assert.equal(report.thread_count, 0)
  assert.equal(report.total_lines, 0)
  assert.equal(report.coverage, 1)
  assert.equal(report.confidence, 'low')
  assert.deepEqual(report.unknown_samples, [])
})

test('thread-dump helpers classify states, families and application frames', () => {
  assert.equal(normalizeState('TIMED_WAITING (on object monitor)'), 'TIMED_WAITING')
  assert.equal(normalizeState('UNKNOWN'), 'RUNNABLE')
  assert.equal(normalizeState('banana'), 'unknown')
  assert.equal(threadTypeOf('VM Thread'), 'vm')
  assert.equal(threadTypeOf('GC Thread#3'), 'gc')
  assert.equal(threadTypeOf('C2 CompilerThread0'), 'compiler')
  assert.equal(threadTypeOf('Finalizer'), 'finalizer')
  assert.equal(threadTypeOf('http-nio-8080-exec-1'), 'java')
  assert.equal(isApplicationFrame('com.acme.order.OrderDao.save'), true)
  assert.equal(isApplicationFrame('org.springframework.web.servlet.DispatcherServlet.doDispatch'), false)
  assert.equal(isApplicationFrame('jdk.internal.misc.Unsafe.park'), false)
})

/** Unified-logging GC lines with wall-clock decorators, timestamps one second apart. */
const UNIFIED_GC = `[2026-01-02T03:04:05.678+0800][info][gc] Using G1
[2026-01-02T03:04:05.678+0800][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 128M->45M(512M) 12.345ms
[2026-01-02T03:04:06.100+0800][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 300M->60M(512M) 20.000ms
[2026-01-02T03:04:07.100+0800][info][gc] GC(2) Pause Young (Concurrent Start) (Metadata GC Threshold) 480M->120M(512M) 30.500ms
[2026-01-02T03:04:07.600+0800][info][gc] GC(3) Concurrent Mark Cycle
[2026-01-02T03:04:08.100+0800][info][gc] GC(4) Pause Full (G1 Compaction Pause) 500M->90M(512M) 200.000ms
[2026-01-02T03:04:08.200+0800][info][gc] GC(5) Pause Young (Normal) (G1 Evacuation Pause) 90M->40M(512M) 5.250ms
`

test('java_gc_log: unified logging pause statistics are exact', () => {
  const report = parseGcLog(UNIFIED_GC, LIMITS)
  assert.equal(report.parser_version, '1')
  assert.equal(report.gc_event_count, 6)
  assert.equal(report.pause_count, 5)
  assert.equal(report.non_gc_lines, 1)
  assert.equal(report.total_pause_ms, 268.095)
  assert.equal(report.mean_pause_ms, 53.619)
  assert.equal(report.max_pause_ms, 200)
  assert.deepEqual(report.pause_percentiles, { p50_ms: 20, p90_ms: 132.2, p99_ms: 193.22, max_ms: 200 })
  assert.equal(report.young_pause_count, 4)
  assert.equal(report.full_pause_count, 1)
  assert.equal(report.concurrent_cycle_count, 1)
  assert.equal(report.heap_before_min_bytes, 90 * 1024 * 1024)
  assert.equal(report.heap_before_max_bytes, 500 * 1024 * 1024)
  assert.equal(report.heap_after_min_bytes, 40 * 1024 * 1024)
  assert.equal(report.heap_after_max_bytes, 120 * 1024 * 1024)
  assert.equal(report.heap_total_max_bytes, 512 * 1024 * 1024)
  assert.equal(report.coverage, 1)
  assert.equal(report.confidence, 'high')
})

test('java_gc_log: cause histogram and allocation-rate estimate', () => {
  const report = parseGcLog(UNIFIED_GC, LIMITS)
  assert.deepEqual(
    report.cause_histogram.map((entry) => [entry.reason, entry.count, entry.mean_pause_ms]),
    [
      ['Pause Young (Normal) (G1 Evacuation Pause)', 3, 12.532],
      ['Concurrent Mark Cycle', 1, null],
      ['Pause Full (G1 Compaction Pause)', 1, 200],
      ['Pause Young (Concurrent Start) (Metadata GC Threshold)', 1, 30.5],
    ],
  )
  assert.equal(report.unique_causes, 4)
  assert.equal(report.allocation_failures, 0)
  assert.equal(report.metadata_gc_threshold_events, 1)
  assert.equal(report.promotion_failures, 0)
  const rate = report.estimated_allocation_rate!
  assert.equal(rate.events_with_timestamp, 6)
  assert.equal(rate.window_seconds, 2.522)
  assert.equal(rate.bytes_per_second, 31_182_870)
  assert.equal(rate.bytes_per_hour, 112_258_331_344)
  assert.deepEqual(report.findings, [
    '1 pause(s) triggered by Metadata GC Threshold: class-loader or metaspace pressure is forcing collections',
    '1 full-collection pause(s) present; check old-generation occupancy and humongous allocations',
    'heap occupancy reached 97.7% before a collection: collections are running close to exhaustion',
  ])
})

test('java_gc_log: promotion failure and missing-timestamp degradation', () => {
  const legacy = `2026-01-02T03:04:05.000+0800: [GC (Allocation Failure) [PSYoungGen: 32256K->4960K(37888K)] 32256K->4984K(123904K), 0.0031234 secs] [Times: user=0.01 sys=0.00, real=0.00 secs]
2026-01-02T03:04:06.000+0800: [Full GC (Ergonomics) [PSYoungGen: 4960K->0K(37888K)] [ParOldGen: 24K->15234K(86016K)] 4984K->15234K(123904K), 0.0876543 secs] [Metaspace: 3456K->3456K(1056768K)], 0.0877123 secs] [Times: user=0.30 sys=0.00, real=0.09 secs]
2026-01-02T03:04:07.000+0800: [GC (Allocation Failure) [PSYoungGen: 15360K->512K(37888K)] 30594K->15746K(123904K), 0.0021000 secs] [Times: user=0.01 sys=0.00, real=0.00 secs]
[GC (Allocation Failure) [PSYoungGen: 15360K->512K(37888K)] 15746K->15746K(123904K), 0.0030000 secs] [Times: user=0.01 sys=0.00, real=0.00 secs]
`
  const report = parseGcLog(legacy, LIMITS)
  assert.equal(report.gc_event_count, 4)
  assert.equal(report.pause_count, 4)
  assert.equal(report.total_pause_ms, 87.712)
  assert.equal(report.mean_pause_ms, 21.928)
  assert.equal(report.max_pause_ms, 87.712)
  assert.deepEqual(report.pause_percentiles, { p50_ms: 0, p90_ms: 61.399, p99_ms: 85.081, max_ms: 87.712 })
  assert.equal(report.heap_before_min_bytes, 5_079_040)
  assert.equal(report.heap_before_max_bytes, 33_030_144)
  assert.equal(report.heap_total_max_bytes, 38_797_312)
  assert.equal(report.full_pause_count, 1)
  assert.equal(report.young_pause_count, 3)
  assert.equal(report.allocation_failures, 3)
  assert.equal(report.estimated_allocation_rate, null)
  assert.equal(report.coverage, 1)
  assert.equal(report.confidence, 'high')
})

test('java_gc_log: garbled lines are counted as unknown instead of dropped', () => {
  const garbled = `${UNIFIED_GC}
[2026-01-02T03:04:09.000+0800][info][gc] this line was edited by a human
-- GC log rotated at 03:05 --
# truncated by the terminal
`
  const report = parseGcLog(garbled, LIMITS)
  assert.equal(report.gc_event_count, 6)
  assert.equal(report.pause_count, 5)
  assert.equal(report.total_lines, 11)
  assert.equal(report.unknown_lines, 2)
  assert.deepEqual(report.unknown_samples, ['-- GC log rotated at 03:05 --', '# truncated by the terminal'])
  assert.equal(report.coverage, 0.8182)
  assert.equal(report.confidence, 'low')
  // `Using G1` shares the GC tag stream but configures rather than collects, so
  // it is classified as non-GC output instead of being reported as unknown.
  assert.equal(report.non_gc_lines, 2)
})

test('gc-log helpers scale sizes, classify generations and interpolate percentiles', () => {
  assert.equal(sizeToBytes('128', 'M'), 134_217_728)
  assert.equal(sizeToBytes('32256', 'K'), 33_030_144)
  assert.equal(sizeToBytes('1.5', 'G'), 1_610_612_736)
  assert.equal(sizeToBytes('42', ''), 42)
  assert.equal(generationOf('G1 Evacuation Pause'), 'young')
  assert.equal(generationOf('Full (G1 Compaction Pause)'), 'full')
  assert.equal(generationOf('to-space exhausted'), 'full')
  assert.equal(generationOf('G1 Mixed'), 'mixed')
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5)
  assert.equal(percentile([5], 99), 5)
  assert.equal(percentile([], 50), 0)
})

/** `mvn dependency:tree -Dverbose` output with a real conflict and a duplicate. */
const MAVEN_TREE = `[INFO] --- maven-dependency-plugin:3.6.1:tree (default-cli) @ order-service ---
[INFO] com.acme:order-service:jar:1.0.0
[INFO] +- org.springframework.boot:spring-boot-starter-web:jar:2.7.18:compile
[INFO] |  +- org.springframework:spring-web:jar:5.3.31:compile
[INFO] |  \\- org.springframework:spring-webmvc:jar:5.3.31:compile
[INFO] +- com.acme:widget-core:jar:1.2.3:compile
[INFO] |  \\- com.google.guava:guava:jar:31.1-jre:compile
[INFO] +- com.acme:widget-extras:jar:2.0.0:compile
[INFO] |  \\- com.google.guava:guava:jar:32.1.3-jre:compile (omitted for conflict with 31.1-jre)
[INFO] \\- org.apache.commons:commons-lang3:jar:3.12.0:compile
[INFO]    \\- org.apache.commons:commons-text:jar:1.10.0:compile (omitted for duplicate)
`

test('java_dependency_conflicts: Maven verbose tree finds the omitted version conflict', () => {
  const report = parseDependencyText(MAVEN_TREE, LIMITS)
  assert.equal(report.parser_version, '1')
  assert.equal(report.source, 'maven')
  assert.equal(report.edge_count, 9)
  assert.equal(report.artifact_count, 8)
  assert.equal(report.direct_edge_count, 5)
  assert.equal(report.omitted_edge_count, 2)
  assert.equal(report.duplicate_markers, 1)
  assert.equal(report.max_depth, 1)
  assert.equal(report.coverage, 1)
  assert.equal(report.confidence, 'high')
  assert.equal(report.conflicts.length, 2)
  const guava = report.conflicts.find((conflict) => conflict.artifact === 'com.google.guava:guava')!
  assert.equal(guava.kind, 'version_conflict')
  assert.deepEqual(guava.resolved_versions, ['31.1-jre'])
  assert.deepEqual(guava.omitted_versions, ['32.1.3-jre'])
  assert.deepEqual(guava.conflict_with, ['31.1-jre'])
  assert.deepEqual(guava.depths, [1])
  assert.equal(guava.omitted_edges, 1)
  assert.equal(guava.edges_omitted, 0)
  assert.equal(
    guava.summary,
    'com.google.guava:guava is requested at 31.1-jre; the build resolved 31.1-jre; 1 edge(s) pruned at depth 1..1',
  )
  const text = report.conflicts.find((conflict) => conflict.artifact === 'org.apache.commons:commons-text')!
  assert.equal(text.kind, 'omitted_duplicate')
  assert.equal(text.duplicate_edges, 1)
  assert.deepEqual(text.depths, [0])
  assert.deepEqual(report.findings, [
    '1 artifact(s) resolve to more than one version across the tree',
  ])
})

test('java_dependency_conflicts: Gradle arrow notation yields requested and resolved versions', () => {
  const gradle = `------------------------------------------------------------
Root project 'order-service'
------------------------------------------------------------

runtimeClasspath - Runtime classpath of source set 'main'.
+--- org.springframework.boot:spring-boot-starter-web:2.7.18
|    +--- org.springframework:spring-web:5.3.31
|    \\--- org.springframework:spring-webmvc:5.3.31
+--- com.acme:widget-core:1.2.3
|    \\--- com.google.guava:guava:32.1.3-jre -> 31.1-jre
+--- com.google.guava:guava:31.1-jre
\\--- org.slf4j:slf4j-api:2.0.7 -> 1.7.36
`
  const report = parseDependencyText(gradle, LIMITS)
  assert.equal(report.source, 'gradle')
  assert.equal(report.edge_count, 7)
  assert.equal(report.direct_edge_count, 4)
  assert.equal(report.omitted_edge_count, 0)
  assert.equal(report.max_depth, 1)
  assert.equal(report.coverage, 1)
  assert.equal(report.unknown_lines, 0)
  const guava = report.conflicts.find((conflict) => conflict.artifact === 'com.google.guava:guava')!
  assert.equal(guava.kind, 'version_conflict')
  assert.deepEqual(guava.resolved_versions, ['31.1-jre'])
  assert.deepEqual(guava.requested_versions, ['32.1.3-jre'])
  assert.deepEqual(guava.conflict_with, ['32.1.3-jre'])
  assert.equal(guava.edges.length, 2)
  // The arrow line (depth 1) is the pruned request; the bare direct line (depth
  // 0) is what the build kept.
  assert.equal(guava.edges[0]!.requested_version, '32.1.3-jre')
  assert.equal(guava.edges[0]!.version, '31.1-jre')
  assert.equal(guava.edges[0]!.depth, 1)
  assert.equal(guava.edges[1]!.requested_version, null)
  assert.equal(guava.edges[1]!.depth, 0)
  const slf4j = report.conflicts.find((conflict) => conflict.artifact === 'org.slf4j:slf4j-api')!
  assert.deepEqual(slf4j.resolved_versions, ['1.7.36'])
  assert.deepEqual(slf4j.requested_versions, ['2.0.7'])
})

test('java_dependency_conflicts: prose from a build log is reported as unknown lines', () => {
  const noisy = `${MAVEN_TREE}[INFO] BUILD SUCCESS
Downloading from central: https://repo1.maven.org/maven2/com/acme/widget-core/1.2.3/widget-core-1.2.3.jar
`
  const report = parseDependencyText(noisy, LIMITS)
  assert.equal(report.edge_count, 9)
  assert.equal(report.unknown_lines, 1)
  assert.deepEqual(report.unknown_samples, ['Downloading from central: https://repo1.maven.org/maven2/com/acme/widget-core/1.2.3/widget-core-1.2.3.jar'])
  assert.equal(report.coverage, 0.9231)
  assert.equal(report.confidence, 'medium')
})

test('java_dependency_conflicts: an empty paste yields an empty, low-confidence report', () => {
  const report = parseDependencyText('', LIMITS)
  assert.equal(report.edge_count, 0)
  assert.equal(report.artifact_count, 0)
  assert.equal(report.source, 'unknown')
  assert.equal(report.confidence, 'low')
  assert.deepEqual(report.conflicts, [])
})

/** A Spring MVC request failure with a folded frame tail and a `Caused by:` chain. */
const TRACE = `org.springframework.web.util.NestedServletException: Request processing failed; nested exception is java.lang.NullPointerException: Cannot invoke "com.acme.catalog.Product.getSku()" because "product" is null
	at org.springframework.web.servlet.FrameworkServlet.processRequest(FrameworkServlet.java:1014)
	at org.springframework.web.servlet.FrameworkServlet.doGet(FrameworkServlet.java:898)
	at javax.servlet.http.HttpServlet.service(HttpServlet.java:626)
	at com.acme.web.CatalogController.list(CatalogController.java:47)
	at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
	at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke(NativeMethodAccessorImpl.java:77)
	at java.base/jdk.internal.reflect.DelegatingMethodAccessorImpl.invoke(DelegatingMethodAccessorImpl.java:43)
	at java.base/java.lang.Thread.run(Thread.java:840)
Caused by: java.lang.NullPointerException: Cannot invoke "com.acme.catalog.Product.getSku()" because "product" is null
	at com.acme.catalog.CatalogService.toSku(CatalogService.java:112)
	at com.acme.catalog.CatalogService.get(CatalogService.java:64)
	at com.acme.web.CatalogController.list(CatalogController.java:45)
	... 15 more
Suppressed: java.lang.IllegalStateException: cache already closed
	at com.acme.cache.RedisCache.close(RedisCache.java:88)
	... 2 more
`

test('java_stack_trace: chain, folding and application frames are resolved exactly', () => {
  const report = parseStackTrace(TRACE, LIMITS)
  assert.equal(report.parser_version, '1')
  assert.equal(report.exception_count, 3)
  assert.equal(report.primary_message, 'Request processing failed; nested exception is java.lang.NullPointerException: Cannot invoke "com.acme.catalog.Product.getSku()" because "product" is null')
  assert.equal(report.root_cause, 'java.lang.IllegalStateException')
  assert.equal(report.total_frames, 22)
  // `... N more` lines are resolved against the nearest enclosing exception only.
  // 15 of the 18 folded frames are real; 8 of those exist on the enclosing trace
  // and the remaining 7 are counted as unresolved rather than invented.
  assert.equal(report.folded_frames_resolved, 10)
  assert.equal(report.folded_frames_unresolved, 7)
  assert.equal(report.deepest_application_frame, 'com.acme.web.CatalogController.list')
  assert.deepEqual(report.application_frames, [
    'com.acme.web.CatalogController.list',
    'com.acme.catalog.CatalogService.toSku',
    'com.acme.catalog.CatalogService.get',
    'com.acme.cache.RedisCache.close',
  ])
  assert.equal(report.test_failure, false)
  assert.equal(report.non_frame_lines, 0)
  assert.equal(report.coverage, 1)
  // An unresolved fold downgrades confidence even at full line coverage.
  assert.equal(report.confidence, 'medium')

  const [primary, caused, suppressed] = report.chain
  assert.equal(primary!.relation, 'primary')
  assert.equal(primary!.frame_count, 8)
  assert.equal(primary!.folded_frames, 0)
  assert.equal(caused!.relation, 'caused_by')
  assert.equal(caused!.folded_frames, 15)
  assert.equal(caused!.folded_resolved, 8)
  assert.equal(caused!.frame_count, 18)
  assert.deepEqual(
    caused!.frames.slice(0, 3).map((frame) => frame.method),
    ['com.acme.catalog.CatalogService.toSku', 'com.acme.catalog.CatalogService.get', 'com.acme.web.CatalogController.list'],
  )
  assert.equal(suppressed!.relation, 'suppressed')
  assert.equal(suppressed!.folded_frames, 2)
  assert.equal(suppressed!.folded_resolved, 2)
})

test('java_stack_trace: hints point at the failing application frame', () => {
  const report = parseStackTrace(TRACE, LIMITS)
  assert.deepEqual(report.hints, [
    'NullPointerException dereferences a null receiver or return value at com.acme.catalog.CatalogService.toSku; inspect the value read on the line above that call',
    'NestedServletException surfaced through com.acme.web.CatalogController.list; the application frame is the boundary to inspect, the Spring frames are plumbing',
  ])
})

test('java_stack_trace: an unresolvable fold is flagged, not invented', () => {
  const truncated = `java.lang.RuntimeException: rpc failed
	at com.acme.rpc.Client.call(Client.java:51)
	at com.acme.App.main(App.java:12)
Caused by: java.io.IOException: connection reset
	at com.acme.net.Socket.read(Socket.java:88)
	... 15 more
`
  const report = parseStackTrace(truncated, LIMITS)
  assert.equal(report.exception_count, 2)
  assert.equal(report.folded_frames_resolved, 2)
  assert.equal(report.folded_frames_unresolved, 13)
  assert.equal(report.confidence, 'medium')
  assert.equal(report.chain[1]!.frames.length, 3)
})

test('java_stack_trace: OOM variants and classpath errors get targeted hints', () => {
  const heap = parseStackTrace('java.lang.OutOfMemoryError: Java heap space\n\tat com.acme.Batch.run(Batch.java:20)\n', LIMITS)
  assert.match(heap.hints[0]!, /Java heap space means live objects did not fit/)
  const meta = parseStackTrace('java.lang.OutOfMemoryError: Metaspace\n\tat com.acme.Loader.load(Loader.java:9)\n', LIMITS)
  assert.match(meta.hints[0]!, /class metadata did not fit/)
  const cnf = parseStackTrace('java.lang.ClassNotFoundException: com.acme.Missing\n\tat com.acme.Loader.load(Loader.java:9)\n', LIMITS)
  assert.match(cnf.hints[0]!, /runtime classpath is missing this class/)
  const nsm = parseStackTrace('java.lang.NoSuchMethodError: com.acme.Widget.save(Ljava/lang/String;)V\n\tat com.acme.App.main(App.java:12)\n', LIMITS)
  assert.match(nsm.hints[0]!, /two versions of the same library are on the classpath/)
  const timeout = parseStackTrace('java.util.concurrent.TimeoutException: null\n\tat com.acme.Rpc.await(Rpc.java:5)\n', LIMITS)
  assert.match(timeout.hints[0]!, /exceeded its deadline/)
})

test('stack-trace helpers split library from application frames', () => {
  assert.equal(isLibraryFrame('java.lang.Thread.run'), true)
  assert.equal(isLibraryFrame('org.springframework.web.servlet.FrameworkServlet.processRequest'), true)
  assert.equal(isLibraryFrame('com.acme.App.main'), false)
  assert.equal(
    deepestApplicationFrame([
      { method: 'java.lang.Thread.run', file: 'Thread.java', line: 840, library: true, source_line: 2 },
      { method: 'com.acme.App.main', file: 'App.java', line: 12, library: false, source_line: 3 },
    ]),
    'com.acme.App.main',
  )
  assert.equal(deepestApplicationFrame([]), null)
})

/** Two `application.yml` revisions of the same service. */
const YAML_LEFT = `spring:
  application:
    name: order-service
  datasource:
    url: jdbc:postgresql://db:5432/orders
    username: orders
    password: hunter2
    hikari:
      maximum-pool-size: 10
server:
  port: 8080
  shutdown: immediate
logging:
  level:
    root: INFO
`
const YAML_RIGHT = `spring:
  application:
    name: order-service
  datasource:
    url: jdbc:postgresql://db-primary:5432/orders
    username: orders
    password: correct-horse
    hikari:
      maximum-pool-size: 32
      connection-timeout: 3000
server:
  port: 9090
logging:
  level:
    root: WARN
`

test('spring_config_diff: YAML keys flatten and diff by dotted path', () => {
  const report = diffSpringConfig(YAML_LEFT, YAML_RIGHT, { maxChanges: LIMITS.maxChanges, maxKeys: LIMITS.maxKeys, sampleLimit: 5 })
  assert.equal(report.parser_version, '1')
  assert.equal(report.left_dialect, 'yaml')
  assert.equal(report.right_dialect, 'yaml')
  assert.equal(report.left_keys, 8)
  assert.equal(report.right_keys, 8)
  assert.equal(report.added, 1)
  assert.equal(report.removed, 1)
  assert.equal(report.changed, 4)
  assert.equal(report.unchanged, 3)
  assert.equal(report.empty, false)
  assert.equal(report.masked_values, 2)
  assert.equal(report.coverage, 0.5333)
  assert.deepEqual(report.errors, [])
  // Adds first, then removes, then changes ordered by key: the report is stable
  // regardless of the order the two documents were pasted in.
  assert.deepEqual(
    report.changes.map((change) => `${change.op} ${change.key} ${change.left}->${change.right}`),
    [
      'add spring.datasource.hikari.connection-timeout null->3000',
      'remove server.shutdown immediate->null',
      'change logging.level.root INFO->WARN',
      'change server.port 8080->9090',
      'change spring.datasource.hikari.maximum-pool-size 10->32',
      'change spring.datasource.url jdbc:postgresql://db:5432/orders->jdbc:postgresql://db-primary:5432/orders',
    ],
  )
  // The password changed on both sides but the values never leave the caller:
  // both are masked, so the pair is not even reported as a change.
  assert.equal(report.changes.some((change) => change.key === 'spring.datasource.password'), false)
  assert.deepEqual(report.findings, ['2 secret-looking value(s) were replaced with *** before comparison'])
})

test('spring_config_diff: properties flattening, escapes and comments', () => {
  const left = `# database
spring.datasource.url=jdbc:mysql://db:3306/shop
spring.datasource.password=s3cr3t
spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.MySQLDialect
app.name=order\\:service
app.retries=3 # inline comment
broken line without separator
`
  const right = `spring.datasource.url=jdbc:mysql://db-replica:3306/shop
spring.datasource.password=r0tated
app.retries=5
`
  const report = diffSpringConfig(left, right, { maxChanges: 100, maxKeys: 100, sampleLimit: 5 }, 'properties')
  assert.equal(report.left_dialect, 'properties')
  assert.equal(report.left_keys, 5)
  assert.equal(report.right_keys, 3)
  assert.equal(report.added, 0)
  assert.equal(report.removed, 2)
  assert.equal(report.changed, 2)
  assert.equal(report.coverage, 1)
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0]!.side, 'left')
  assert.equal(report.errors[0]!.line, 7)
  assert.match(report.errors[0]!.message, /not a key\/value pair/)
  assert.deepEqual(
    report.changes.map((change) => `${change.op} ${change.key} ${change.left}->${change.right}`),
    [
      'remove app.name order:service->null',
      'remove spring.jpa.properties.hibernate.dialect org.hibernate.dialect.MySQLDialect->null',
      'change app.retries 3->5',
      'change spring.datasource.url jdbc:mysql://db:3306/shop->jdbc:mysql://db-replica:3306/shop',
    ],
  )
  assert.deepEqual(
    parseProperties(left).entries.map((entry) => entry.key),
    ['spring.datasource.url', 'spring.datasource.password', 'spring.jpa.properties.hibernate.dialect', 'app.name', 'app.retries'],
  )
  assert.equal(parseProperties(left).entries[3]!.value, 'order:service')
  assert.equal(parseProperties(left).entries[4]!.value, '3')
})

test('spring_config_diff: a mixed-dialect comparison is flagged and still comparable', () => {
  const report = diffSpringConfig('server.port=8080\n', 'server:\n  port: 9090\n', { maxChanges: 10, maxKeys: 10, sampleLimit: 5 })
  assert.equal(report.left_dialect, 'properties')
  assert.equal(report.right_dialect, 'yaml')
  assert.deepEqual(report.changes, [{ key: 'server.port', op: 'change', left: '8080', right: '9090', masked: false }])
  assert.match(report.findings[0]!, /different dialects/)
})

test('spring-config helpers mask secrets and flatten nested values', () => {
  assert.equal(isSecretKey('spring.datasource.password'), true)
  assert.equal(isSecretKey('app.api_key'), true)
  assert.equal(isSecretKey('server.port'), false)
  assert.deepEqual(flattenYaml({ a: { b: [1, 2] }, c: true }), [
    { key: 'a.b[0]', value: '1' },
    { key: 'a.b[1]', value: '2' },
    { key: 'c', value: 'true' },
  ])
})

test('every parser tolerates a property-style config that is not a YAML document', () => {
  const report = diffSpringConfig('', '', { maxChanges: 10, maxKeys: 10, sampleLimit: 5 })
  assert.equal(report.empty, true)
  assert.equal(report.changes.length, 0)
  assert.equal(report.coverage, 0)
  assert.equal(report.confidence, 'low')
})
