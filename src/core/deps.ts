/**
 * Deterministic parser for Maven `dependency:tree -Dverbose` and Gradle
 * `dependencies` / `dependencyInsight` text.
 *
 * Both build tools print the conflict verdict themselves (`omitted for conflict
 * with X`, `1.2 -> 2.0`), so the parser records that verdict instead of trying
 * to re-derive dependency mediation.
 * @module dsh-jvm-doctor/core/deps
 */
import { confidenceOf, coverage, indentOf, toLines } from './lines.ts'

/** Parser revision, bumped whenever the accepted grammar changes. */
export const DEPS_PARSER_VERSION = '1'

/** Build tool whose text was parsed. */
export type DepsSource = 'maven' | 'gradle' | 'unknown'

/** One edge of the dependency tree. */
export interface DependencyEdge {
  /** 1-based source line. */
  line: number
  /** Tree depth, `0` for a direct declaration. */
  depth: number
  /** Raw indentation width of the line. */
  indent: number
  /** `groupId:artifactId`. */
  artifact: string
  /** Version the build tool resolved this edge to. */
  version: string | null
  /** Version the edge originally asked for, when Gradle printed `X -> Y`. */
  requested_version: string | null
  /** Tree prefix character that introduced this edge. */
  connector: string
  /** Packaging/classifier suffix such as `jar`, `pom` or `test-jar`. */
  classifier: string | null
  /** Whether the build tool pruned this edge. */
  omitted: boolean
  /** Verdict text, e.g. `for conflict with 2.9.0`. */
  omitted_reason: string | null
  /** Version named inside the omitted verdict, when present. */
  omitted_with: string | null
  /** Scope column, when the text carries one. */
  scope: string | null
  /** Trailing annotation, e.g. `(*)`, `constraint`, `FAILED`. */
  note: string | null
  /** Raw line, kept verbatim for evidence. */
  raw: string
}

/** One conflicting artifact with every version requested for it. */
export interface DependencyConflict {
  /** `groupId:artifactId`. */
  artifact: string
  /** Versions on live (non-omitted) edges, in tree order. */
  resolved_versions: string[]
  /** Versions seen on pruned edges only. */
  omitted_versions: string[]
  /** Every version requested by any edge. */
  requested_versions: string[]
  /** Version named by `omitted for conflict with X`. */
  conflict_with: string[]
  /** `omitted for duplicate` edge count. */
  duplicate_edges: number
  /** Total pruned edges for this artifact. */
  omitted_edges: number
  /** Smallest tree depth at which the artifact appears. */
  min_depth: number
  /** Largest tree depth at which the artifact appears. */
  max_depth: number
  /** Distinct depths, ascending. */
  depths: number[]
  /** Conflict classification. */
  kind: 'version_conflict' | 'omitted_duplicate' | 'removed_edge'
  /** One-line explanation built only from parsed fields. */
  summary: string
  /** Every edge for this artifact, capped at the edge budget. */
  edges: DependencyEdge[]
  /** Edges over the edge budget. */
  edges_omitted: number
}

/** Canonical payload of the `java_dependency_conflicts` tool. */
export interface DependencyReport {
  /** Parser revision. */
  parser_version: string
  /** Build tool inferred from the text. */
  source: DepsSource
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
  /** Dependency edges parsed. */
  edge_count: number
  /** Distinct `groupId:artifactId` values. */
  artifact_count: number
  /** Edges the build tool pruned. */
  omitted_edge_count: number
  /** `(*)` duplicate markers. */
  duplicate_markers: number
  /** Conflicting artifacts, worst first. */
  conflicts: DependencyConflict[]
  /** Conflicts over the report budget. */
  conflicts_omitted: number
  /** Direct (depth 0) edges. */
  direct_edge_count: number
  /** Deepest edge depth seen. */
  max_depth: number
  /** Human-readable warnings derived only from the parsed edges. */
  findings: string[]
}

