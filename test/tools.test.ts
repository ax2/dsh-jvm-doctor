/**
 * Assembled-path tests: these exercise the tools exactly as the registry does
 * (`definition.execute` then `definition.output.render`), so a schema, envelope
 * or renderer regression fails here rather than in production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Envelope } from '../src/core/receipt.ts'
import { createTools, compileParameters } from '../src/tools.ts'
import { DEFAULT_LIMITS, resolveLimits, type Config } from '../src/limits.ts'

/** Every tool built with the default budgets. */
const tools = createTools({ limits: DEFAULT_LIMITS })

/** Look up a registered definition by name. */
function tool(name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name)
  assert.ok(found, `tool ${name} is not registered`)
  return found
}

/** Execute a tool with a synthetic, always-live execution context. */
async function run(name: string, args: Record<string, unknown>): Promise<Envelope<Record<string, unknown>>> {
  const definition = tool(name)
  const value = (await definition.execute(args, { signal: new AbortController().signal } as never)) as Envelope<
    Record<string, unknown>
  >
  return value
}

/** Render a canonical value exactly as the registry would. */
function render(name: string, value: unknown): string {
  const definition = tool(name)
  const output = definition.output as { render?: (args: unknown, value: unknown) => { text: string }[] }
  const blocks = output.render?.({}, value) ?? []
  return blocks.map((block) => block.text).join('\n')
}

