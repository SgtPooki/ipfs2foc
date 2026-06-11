/**
 * CID-list intake for `cids.txt`-shaped input: one CID per line, blank lines
 * and `#` comments ignored — the same shape the CLI's `--cids` reads.
 *
 * Each candidate line is validated by round-tripping through
 * {@link toCanonicalCidV1} and deduped on that canonical form, so a CIDv0 and
 * its v1 re-encoding count once. The *input* spelling is what gets returned:
 * downstream rows and saved results are keyed by the string the user supplied
 * (the prepare pass normalizes again before fetching), matching the paste
 * path's behavior.
 *
 * The collector is incremental — callers feed lines as they decode them — so
 * a multi-megabyte inventory file streams through without ever existing as
 * one giant string. Memory is the accepted list plus one canonical string per
 * unique CID; rejected lines keep only a count and a few capped samples.
 */

import { toCanonicalCidV1 } from './car-url.ts'

/** Rejected-line samples kept for the "first few rejects" display. */
export const INVALID_SAMPLE_CAP = 5
/** Sample text is truncated so one pathological line cannot bloat the result. */
const SAMPLE_TEXT_CAP = 64

export interface CidIntake {
  /** Accepted CIDs in input form, first occurrence first, deduped by canonical CIDv1. */
  cids: string[]
  /** The first {@link INVALID_SAMPLE_CAP} rejected lines (1-based line numbers). */
  invalidSamples: Array<{ line: number; text: string }>
  /** Total rejected lines, including those past the sample cap. */
  invalidCount: number
}

export interface CidCollector {
  /** Feed one raw line (untrimmed, without its newline). */
  line(raw: string): void
  /** The accumulated intake; stable to call more than once. */
  result(): CidIntake
}

export function createCidCollector(): CidCollector {
  const seen = new Set<string>()
  const intake: CidIntake = { cids: [], invalidSamples: [], invalidCount: 0 }
  let lineNo = 0
  return {
    line(raw: string): void {
      lineNo += 1
      const text = raw.trim()
      if (text === '' || text.startsWith('#')) return
      const canonical = toCanonicalCidV1(text)
      if (canonical == null) {
        intake.invalidCount += 1
        if (intake.invalidSamples.length < INVALID_SAMPLE_CAP) {
          intake.invalidSamples.push({ line: lineNo, text: text.slice(0, SAMPLE_TEXT_CAP) })
        }
        return
      }
      if (seen.has(canonical)) return
      seen.add(canonical)
      intake.cids.push(text)
    },
    result: () => intake,
  }
}