/** Budgets that bound the dependency report. */
export interface DepsLimits {
  /** Maximum conflicts serialized. */
  maxConflicts: number
  /** Maximum edges serialized per conflict. */
  maxEdgesPerConflict: number
  /** Maximum unknown-line samples. */
  sampleLimit: number
}

// `31.1-jre` is a version, not a classifier, so the optional classifier group is
// anchored to a letter that is not immediately followed by a digit. Without that
// lookahead the engine reads `guava:jar:31.1-jre:compile` as
// `classifier=31.1-jre, version=compile`.
const MAVEN_COORD_RE =
  /^(?<group>[\w.$\-]+):(?<artifact>[\w.$\-]+):(?<type>[\w.\-]+)(?::(?<classifier>[A-Za-z](?![0-9])[\w.\-]*))?:(?<version>[^:\s]+)(?::(?<scope>\w+))?(?:\s+\((?<note>[^)]*)\))?$/
const GRADLE_COORD_RE =
  /^(?<group>[\w.$\-]+):(?<artifact>[\w.$\-]+)(?::(?<version>[^:\s]+))?(?:\s+->\s+(?<arrow>\S+))?(?:\s+\((?<note>[^)]*)\))?$/
const GRADLE_TITLE_RE = /^(?<config>[a-zA-Z][\w-]*|:[\w.\-]+)\s+-\s+/u
const MAVEN_NOTE_RE = /^(?<text>omitted for [\w ]+)$/u
const VERSION_TOKEN_RE = /^[\w.$\-+]+$/u

/**
 * Parse a pasted dependency tree.
 * @param text - raw build-tool output.
 * @param limits - report budgets.
 */
