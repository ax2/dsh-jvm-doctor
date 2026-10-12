/**
 * Key-by-key diff of two Spring `application.yml` / `application.properties`
 * documents.
 *
 * Both documents are flattened to dotted keys first, so a YAML tree and a
 * properties file become directly comparable; secret-looking values are masked
 * before they ever reach the payload.
 * @module dsh-jvm-doctor/core/spring-config
 */
import { parse as parseYaml } from 'yaml'
import { confidenceOf, toLines } from './lines.ts'

/** Parser revision, bumped whenever the accepted grammar changes. */
export const SPRING_CONFIG_PARSER_VERSION = '1'

/** Input dialect of one document. */
export type ConfigDialect = 'yaml' | 'properties' | 'unknown'

/** One flattened key/value pair from one document. */
export interface FlatEntry {
  /** Dotted key path, e.g. `spring.datasource.url`. */
  key: string
  /** Scalar rendering of the value; masked when the key looks secret. */
  value: string
  /** Whether the value was replaced by `***`. */
  masked: boolean
  /** 1-based line of the key in its source document. */
  line: number | null
}

/** One classified difference. */
export interface ConfigChange {
  /** Dotted key path. */
  key: string
  /** Change classification. */
  op: 'add' | 'remove' | 'change'
  /** Value in the left document, `null` when absent. */
  left: string | null
  /** Value in the right document, `null` when absent. */
  right: string | null
  /** Whether either side was masked. */
  masked: boolean
}

/** One parse failure on one side. */
export interface ConfigParseError {
  /** Which document failed. */
  side: 'left' | 'right'
  /** Positioned message. */
  message: string
  /** 1-based line, when the parser knew it. */
  line: number | null
}

/** Parser-local failure, before the side is attached. */
interface ParseFailure {
  /** Positioned message. */
  message: string
  /** 1-based line, when the parser knew it. */
  line: number | null
}

/** Canonical payload of the `spring_config_diff` tool. */
export interface ConfigDiffReport {
  /** Parser revision. */
  parser_version: string
  /** Dialect detected for the left document. */
  left_dialect: ConfigDialect
  /** Dialect detected for the right document. */
  right_dialect: ConfigDialect
  /** Total flattened keys on the left. */
  left_keys: number
  /** Total flattened keys on the right. */
  right_keys: number
  /** Ordered differences. */
  changes: ConfigChange[]
  /** Differences over the report budget. */
  changes_omitted: number
  /** Keys that were added. */
  added: number
  /** Keys that were removed. */
  removed: number
  /** Keys whose value changed. */
  changed: number
  /** Keys present on both sides with the same value. */
  unchanged: number
  /** True when neither side produced a single key. */
  empty: boolean
  /** Number of masked values across both documents. */
  masked_values: number
  /** Parse failures; a failure is a successful result, not an exception. */
  errors: ConfigParseError[]
  /** Fraction of declared lines that produced a key, in `[0, 1]`. */
  coverage: number
  /** Honest confidence label. */
  confidence: 'high' | 'medium' | 'low'
  /** Human-readable warnings. */
  findings: string[]
}

/** Budgets that bound the config diff. */
export interface ConfigDiffLimits {
  /** Maximum differences serialized. */
  maxChanges: number
  /** Maximum flattened keys read per document. */
  maxKeys: number
  /** Maximum unknown-line samples, reused for coverage reporting. */
  sampleLimit: number
}

const SECRET_KEY_RE = /(?:password|passwd|secret|token|credential|api[-_.]?key|private[-_.]?key|access[-_.]?key)/iu

/** True when a key name should have its value masked. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key)
}

/** Flatten one parsed YAML value into dotted keys. */
export function flattenYaml(value: unknown, prefix = ''): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  if (value === null || value === undefined) {
    if (prefix.length > 0) out.push({ key: prefix, value: 'null' })
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      out.push(...flattenYaml(item, prefix.length > 0 ? `${prefix}[${index}]` : `[${index}]`))
    })
    return out
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out.push(...flattenYaml(nested, prefix.length > 0 ? `${prefix}.${key}` : key))
    }
    return out
  }
  out.push({ key: prefix, value: String(value) })
  return out
}