/** A real (abridged) `jstack -l` dump with a two-thread deadlock. */
const JSTACK = `2026-01-02 03:04:05
Full thread dump OpenJDK 64-Bit Server VM (21.0.4+7-LTS-103 mixed mode, sharing):

"main" #1 prio=5 os_prio=0 cpu=310.55ms elapsed=812.94s tid=0x0000023b8c018800 nid=0x1f14 waiting on condition  [0x000000d3a46fe000]
   java.lang.Thread.State: WAITING (parking)
	at jdk.internal.misc.Unsafe.park(java.base@21.0.4/Native Method)
	- parking to wait for  <0x0000000712a1b3d0> (a java.util.concurrent.CountDownLatch$Sync)
	at com.acme.boot.Bootstrap.main(Bootstrap.java:41)

"deadlock-A" #40 prio=5 os_prio=0 cpu=3.00ms elapsed=100.00s tid=0x0000023b8c400800 nid=0x2b00 waiting for monitor entry  [0x000000d3a60fe000]
   java.lang.Thread.State: BLOCKED (on object monitor)
	at com.acme.order.Inventory.reserve(Inventory.java:61)
	- waiting to lock <0x0000000712d00020> (a com.acme.order.Inventory)
	at com.acme.order.OrderDao.save(OrderDao.java:150)
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

/** A JEP 158 unified GC log with one full collection. */
const UNIFIED_GC = `[2026-01-02T03:04:05.678+0800][info][gc] Using G1
[2026-01-02T03:04:05.678+0800][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 128M->45M(512M) 12.345ms
[2026-01-02T03:04:06.100+0800][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 300M->60M(512M) 20.000ms
[2026-01-02T03:04:07.100+0800][info][gc] GC(2) Pause Young (Concurrent Start) (Metadata GC Threshold) 480M->120M(512M) 30.500ms
[2026-01-02T03:04:07.600+0800][info][gc] GC(3) Concurrent Mark Cycle
[2026-01-02T03:04:08.100+0800][info][gc] GC(4) Pause Full (G1 Compaction Pause) 500M->90M(512M) 200.000ms
[2026-01-02T03:04:08.200+0800][info][gc] GC(5) Pause Young (Normal) (G1 Evacuation Pause) 90M->40M(512M) 5.250ms
`

/** A Maven `dependency:tree -Dverbose` excerpt with two prune verdicts. */
const MAVEN_TREE = `[INFO] --- maven-dependency-plugin:3.6.1:tree (default-cli) @ order-service ---
[INFO] com.acme:order-service:jar:1.0.0
[INFO] +- org.springframework.boot:spring-boot-starter-web:jar:2.7.18:compile
[INFO] |  \\- org.springframework:spring-web:jar:5.3.31:compile
[INFO] +- com.acme:widget-core:jar:1.2.3:compile
[INFO] |  \\- com.google.guava:guava:jar:31.1-jre:compile
[INFO] +- com.acme:widget-extras:jar:2.0.0:compile
[INFO] |  \\- com.google.guava:guava:jar:32.1.3-jre:compile (omitted for conflict with 31.1-jre)
[INFO] \\- org.apache.commons:commons-lang3:jar:3.12.0:compile
`

/** A Spring traceback with a causal chain and a suppressed exception. */
const TRACE = `org.springframework.web.util.NestedServletException: Request processing failed; nested exception is java.lang.NullPointerException: Cannot invoke "com.acme.catalog.Product.getSku()" because "product" is null
	at org.springframework.web.servlet.FrameworkServlet.processRequest(FrameworkServlet.java:1014)
	at com.acme.web.CatalogController.list(CatalogController.java:64)
	at java.base/java.lang.Thread.run(Thread.java:1583)
Caused by: java.lang.NullPointerException: Cannot invoke "com.acme.catalog.Product.getSku()" because "product" is null
	at com.acme.catalog.CatalogService.toSku(CatalogService.java:112)
	... 15 more
`

/** Two Spring documents whose only password change must stay masked. */
const YAML_LEFT = `server:
  port: 8080
spring:
  datasource:
    url: jdbc:postgresql://db:5432/orders
    password: s3cr3t
logging:
  level:
    root: INFO
`
const YAML_RIGHT = `server:
  port: 9090
spring:
  datasource:
    url: jdbc:postgresql://db:5432/orders
    password: r0tated
logging:
  level:
    root: WARN
`

test('every tool declares a name, description, compiled schema, and receipt meta', () => {
  assert.equal(tools.length, 5)
  const expectedParameters: Record<string, string[]> = {
    java_thread_dump: ['text'],
    java_gc_log: ['text'],
    java_dependency_conflicts: ['text'],
    java_stack_trace: ['text'],
    spring_config_diff: ['dialect', 'left', 'right'],
  }
  const names = new Set<string>()
  for (const definition of tools) {
    assert.equal(names.has(definition.name), false, `duplicate tool name ${definition.name}`)
    names.add(definition.name)
    assert.ok(definition.description.length > 40, `${definition.name} needs a real description`)
    const projected = definition.parameters as { type?: string; properties?: Record<string, unknown> }
    assert.equal(projected.type, 'object')
    assert.deepEqual(Object.keys(projected.properties ?? {}).sort(), expectedParameters[definition.name])
    const output = definition.output as { schema?: { type?: string; properties?: Record<string, unknown> } }
    assert.equal(output.schema?.type, 'object')
    assert.deepEqual(Object.keys(output.schema?.properties ?? {}).sort(), ['meta', 'result'])
  }
  assert.deepEqual([...names].sort(), [
    'java_dependency_conflicts',
    'java_gc_log',
    'java_stack_trace',
    'java_thread_dump',
    'spring_config_diff',
  ])
})

test('every tool description states that it is offline and what it refuses', () => {
  for (const definition of tools) {
    assert.match(definition.description, /[Oo]ffline only/, `${definition.name} must state its offline contract`)
    assert.match(definition.description, /Refuses \(throws\)/, `${definition.name} must state its refusal`)
    assert.match(definition.description, /maxInputBytes/, `${definition.name} must name the budget it refuses on`)
  }
})

test('the parameter DSL compiles to JSON Schema with required flags preserved', () => {
  const compiled = compileParameters({ text: { type: 'string', required: true }, level: { type: 'integer' } }) as {
    type: string
    properties: Record<string, { type: string }>
    required: string[]
  }
  assert.equal(compiled.type, 'object')
  assert.deepEqual(Object.keys(compiled.properties), ['text', 'level'])
  assert.equal(compiled.properties.text?.type, 'string')
  assert.deepEqual(compiled.required, ['text'])
})

test('java_thread_dump returns a receipt with a deadlock cycle and renders a footer only for the unknown-line note', async () => {
  const value = await run('java_thread_dump', { text: JSTACK })
  const result = value.result as Record<string, unknown>
  assert.equal(result.thread_count, 3)
  assert.equal(result.deadlock_marker, true)
  assert.equal(result.reported_deadlock_count, 1)
  assert.equal(result.unknown_lines, 0)
  assert.equal(result.confidence, 'high')
  assert.equal(value.meta.bytesIn, Buffer.byteLength(JSTACK, 'utf8'))
  assert.equal(value.meta.truncated, false)
  assert.deepEqual(value.meta.notes, [])

  const rendered = render('java_thread_dump', value)
  // A clean call costs no extra tokens: no `[bounded]`/`[note]` footer.
  assert.equal(rendered.includes('[note]'), false)
  assert.equal(rendered.includes('[bounded]'), false)
  assert.deepEqual(JSON.parse(rendered), value.result)
})

test('java_thread_dump notes unknown lines and never silently drops them', async () => {
  const noisy = `${JSTACK}profiler attached at 03:05
`
  const value = await run('java_thread_dump', { text: noisy })
  const result = value.result as Record<string, unknown>
  assert.equal(result.unknown_lines, 1)
  assert.deepEqual(result.unknown_samples, ['profiler attached at 03:05'])
  assert.equal(value.meta.notes.length, 1)
  assert.match(value.meta.notes[0]!, /1 of 50 line\(s\) matched no known dump shape/)
  const rendered = render('java_thread_dump', value)
  assert.match(rendered, /\[note\] 1 of 50 line\(s\) matched no known dump shape/)
})

test('java_thread_dump refuses over-budget input instead of parsing a prefix', async () => {
  const tiny = createTools({ limits: { ...DEFAULT_LIMITS, maxInputBytes: 512 } })
  const definition = tiny.find((candidate) => candidate.name === 'java_thread_dump')!
  await assert.rejects(
    () => definition.execute({ text: JSTACK }, { signal: new AbortController().signal } as never),
    /thread dump is \d+ UTF-8 bytes, above the configured limit of 512 bytes/,
  )
})

test('java_thread_dump aborts when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => tool('java_thread_dump').execute({ text: JSTACK }, { signal: controller.signal } as never),
    /abort/i,
  )
})

test('java_gc_log reports pause statistics and the non-GC configuration line', async () => {
  const value = await run('java_gc_log', { text: UNIFIED_GC })
  const result = value.result as Record<string, unknown>
  assert.equal(result.gc_event_count, 6)
  assert.equal(result.pause_count, 5)
  assert.equal(result.non_gc_lines, 1)
  assert.equal(result.total_pause_ms, 268.095)
  assert.equal(result.coverage, 1)
  assert.equal(value.meta.truncated, false)
  assert.deepEqual(value.meta.notes, [])
  const rendered = render('java_gc_log', value)
  assert.equal(rendered.includes('[note]'), false)
})

test('java_gc_log notes an empty match instead of pretending success', async () => {
  const value = await run('java_gc_log', { text: 'no collector output here\n' })
  const result = value.result as Record<string, unknown>
  assert.equal(result.gc_event_count, 0)
  assert.equal(result.unknown_lines, 1)
  assert.match(value.meta.notes.join('\n'), /no GC event matched/)
  assert.match(value.meta.notes.join('\n'), /matched neither the unified nor the legacy GC grammar/)
})

test('java_dependency_conflicts finds the pruned version edge', async () => {
  const value = await run('java_dependency_conflicts', { text: MAVEN_TREE })
  const result = value.result as Record<string, unknown>
  assert.equal(result.source, 'maven')
  assert.equal(result.edge_count, 7)
  assert.equal(result.omitted_edge_count, 1)
  const conflicts = result.conflicts as Array<Record<string, unknown>>
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]!.artifact, 'com.google.guava:guava')
  assert.deepEqual(conflicts[0]!.resolved_versions, ['31.1-jre'])
  assert.deepEqual(conflicts[0]!.omitted_versions, ['32.1.3-jre'])
  assert.deepEqual(value.meta.notes, [])
})

test('java_dependency_conflicts reports unrecognized build chatter', async () => {
  const noisy = `${MAVEN_TREE}Downloading from central: https://repo1.maven.org/maven2/com/acme/widget-core/1.2.3/widget-core-1.2.3.jar
`
  const value = await run('java_dependency_conflicts', { text: noisy })
  const result = value.result as Record<string, unknown>
  assert.equal(result.unknown_lines, 1)
  assert.deepEqual(result.unknown_samples, [
    'Downloading from central: https://repo1.maven.org/maven2/com/acme/widget-core/1.2.3/widget-core-1.2.3.jar',
  ])
  assert.match(value.meta.notes[0]!, /1 of 10 line\(s\) matched no known dependency shape/)
})

test('java_dependency_conflicts refuses over-budget input', async () => {
  const tiny = createTools({ limits: { ...DEFAULT_LIMITS, maxInputBytes: 256 } })
  const definition = tiny.find((candidate) => candidate.name === 'java_dependency_conflicts')!
  await assert.rejects(
    () => definition.execute({ text: MAVEN_TREE }, { signal: new AbortController().signal } as never),
    /dependency tree is \d+ UTF-8 bytes, above the configured limit of 256 bytes/,
  )
})

test('java_stack_trace keeps the causal chain and flags an unresolved fold', async () => {
  const value = await run('java_stack_trace', { text: TRACE })
  const result = value.result as Record<string, unknown>
  assert.equal(result.exception_count, 2)
  assert.equal(result.root_cause, 'java.lang.NullPointerException')
  assert.equal(result.folded_frames_resolved, 3)
  assert.equal(result.folded_frames_unresolved, 12)
  assert.equal(result.confidence, 'medium')
  const chain = result.chain as Array<Record<string, unknown>>
  assert.deepEqual(chain.map((entry) => entry.relation), ['primary', 'caused_by'])
  assert.equal(chain[1]!.frame_count, 16)
  // The unresolved `... 15 more` is reported, never invented and never dropped.
  assert.equal(value.meta.notes.length, 1)
  assert.match(value.meta.notes[0]!, /12 frame\(s\) hidden behind `\.\.\. N more` could not be resolved/)
})

test('spring_config_diff masks both sides of a secret and reports no plaintext', async () => {
  const value = await run('spring_config_diff', { left: YAML_LEFT, right: YAML_RIGHT })
  const result = value.result as Record<string, unknown>
  assert.equal(result.left_keys, 4)
  assert.equal(result.right_keys, 4)
  assert.equal(result.changed, 2)
  assert.equal(result.unchanged, 2)
  assert.equal(result.masked_values, 2)
  assert.deepEqual(result.errors, [])
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('s3cr3t'), false, 'the left secret must never leave the tool')
  assert.equal(serialized.includes('r0tated'), false, 'the right secret must never leave the tool')
  assert.deepEqual(result.findings, ['2 secret-looking value(s) were replaced with *** before comparison'])
})

test('spring_config_diff reports a properties line it cannot parse', async () => {
  const value = await run('spring_config_diff', {
    left: 'app.name=order-service\nthis line has no separator\n',
    right: 'app.name=order-service\n',
  })
  const result = value.result as Record<string, unknown>
  assert.equal(result.left_dialect, 'properties')
  const errors = result.errors as Array<Record<string, unknown>>
  assert.equal(errors.length, 1)
  const error = errors[0]!
  assert.equal(error.side, 'left')
  assert.equal(error.line, 2)
  assert.match(String(error.message), /not a key\/value pair/)
})

test('the `only` filter registers exactly the named tools', () => {
  const filtered = createTools({ limits: DEFAULT_LIMITS, only: ['java_gc_log', 'java_stack_trace'] })
  assert.deepEqual(filtered.map((definition) => definition.name).sort(), ['java_gc_log', 'java_stack_trace'])
})

test('the `toolPrefix` option renames without changing behaviour', async () => {
  const prefixed = createTools({ limits: DEFAULT_LIMITS, prefix: 'acme' })
  assert.deepEqual(prefixed.map((definition) => definition.name).sort(), [
    'acme__java_dependency_conflicts',
    'acme__java_gc_log',
    'acme__java_stack_trace',
    'acme__java_thread_dump',
    'acme__spring_config_diff',
  ])
  const gc = prefixed.find((definition) => definition.name === 'acme__java_gc_log')!
  const value = (await gc.execute({ text: UNIFIED_GC }, { signal: new AbortController().signal } as never)) as Envelope<
    Record<string, unknown>
  >
  assert.equal((value.result as Record<string, unknown>).pause_count, 5)
})

test('resolveLimits falls back to defaults on illegal values', () => {
  const illegal: Config = {
    maxInputBytes: 0,
    maxOutputBytes: -1,
    maxThreads: Number.NaN,
    maxGcEvents: 1.5,
    sampleLimit: Number.POSITIVE_INFINITY,
    toolPrefix: 'acme',
    only: ['java_gc_log'],
  }
  const limits = resolveLimits(illegal)
  assert.equal(limits.maxInputBytes, DEFAULT_LIMITS.maxInputBytes)
  assert.equal(limits.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes)
  assert.equal(limits.maxThreads, DEFAULT_LIMITS.maxThreads)
  assert.equal(limits.maxGcEvents, 1)
  assert.equal(limits.sampleLimit, DEFAULT_LIMITS.sampleLimit)
  assert.equal(resolveLimits({}).maxInputBytes, DEFAULT_LIMITS.maxInputBytes)
})

test('every budget that clips a list reports the exact number of dropped entries', async () => {
  const tight = createTools({
    limits: { ...DEFAULT_LIMITS, maxExceptions: 1, maxFramesPerException: 1, maxConflicts: 1, maxEdgesPerConflict: 1, maxGcEvents: 1 },
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    const definition = tight.find((candidate) => candidate.name === name)!
    return (await definition.execute(args, { signal: new AbortController().signal } as never)) as Envelope<Record<string, unknown>>
  }
  const truncating = await call('java_stack_trace', { text: TRACE })
  const trace = truncating.result as Record<string, unknown>
  assert.equal(trace.exception_count, 2)
  assert.equal((trace.chain as unknown[]).length, 1)
  assert.equal(trace.exceptions_omitted, 1)
  assert.ok((trace.frames_omitted as number) > 0)
  assert.equal(truncating.meta.truncated, true)
  assert.match(truncating.meta.notes.join('\n'), /exception chain clipped to maxExceptions=1 \(1 omitted\)/)
  assert.match(truncating.meta.notes.join('\n'), /frame list clipped to maxFramesPerException=1/)

  const deps = await call('java_dependency_conflicts', { text: MAVEN_TREE })
  const depsResult = deps.result as Record<string, unknown>
  const conflicts = depsResult.conflicts as Array<Record<string, unknown>>
  assert.equal(depsResult.conflicts_omitted, 0)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]!.edges_omitted, 1)
  assert.equal(deps.meta.truncated, true)
  assert.match(deps.meta.notes.join('\n'), /edge list clipped to maxEdgesPerConflict=1 \(1 edge\(s\) omitted\)/)

  const gc = await call('java_gc_log', { text: UNIFIED_GC })
  const gcResult = gc.result as Record<string, unknown>
  assert.equal(gcResult.unique_causes, 4)
  assert.equal((gcResult.cause_histogram as unknown[]).length, 1)
  assert.equal(gcResult.causes_omitted, 3)
  assert.equal(gc.meta.truncated, true)
  assert.match(gc.meta.notes.join('\n'), /cause histogram clipped to maxGcEvents=1 \(3 cause\(s\) omitted of 4\)/)
})

test('a tiny maxOutputBytes clips rendered text and says so in the receipt', async () => {
  const clipped = createTools({ limits: { ...DEFAULT_LIMITS, maxOutputBytes: 512 } })
  const definition = clipped.find((candidate) => candidate.name === 'java_gc_log')!
  const value = (await definition.execute({ text: UNIFIED_GC }, { signal: new AbortController().signal } as never)) as Envelope<
    Record<string, unknown>
  >
  // meta always describes the true payload, even when the rendered text is clipped.
  assert.equal(value.meta.truncated, false)
  assert.ok(value.meta.bytesOut > 512)
  const output = definition.output as { render: (args: unknown, rendered: unknown) => { text: string }[] }
  const text = output.render({}, value).map((block) => block.text).join('\n')
  assert.ok(Buffer.byteLength(text, 'utf8') < value.meta.bytesOut)
  assert.match(text, /\[bounded\] input=\d+B output=\d+B/)
  assert.match(text, /\[note\] rendered text clipped to maxOutputBytes=512/)
})