export function parseDependencyText(text: string, limits: DepsLimits): DependencyReport {
  const lines = toLines(text)
  const consumed = new Set<number>()
  const edges: DependencyEdge[] = []
  let mavenEvidence = 0
  let gradleEvidence = 0
  let duplicateMarkers = 0

  for (const line of lines) {
    const trimmed = line.text.trim()
    if (trimmed.length === 0) {
      consumed.add(line.number)
      continue
    }
    // Maven prefixes every line of `dependency:tree` with a log tag. Strip the
    // tag and keep going, so a `[INFO] +- group:artifact:...` line is parsed as a
    // coordinate instead of being discarded as log noise.
    const tag = /^(?:\[(?<tag>[A-Z]+)\]\s*|(?<gradle>> Task.*|BUILD SUCCESSFUL.*|BUILD FAILED.*|Deprecated Gradle features.*|Welcome to Gradle.*))/u.exec(trimmed)
    const content = tag === null ? trimmed : trimmed.slice(tag[0].length).trim()
    if (tag !== null) {
      if (/(?:dependency:tree|maven-dependency-plugin)/iu.test(content)) mavenEvidence += 1
      if (content.length === 0 || !/^(?:[|+\\-]|\(\*\)|\.\.\.)/u.test(content)) {
        consumed.add(line.number)
        continue
      }
    }
    if (GRADLE_TITLE_RE.test(content) && !content.includes(':')) {
      // `compileClasspath - Compile classpath for source set 'main'.`
      consumed.add(line.number)
      gradleEvidence += 1
      continue
    }
    if (/^\+---|^\\---|^\| {3}|^ {5}\+---|^ {5}\\---|^\.\.\./u.test(content) || /^\| {3}/u.test(content)) {
      gradleEvidence += 1
    }
    if (/^(?:\+-|\\-|\(\*\)|\|)/u.test(content)) mavenEvidence += 1

    const indent = indentOf(content)
    const structure = treeDepthOf(content)
    // Strip the tree drawing characters: a leading run of pipes, plus/minus,
    // backslashes and spaces, then any `---`/`--` connector run. Leaving the
    // dashes behind would hide the coordinate from every coordinate pattern.
    const body = content.replace(/^[|+\\\s-]+/u, '')
    const connector = structure.connector

    const mavenNote = MAVEN_NOTE_RE.exec(body)
    const mavenCoord = MAVEN_COORD_RE.exec(body)
    const gradleCoord = GRADLE_COORD_RE.exec(body)

    if (body === '(*)') {
      consumed.add(line.number)
      duplicateMarkers += 1
      continue
    }
    if (mavenNote?.groups?.text !== undefined && /^(?:omitted|version managed)/u.test(mavenNote.groups.text)) {
      // A bare `(omitted for duplicate)` annotation applies to the previous edge.
      const note = mavenNote.groups.text
      const previous = edges[edges.length - 1]
      if (previous !== undefined) {
        previous.omitted = true
        previous.omitted_reason = note
        const withVersion = /conflict with (?<version>\S+)/u.exec(note)
        if (withVersion?.groups?.version !== undefined) previous.omitted_with = withVersion.groups.version
        if (/duplicate/u.test(note)) duplicateMarkers += 1
      }
      consumed.add(line.number)
      continue
    }

    const parsed = parseCoordinate(body, gradleCoord !== null && mavenCoord === null ? 'gradle' : 'auto')
    if (parsed !== null) {
      edges.push({
        line: line.number,
        depth: structure.depth,
        indent,
        artifact: `${parsed.group}:${parsed.artifact}`,
        version: parsed.version,
        requested_version: parsed.requested ?? null,
        connector,
        classifier: parsed.classifier,
        omitted: parsed.omitted,
        omitted_reason: parsed.omittedReason,
        omitted_with: parsed.omittedWith,
        scope: parsed.scope,
        note: parsed.note,
        raw: trimmed,
      })
      if (parsed.omittedReason !== null && /duplicate/u.test(parsed.omittedReason)) duplicateMarkers += 1
      consumed.add(line.number)
      continue
    }

    if (/^:[\w.-]+$/u.test(body) || /^(?:project|variant)\s/u.test(body) || /^No dependencies$/u.test(body)) {
      consumed.add(line.number)
      gradleEvidence += 1
      continue
    }
    if (/^-{3,}$/u.test(content)) {
      // Title/separator rules above a Gradle tree carry no dependency data.
      consumed.add(line.number)
      continue
    }
    if (
      /^-+$/u.test(body) ||
      /^Root project/u.test(body) ||
      /^--- /u.test(body) ||
      /^Dependencies for/u.test(body) ||
      // `--- maven-dependency-plugin:3.6.1:tree (default-cli) @ order-service ---`
      /^[\w.-]+(?:[:.][\w.-]+)+[\s(]/u.test(body)
    ) {
      consumed.add(line.number)
      continue
    }
  }

  // -------------------------------------------------------------- conflicts ---
  const byArtifact = new Map<string, DependencyEdge[]>()
  for (const edge of edges) {
    const bucket = byArtifact.get(edge.artifact) ?? []
    bucket.push(edge)
    byArtifact.set(edge.artifact, bucket)
  }

  const conflicts: DependencyConflict[] = []
  for (const [artifact, bucket] of byArtifact) {
    const resolved = unique(bucket.filter((edge) => !edge.omitted).map((edge) => edge.version))
    const requested = unique(bucket.flatMap((edge) => (edge.requested_version !== null ? [edge.requested_version] : [])))
    const omittedVersions = unique(bucket.filter((edge) => edge.omitted).map((edge) => edge.version))
    const conflictWith = unique(bucket.map((edge) => edge.omitted_with))
    const omittedEdges = bucket.filter((edge) => edge.omitted)
    const duplicateEdges = omittedEdges.filter((edge) => edge.omitted_reason !== null && /duplicate/u.test(edge.omitted_reason)).length
    const everyVersion = unique([...resolved, ...requested, ...omittedVersions, ...conflictWith])
    const versionConflict = everyVersion.length > 1 || conflictWith.length > 0
    if (!versionConflict && omittedEdges.length === 0) continue
    const depths = unique(bucket.map((edge) => edge.depth)).sort((left, right) => left - right)
    const kind: DependencyConflict['kind'] = versionConflict
      ? 'version_conflict'
      : duplicateEdges > 0
        ? 'omitted_duplicate'
        : 'removed_edge'
    const bounded = bucket.slice(0, limits.maxEdgesPerConflict)
    conflicts.push({
      artifact,
      resolved_versions: resolved,
      omitted_versions: omittedVersions,
      requested_versions: requested,
      conflict_with: conflictWith,
      duplicate_edges: duplicateEdges,
      omitted_edges: omittedEdges.length,
      min_depth: depths[0] ?? 0,
      max_depth: depths[depths.length - 1] ?? 0,
      depths,
      kind,
      summary: summarize(artifact, kind, resolved, conflictWith, requested, depths, omittedEdges.length),
      edges: bounded,
      edges_omitted: bucket.length - bounded.length,
    })
  }
  conflicts.sort(
    (left, right) =>
      Number(right.kind === 'version_conflict') - Number(left.kind === 'version_conflict') ||
      right.omitted_edges - left.omitted_edges ||
      (left.min_depth - right.min_depth) ||
      left.artifact.localeCompare(right.artifact),
  )

  const cover = coverage(lines, consumed, limits.sampleLimit)
  const findings: string[] = []
  if (conflicts.some((conflict) => conflict.kind === 'version_conflict')) {
    findings.push(`${conflicts.filter((conflict) => conflict.kind === 'version_conflict').length} artifact(s) resolve to more than one version across the tree`)
  }
  const deepOmissions = conflicts.filter((conflict) => conflict.max_depth >= 3)
  if (deepOmissions.length > 0) {
    findings.push(`${deepOmissions.length} conflict(s) first appear at depth 3 or deeper, where mediation is hardest to reason about by hand`)
  }
  const source: DepsSource = gradleEvidence > mavenEvidence ? 'gradle' : mavenEvidence > 0 ? 'maven' : 'unknown'

  return {
    parser_version: DEPS_PARSER_VERSION,
    source,
    total_lines: lines.length,
    parsed_lines: cover.parsed,
    unknown_lines: cover.unknown,
    unknown_samples: cover.samples,
    coverage: Number(cover.ratio.toFixed(4)),
    confidence: text.trim().length === 0 ? 'low' : confidenceOf(cover.ratio, edges.length === 0 ? 'suspicious' : 'neutral'),
    edge_count: edges.length,
    artifact_count: byArtifact.size,
    omitted_edge_count: edges.filter((edge) => edge.omitted).length,
    duplicate_markers: duplicateMarkers,
    conflicts: conflicts.slice(0, limits.maxConflicts),
    conflicts_omitted: Math.max(0, conflicts.length - limits.maxConflicts),
    direct_edge_count: edges.filter((edge) => edge.depth === 0).length,
    max_depth: edges.reduce((max, edge) => Math.max(max, edge.depth), 0),
    findings,
  }
}

/** One parsed coordinate line. */
interface ParsedCoordinate {
  group: string
  artifact: string
  version: string | null
  requested: string | null
  classifier: string | null
  scope: string | null
  note: string | null
  omitted: boolean
  omittedReason: string | null
  omittedWith: string | null
}

function parseCoordinate(body: string, flavour: 'auto' | 'gradle'): ParsedCoordinate | null {
  const maven = MAVEN_COORD_RE.exec(body)
  const gradle = flavour === 'auto' ? GRADLE_COORD_RE.exec(body) : GRADLE_COORD_RE.exec(body)
  if (maven?.groups !== undefined && flavour !== 'gradle') {
    const groups = maven.groups
    const note = groups.note ?? null
    const omitted = note !== null && /^omitted/u.test(note)
    const withVersion = note !== null ? /conflict with (?<version>\S+)/u.exec(note) : null
    return {
      group: groups.group as string,
      artifact: groups.artifact as string,
      version: versionOrNull(groups.version),
      requested: null,
      classifier: groups.type !== undefined && groups.type !== 'jar' ? groups.type : groups.classifier ?? null,
      scope: groups.scope ?? null,
      note,
      omitted,
      omittedReason: omitted ? note : null,
      omittedWith: withVersion?.groups?.version ?? null,
    }
  }
  if (gradle?.groups !== undefined) {
    const groups = gradle.groups
    const note = groups.note ?? null
    const arrow = groups.arrow ?? null
    const requested = groups.version !== undefined ? versionOrNull(groups.version) : null
    const omitted = note !== null && /^omitted|^constraint|^duplicate/u.test(note)
    return {
      group: groups.group as string,
      artifact: groups.artifact as string,
      version: arrow !== null ? versionOrNull(arrow) : requested,
      requested: arrow !== null ? requested : null,
      classifier: null,
      scope: null,
      note,
      omitted,
      omittedReason: omitted ? note : null,
      omittedWith: arrow !== null ? requested : null,
    }
  }
  return null
}

function versionOrNull(token: string | undefined): string | null {
  if (token === undefined) return null
  const cleaned = token.trim()
  if (cleaned.length === 0 || cleaned === '(*)') return null
  return VERSION_TOKEN_RE.test(cleaned) ? cleaned : null
}

/**
 * Derive the tree depth from the ASCII tree structure rather than a fixed indent
 * width: one level per preceding `|` ancestry marker. The line's own connector
 * opens its level rather than counting as one, so a top-level dependency
 * (`+--- org.spring...`) is depth 0 and its child (`|    \--- org.spring...`)
 * is depth 1 — the same numbers for Maven (3 spaces) and Gradle (5 spaces).
 * @param text - line content, with any log tag prefix already removed.
 */
export function treeDepthOf(text: string): { depth: number; connector: string; pipes: number } {
  let cursor = 0
  let pipes = 0
  while (cursor < text.length) {
    const ch = text[cursor]
    if (ch === '|') {
      // A `|` immediately followed by a connector is the ancestor marker for the
      // line's own branch, not an extra level.
      const next = text[cursor + 1]
      if (next !== undefined && /[+\\`]/.test(next)) break
      pipes += 1
      cursor += 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      cursor += 1
      continue
    }
    break
  }
  const connectorMatch = /^(?<connector>[+\\.`-]+)/u.exec(text.slice(cursor))
  const connector = connectorMatch?.groups?.connector ?? ''
  return { depth: pipes, connector, pipes }
}

function unique<T>(values: readonly (T | null | undefined)[]): Array<Exclude<T, null | undefined>> {
  const out: Array<Exclude<T, null | undefined>> = []
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && value.length === 0) continue
    if (!out.includes(value as Exclude<T, null | undefined>)) out.push(value as Exclude<T, null | undefined>)
  }
  return out
}

function summarize(
  artifact: string,
  kind: DependencyConflict['kind'],
  resolved: readonly string[],
  conflictWith: readonly string[],
  requested: readonly string[],
  depths: readonly number[],
  omittedEdges: number,
): string {
  const depth = depths.length === 0 ? 'unknown' : `${depths[0]}..${depths[depths.length - 1]}`
  if (kind === 'version_conflict') {
    const versions = unique([...resolved, ...conflictWith, ...requested]).join(', ')
    return `${artifact} is requested at ${versions || 'multiple versions'}; the build resolved ${resolved.join(', ') || 'none'}; ${omittedEdges} edge(s) pruned at depth ${depth}`
  }
  if (kind === 'omitted_duplicate') {
    return `${artifact} appears ${omittedEdges} extra time(s) as a duplicate of an already-resolved edge at depth ${depth}`
  }
  return `${artifact} has ${omittedEdges} pruned edge(s) at depth ${depth}`
}