/** Detect the dialect of a document from its first meaningful line. */
export function detectDialect(text: string): ConfigDialect {
  const lines = toLines(text).filter((line) => line.text.trim().length > 0 && !line.text.trim().startsWith('#'))
  if (lines.length === 0) return 'unknown'
  const first = (lines[0] as { text: string }).text.trim()
  if (/^(?:[\w.-]+[=:]\s*.*|spring\.|server\.|logging\.)/u.test(first) && !/:\s*$/u.test(first) && first.includes('=')) return 'properties'
  if (/^[\w.-]+\s*:/u.test(first) || first.startsWith('---')) return 'yaml'
  if (first.includes('=')) return 'properties'
  return 'unknown'
}

/** Parse a `.properties` document into flattened keys. */
export function parseProperties(text: string): { entries: FlatEntry[]; errors: ParseFailure[] } {
  const entries: FlatEntry[] = []
  const errors: ParseFailure[] = []
  let pending = ''
  let pendingLine: number | null = null
  for (const line of toLines(text)) {
    const raw = line.text
    if (pending.length === 0 && (raw.trim().length === 0 || raw.trimStart().startsWith('#') || raw.trimStart().startsWith('!'))) continue
    const continued = pending.length > 0 ? `${pending}${raw.trim()}` : raw
    if (continued.endsWith('\\')) {
      pending = continued.slice(0, -1)
      pendingLine = pendingLine ?? line.number
      continue
    }
    pending = ''
    const logical = continued.trim()
    if (logical.length === 0) continue
    const separator = findSeparator(logical)
    if (separator < 0) {
      errors.push({ message: `line is not a key/value pair: ${logical.slice(0, 60)}`, line: pendingLine ?? line.number })
      pendingLine = null
      continue
    }
    const key = unescapeKey(logical.slice(0, separator).trim())
    const value = unescapeValue(logical.slice(separator + 1).trim())
    const masked = isSecretKey(key)
    entries.push({ key, value: masked ? '***' : value, masked, line: pendingLine ?? line.number })
    pendingLine = null
  }
  return { entries, errors }
}

/** Parse a YAML document into flattened keys. */
export function parseYamlDocument(text: string): { entries: FlatEntry[]; errors: ParseFailure[] } {
  try {
    const document = parseYaml(text, { uniqueKeys: false, strict: false })
    const flat = flattenYaml(document)
    return {
      entries: flat.map((entry) => ({
        key: entry.key,
        value: isSecretKey(entry.key) ? '***' : entry.value,
        masked: isSecretKey(entry.key),
        line: null,
      })),
      errors: [],
    }
  } catch (error) {
    return {
      entries: [],
      errors: [{ message: error instanceof Error ? error.message : String(error), line: null }],
    }
  }
}

/** Parse one document using the detected or supplied dialect. */
export function parseConfigDocument(text: string, dialect: ConfigDialect): { entries: FlatEntry[]; errors: ParseFailure[] } {
  if (dialect === 'properties') return parseProperties(text)
  if (dialect === 'yaml') return parseYamlDocument(text)
  return text.includes('=') && !/^\s*[\w.-]+\s*:/mu.test(text) ? parseProperties(text) : parseYamlDocument(text)
}

/**
 * Diff two Spring configuration documents key by key.
 * @param leftText - original document.
 * @param rightText - revised document.
 * @param limits - report budgets.
 * @param forced - optional dialect override applied to both sides.
 */
