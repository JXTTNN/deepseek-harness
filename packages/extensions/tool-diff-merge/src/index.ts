/**
 * Three-way merge tool: AST-level merge that resolves conflicts beyond
 * line-based diff3, addressing the str-replace-editor conflict pain point.
 *
 * The `diff_merge` tool takes a base (original), ours (our changes), and
 * theirs (their changes) and produces a merged result. It first attempts a
 * line-level three-way merge using LCS to identify changed regions. When both
 * sides modify the same region, the `strategy` decides the outcome:
 *  - `"ours"`   鈫?take our version
 *  - `"theirs"` 鈫?take their version
 *  - `"union"`  鈫?concatenate both (ours then theirs)
 *  - `"ast"`    鈫?attempt structural merge via brace-matching for JS/TS, fall
 *                  back to line-level on failure
 *
 * @module @deepseek-ai/dsh-tool-diff-merge
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool as _defineTool } from '@deepseek-ai/dsh-tools'
const defineTool = _defineTool as any

export const name = 'tool-diff-merge'
export const inject = ['tools']

/** A detected conflict region. */
interface Conflict {
  startLine: number
  endLine: number
  ours?: string[]
  theirs?: string[]
}

/** The merge result. */
interface MergeResult {
  merged: string
  conflicts: Conflict[]
}

type Strategy = 'ours' | 'theirs' | 'union' | 'ast'

/**
 * Register the `diff_merge` tool that performs three-way merge with
 * configurable conflict resolution.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'diff_merge',
    description:
      'Three-way merge of base/ours/theirs content with conflict detection. '
      + 'Supports line-level merge via LCS and optional AST-level structural '
      + 'merge for JS/TS code. Strategy controls conflict resolution: '
      + '"ours" (take ours), "theirs" (take theirs), "union" (concat both), '
      + '"ast" (structural merge, fallback to line-level). '
      + 'Returns merged content and conflict regions.',
    parameters: {
      base: {
        type: 'string',
        required: true,
        description: 'The original (common ancestor) content.',
      },
      ours: {
        type: 'string',
        required: true,
        description: 'Our modified version.',
      },
      theirs: {
        type: 'string',
        required: true,
        description: 'Their modified version.',
      },
      strategy: {
        type: 'string',
        enum: ['ours', 'theirs', 'union', 'ast'],
        description: 'Conflict resolution strategy. Default "ast".',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: any) {
      const base: string = args.base
      const ours: string = args.ours
      const theirs: string = args.theirs
      const strategy: Strategy = args.strategy ?? 'ast'

      const baseLines = base.split('\n')
      const oursLines = ours.split('\n')
      const theirsLines = theirs.split('\n')

      // Fast path: if ours == theirs, no merge needed.
      if (ours === theirs) {
        return { merged: ours, conflicts: [] } as MergeResult
      }
      // Fast path: if ours == base, take theirs.
      if (ours === base) {
        return { merged: theirs, conflicts: [] } as MergeResult
      }
      // Fast path: if theirs == base, take ours.
      if (theirs === base) {
        return { merged: ours, conflicts: [] } as MergeResult
      }

      // AST strategy: try structural merge first.
      if (strategy === 'ast') {
        const astResult = tryAstMerge(baseLines, oursLines, theirsLines)
        if (astResult !== null) {
          return astResult
        }
        // Fall back to line-level with "ours" on conflicts.
        return lineLevelMerge(baseLines, oursLines, theirsLines, 'ours')
      }

      return lineLevelMerge(baseLines, oursLines, theirsLines, strategy)
    },
  }))
}

// ---------------------------------------------------------------------------
// Line-level three-way merge
// ---------------------------------------------------------------------------

/** Perform a line-level three-way merge using LCS-based diff3. */
function lineLevelMerge(
  base: string[],
  ours: string[],
  theirs: string[],
  strategy: Strategy,
): MergeResult {
  const conflicts: Conflict[] = []
  const merged: string[] = []

  // Compute the diff3 chunks: regions that are common or changed.
  const chunks = diff3Chunks(base, ours, theirs)

  let lineNum = 1
  for (const chunk of chunks) {
    if (chunk.type === 'stable') {
      // Both sides agree (or neither changed).
      merged.push(...chunk.content)
      lineNum += chunk.content.length
    } else if (chunk.type === 'ours-only') {
      // Only we changed this region.
      merged.push(...chunk.oursContent)
      lineNum += chunk.oursContent.length
    } else if (chunk.type === 'theirs-only') {
      // Only they changed this region.
      merged.push(...chunk.theirsContent)
      lineNum += chunk.theirsContent.length
    } else {
      // Conflict: both sides changed differently.
      if (arraysEqual(chunk.oursContent, chunk.theirsContent)) {
        // Same change on both sides 鈥?not a real conflict.
        merged.push(...chunk.oursContent)
        lineNum += chunk.oursContent.length
      } else {
        const startLine = lineNum
        const resolved = resolveConflict(chunk.oursContent, chunk.theirsContent, strategy)
        merged.push(...resolved)
        const endLine = lineNum + resolved.length - 1
        conflicts.push({
          startLine,
          endLine,
          ...(chunk.oursContent.length > 0 ? { ours: chunk.oursContent } : {}),
          ...(chunk.theirsContent.length > 0 ? { theirs: chunk.theirsContent } : {}),
        })
        lineNum = endLine + 1
      }
    }
  }

  return { merged: merged.join('\n'), conflicts }
}

