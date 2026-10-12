/**
 * Line splitting shared by every report parser.
 *
 * Reports arrive from heterogeneous producers (Windows shells, CI logs, copied
 * chat text), so a single deterministic splitter guarantees identical line
 * numbering across tools.
 * @module dsh-jvm-doctor/core/lines
 */

/** One source line plus its 1-based number in the original document. */
export interface SourceLine {
  /** 1-based line number, counted after CR/LF normalization. */
  number: number
  /** Raw text without the line terminator. */
  text: string
}

/**
 * Split a document into numbered lines. A single trailing newline does not
 * create an extra empty line, matching how humans count pasted output.
 * @param text - source document.
 */
export function toLines(text: string): SourceLine[] {
  const raw = text.split(/\r\n|\n|\r/u)
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  return raw.map((lineText, index) => ({ number: index + 1, text: lineText }))
}

/** Number of leading space or tab characters on a line. */
export function indentOf(text: string): number {
  const match = /^[ \t]*/u.exec(text)
  return match === null ? 0 : match[0].length
}

/**
 * Count how many lines of a document a parser recognized.
 * @param lines - every source line.
 * @param consumed - line numbers the parser claimed.
 * @param sampleLimit - maximum number of unrecognized samples to return.
 */
export function coverage(
  lines: readonly SourceLine[],
  consumed: ReadonlySet<number>,
  sampleLimit: number,
): { total: number; parsed: number; unknown: number; ratio: number; samples: string[] } {
  const samples: string[] = []
  let unknown = 0
  for (const line of lines) {
    if (consumed.has(line.number)) continue
    // Blank lines are separators, not syntax: counting them as unrecognized
    // would make coverage depend on how generously the report was spaced.
    if (line.text.trim().length === 0) continue
    unknown += 1
    if (samples.length < sampleLimit) samples.push(line.text)
  }
  const total = lines.length
  return {
    total,
    parsed: total - unknown,
    unknown,
    ratio: total === 0 ? 1 : (total - unknown) / total,
    samples,
  }
}

/**
 * Derive the honest confidence label from a parse-coverage ratio.
 * @param ratio - fraction of lines the parser recognized, in `[0, 1]`.
 * @param extraSignal - additional evidence that pushes a borderline parse up or down.
 */
export function confidenceOf(ratio: number, extraSignal: 'clean' | 'neutral' | 'suspicious' = 'neutral'): 'high' | 'medium' | 'low' {
  // `suspicious` means the document parsed but yielded no subject matter at all
  // (no threads, no edges); that never earns the top label.
  if (ratio >= 0.98 && extraSignal !== 'suspicious') return 'high'
  if (ratio >= 0.85) return 'medium'
  return 'low'
}