export function diffSpringConfig(
  leftText: string,
  rightText: string,
  limits: ConfigDiffLimits,
  forced: ConfigDialect | 'auto' = 'auto',
): ConfigDiffReport {
  const leftDialect = forced === 'auto' ? detectDialect(leftText) : forced
  const rightDialect = forced === 'auto' ? detectDialect(rightText) : forced
  const left = parseConfigDocument(leftText, leftDialect)
  const right = parseConfigDocument(rightText, rightDialect)
  const leftEntries = left.entries.slice(0, limits.maxKeys)
  const rightEntries = right.entries.slice(0, limits.maxKeys)

  const leftMap = new Map<string, FlatEntry>()
  for (const entry of leftEntries) if (!leftMap.has(entry.key)) leftMap.set(entry.key, entry)
  const rightMap = new Map<string, FlatEntry>()
  for (const entry of rightEntries) if (!rightMap.has(entry.key)) rightMap.set(entry.key, entry)

  const keys: string[] = []
  for (const entry of leftEntries) if (!keys.includes(entry.key)) keys.push(entry.key)
  for (const entry of rightEntries) if (!keys.includes(entry.key)) keys.push(entry.key)

  const changes: ConfigChange[] = []
  let unchanged = 0
  for (const key of keys) {
    const before = leftMap.get(key)
    const after = rightMap.get(key)
    const masked = (before?.masked ?? false) || (after?.masked ?? false)
    if (before === undefined && after !== undefined) {
      changes.push({ key, op: 'add', left: null, right: after.value, masked })
      continue
    }
    if (before !== undefined && after === undefined) {
      changes.push({ key, op: 'remove', left: before.value, right: null, masked })
      continue
    }
    if (before !== undefined && after !== undefined) {
      if (before.value === after.value) {
        unchanged += 1
        continue
      }
      changes.push({ key, op: 'change', left: before.value, right: after.value, masked })
    }
  }
  changes.sort((first, second) => rank(first.op) - rank(second.op) || first.key.localeCompare(second.key))

  const errors: ConfigParseError[] = [
    ...left.errors.map((error) => ({ side: 'left' as const, message: error.message, line: error.line })),
    ...right.errors.map((error) => ({ side: 'right' as const, message: error.message, line: error.line })),
  ]
  const declared = countDeclaredLines(leftText) + countDeclaredLines(rightText)
  const produced = leftEntries.length + rightEntries.length
  const coverage = declared === 0 ? (produced === 0 ? 0 : 1) : Math.min(1, produced / declared)
  const maskedValues = [...leftEntries, ...rightEntries].filter((entry) => entry.masked).length
  const maskedChanges = changes.filter((change) => change.masked && change.op === 'change').length
  const findings: string[] = []
  if (leftDialect !== rightDialect) {
    findings.push(`documents use different dialects (${leftDialect} vs ${rightDialect}); keys were flattened to dotted form before comparing`)
  }
  if (maskedValues > 0) findings.push(`${maskedValues} secret-looking value(s) were replaced with *** before comparison`)
  if (maskedChanges > 0) {
    findings.push(`${maskedChanges} changed key(s) are masked; the values differ but are never returned — compare them out of band`)
  }
  if (errors.length > 0) findings.push(`${errors.length} line(s) could not be parsed and are reported in errors, not silently dropped`)

  return {
    parser_version: SPRING_CONFIG_PARSER_VERSION,
    left_dialect: leftDialect,
    right_dialect: rightDialect,
    left_keys: leftMap.size,
    right_keys: rightMap.size,
    changes: changes.slice(0, limits.maxChanges),
    changes_omitted: Math.max(0, changes.length - limits.maxChanges),
    added: changes.filter((change) => change.op === 'add').length,
    removed: changes.filter((change) => change.op === 'remove').length,
    changed: changes.filter((change) => change.op === 'change').length,
    unchanged,
    empty: leftMap.size === 0 && rightMap.size === 0,
    masked_values: maskedValues,
    errors,
    coverage: Number(coverage.toFixed(4)),
    confidence: confidenceOf(coverage, errors.length > 0 ? 'suspicious' : 'neutral'),
    findings,
  }
}

function rank(op: ConfigChange['op']): number {
  return op === 'add' ? 0 : op === 'remove' ? 1 : 2
}

function countDeclaredLines(text: string): number {
  let count = 0
  for (const line of toLines(text)) {
    const trimmed = line.text.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    if (/^(?:---|\.\.\.)$/u.test(trimmed)) continue
    if (/^- /u.test(trimmed)) continue
    if (/^[\w$.[\]'"-]+\s*(?:[:=]|:(\s|$))/u.test(trimmed) || /^[\w$.[\]'"-]+$/u.test(trimmed)) count += 1
  }
  return count
}

function findSeparator(logical: string): number {
  let escaped = false
  for (let index = 0; index < logical.length; index += 1) {
    const ch = logical[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '=' || ch === ':') return index
  }
  return -1
}

function unescapeKey(key: string): string {
  return key.replaceAll('\\:', ':').replaceAll('\\=', '=').replaceAll('\\ ', ' ')
}

function unescapeValue(value: string): string {
  const replaced = value
    .replaceAll('\\n', '\n')
    .replaceAll('\\t', '\t')
    .replaceAll('\\:', ':')
    .replaceAll('\\=', '=')
    .replaceAll('\\ ', ' ')
    .replaceAll('\\\\', '\\')
  return replaced.replace(/\s+#.*$/u, '').trim()
}