/** Resolve a conflict region according to the strategy. */
function resolveConflict(ours: string[], theirs: string[], strategy: Strategy): string[] {
  switch (strategy) {
    case 'ours':
      return ours
    case 'theirs':
      return theirs
    case 'union':
      return [...ours, ...theirs]
    default:
      return ours
  }
}

// ---------------------------------------------------------------------------
// diff3 chunk computation via LCS
// ---------------------------------------------------------------------------

type Chunk =
  | { type: 'stable'; content: string[] }
  | { type: 'ours-only'; oursContent: string[] }
  | { type: 'theirs-only'; theirsContent: string[] }
  | { type: 'conflict'; oursContent: string[]; theirsContent: string[] }

/** Compute diff3 chunks by aligning ours and theirs against base via LCS. */
function diff3Chunks(base: string[], ours: string[], theirs: string[]): Chunk[] {
  const oursMatches = lcsMatch(base, ours)
  const theirsMatches = lcsMatch(base, theirs)

  const chunks: Chunk[] = []
  let bi = 0
  let oi = 0
  let ti = 0

  while (bi < base.length || oi < ours.length || ti < theirs.length) {
    // Find the next stable region: lines where base[bi] matches both ours[oi] and theirs[ti].
    const oursMatch = oi < oursMatches.length ? oursMatches[oi] : -1
    const theirsMatch = ti < theirsMatches.length ? theirsMatches[ti] : -1

    if (oursMatch === bi && theirsMatch === bi && bi < base.length) {
      // Stable line: all three agree.
      chunks.push({ type: 'stable', content: [base[bi]!] })
      bi++
      oi++
      ti++
      continue
    }

    // Collect the changed region until the next common stable point.
    const startBi = bi
    const startOi = oi
    const startTi = ti

    // Advance until we reach a line that is stable in both ours and theirs.
    while (bi < base.length) {
      const om = oi < oursMatches.length ? oursMatches[oi] : -1
      const tm = ti < theirsMatches.length ? theirsMatches[ti] : -1
      if (om === bi && tm === bi) break
      bi++
    }
    // Collect ours lines until the matching base line.
    while (oi < ours.length) {
      const om = oi < oursMatches.length ? oursMatches[oi] : -1
      if (om === bi && bi <= base.length) break
      oi++
    }
    // Collect theirs lines until the matching base line.
    while (ti < theirs.length) {
      const tm = ti < theirsMatches.length ? theirsMatches[ti] : -1
      if (tm === bi && bi <= base.length) break
      ti++
    }

    const oursRegion = ours.slice(startOi, oi)
    const theirsRegion = theirs.slice(startTi, ti)
    const baseRegion = base.slice(startBi, bi)

    const oursChanged = !arraysEqual(oursRegion, baseRegion)
    const theirsChanged = !arraysEqual(theirsRegion, baseRegion)

    if (oursChanged && !theirsChanged) {
      chunks.push({ type: 'ours-only', oursContent: oursRegion })
    } else if (!oursChanged && theirsChanged) {
      chunks.push({ type: 'theirs-only', theirsContent: theirsRegion })
    } else if (oursChanged && theirsChanged) {
      chunks.push({ type: 'conflict', oursContent: oursRegion, theirsContent: theirsRegion })
    } else {
      // Neither changed 鈥?stable.
      if (baseRegion.length > 0) chunks.push({ type: 'stable', content: baseRegion })
    }
  }

  return chunks
}

/** LCS matching: returns an array where result[oursIndex] = baseIndex or -1. */
function lcsMatch(base: string[], other: string[]): number[] {
  const m = base.length
  const n = other.length
  // DP table for LCS length.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (base[i - 1] === other[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
      }
    }
  }
  // Backtrack to find matched pairs.
  const matches: number[] = new Array(n).fill(-1)
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (base[i - 1] === other[j - 1]) {
      matches[j - 1] = i - 1
      i--
      j--
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--
    } else {
      j--
    }
  }
  return matches
}

// ---------------------------------------------------------------------------
// AST-level merge (brace-matching structural merge)
// ---------------------------------------------------------------------------

/** Attempt AST-level merge; return null to signal fallback. */
function tryAstMerge(base: string[], ours: string[], theirs: string[]): MergeResult | null {
  // Parse into top-level blocks delimited by balanced braces/parens.
  const baseBlocks = parseBlocks(base)
  const oursBlocks = parseBlocks(ours)
  const theirsBlocks = parseBlocks(theirs)

  if (baseBlocks.length === 0 && oursBlocks.length === 0 && theirsBlocks.length === 0) {
    return null
  }

  // Match blocks by their signature (first non-empty line, trimmed).
  const baseSig = new Map<string, number>()
  for (let i = 0; i < baseBlocks.length; i++) {
    const sig = blockSignature(baseBlocks[i]!)
    if (sig.length > 0) baseSig.set(sig, i)
  }

  const result: string[] = []
  const conflicts: Conflict[] = []
  let lineNum = 1

  // Process ours blocks in order, merging theirs changes.
  const theirsUsed = new Set<number>()
  for (const ourBlock of oursBlocks) {
    const sig = blockSignature(ourBlock)
    const baseIdx = baseSig.get(sig)
    const theirsIdx = findBlockBySignature(theirsBlocks, sig, theirsUsed)

    if (baseIdx === undefined && theirsIdx === -1) {
      // New block in ours, not in theirs 鈥?keep it.
      result.push(...ourBlock)
      lineNum += ourBlock.length
    } else if (baseIdx !== undefined && theirsIdx === -1) {
      // Block exists in base, deleted in theirs 鈥?check if ours modified it.
      const baseBlock = baseBlocks[baseIdx]!
      if (arraysEqual(ourBlock, baseBlock)) {
        // Ours unchanged, theirs deleted 鈥?delete (take theirs).
      } else {
        // Ours modified, theirs deleted 鈥?conflict, keep ours.
        result.push(...ourBlock)
        const start = lineNum
        lineNum += ourBlock.length
        conflicts.push({ startLine: start, endLine: lineNum - 1, ours: ourBlock })
      }
    } else if (baseIdx !== undefined && theirsIdx !== -1) {
      theirsUsed.add(theirsIdx)
      const baseBlock = baseBlocks[baseIdx]!
      const theirsBlock = theirsBlocks[theirsIdx]!
      if (arraysEqual(ourBlock, baseBlock)) {
        // Ours unchanged 鈥?take theirs.
        result.push(...theirsBlock)
        lineNum += theirsBlock.length
      } else if (arraysEqual(theirsBlock, baseBlock)) {
        // Theirs unchanged 鈥?take ours.
        result.push(...ourBlock)
        lineNum += ourBlock.length
      } else if (arraysEqual(ourBlock, theirsBlock)) {
        // Both made the same change.
        result.push(...ourBlock)
        lineNum += ourBlock.length
      } else {
        // Both modified differently 鈥?conflict, take ours.
        result.push(...ourBlock)
        const start = lineNum
        lineNum += ourBlock.length
        conflicts.push({ startLine: start, endLine: lineNum - 1, ours: ourBlock, theirs: theirsBlock })
      }
    } else {
      // Fallback: keep ours.
      result.push(...ourBlock)
      lineNum += ourBlock.length
    }
  }

  // Add theirs blocks that weren't matched (new in theirs).
  for (let i = 0; i < theirsBlocks.length; i++) {
    if (theirsUsed.has(i)) continue
    const sig = blockSignature(theirsBlocks[i]!)
    if (!baseSig.has(sig)) {
      result.push(...theirsBlocks[i]!)
      lineNum += theirsBlocks[i]!.length
    }
  }

  return { merged: result.join('\n'), conflicts }
}

/** Parse content into top-level blocks using brace/paren depth. */
function parseBlocks(lines: string[]): string[][] {
  const blocks: string[][] = []
  let current: string[] = []
  let depth = 0
  for (const line of lines) {
    current.push(line)
    depth += countBraces(line)
    if (depth <= 0 && current.length > 0) {
      // Check if this line ends a top-level statement.
      if (line.trim().endsWith(';') || line.trim().endsWith('}') || line.trim() === '' || depth === 0) {
        if (current.some(l => l.trim().length > 0)) {
          blocks.push(current)
        }
        current = []
        depth = 0
      }
    }
  }
  if (current.length > 0 && current.some(l => l.trim().length > 0)) {
    blocks.push(current)
  }
  return blocks
}

/** Count net brace depth change in a line. */
function countBraces(line: string): number {
  let delta = 0
  let inString = false
  let stringChar = ''
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (inString) {
      if (ch === stringChar) inString = false
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true
      stringChar = ch
      continue
    }
    if (ch === '{') delta++
    else if (ch === '}') delta--
  }
  return delta
}

/** Block signature: first non-empty trimmed line. */
function blockSignature(block: string[]): string {
  for (const line of block) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed.slice(0, 80)
  }
  return ''
}

/** Find an unused block by signature. */
function findBlockBySignature(blocks: string[][], sig: string, used: Set<number>): number {
  for (let i = 0; i < blocks.length; i++) {
    if (used.has(i)) continue
    if (blockSignature(blocks[i]!) === sig) return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Check if two string arrays are equal. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}