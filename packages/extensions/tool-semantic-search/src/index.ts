/**
 * Semantic code search tool: TF-IDF + cosine similarity based search that
 *超越正则匹配, finding code by meaning rather than exact text.
 *
 * The `semantic_search` tool builds a TF-IDF index over code files in the
 * workspace and returns the most relevant snippets for a natural-language
 * query. It tokenises source code by splitting on non-alphanumeric boundaries
 * (keeping camelCase / snake_case sub-tokens), computes term frequency–inverse
 * document frequency vectors, and ranks documents by cosine similarity to the
 * query vector. No external embedding model is required.
 *
 * @module @deepseek-ai/dsh-tool-semantic-search
 */

import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool as _defineTool } from '@deepseek-ai/dsh-tools'
const defineTool = _defineTool as any

export const name = 'tool-semantic-search'
export const inject = ['tools']

/** One search result snippet. */
interface SearchHit {
  /** Relative file path. */
  file: string
  /** 1-based start line of the snippet. */
  startLine: number
  /** 1-based end line of the snippet. */
  endLine: number
  /** The snippet content. */
  content: string
  /** Cosine similarity score 0–1. */
  score: number
}

/** Code file extensions to index. */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.kt', '.rs', '.go', '.rb',
  '.json', '.yaml', '.yml', '.toml', '.md',
])

/** Directories to skip when walking the file tree. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'lib',
  '.next', '.nuxt', 'out', 'coverage', '.cache',
  'vendor', '.turbo', '.vitepress/cache',
])

/** Maximum file size to index (256 KB). */
const MAX_FILE_SIZE = 256 * 1024


/** Default number of results. */
const DEFAULT_TOP_K = 10

/** Default similarity threshold. */
const DEFAULT_THRESHOLD = 0.3

/**
 * Register the `semantic_search` tool that performs TF-IDF based semantic
 * code search over the workspace.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'semantic_search',
    description:
      'Semantic code search using TF-IDF + cosine similarity. Finds code by '
      + 'meaning rather than exact text match. Indexes code files in the '
      + 'workspace and returns the most relevant snippets for a natural-language '
      + 'query. No external embedding model required.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Natural-language query describing the code to find.',
      },
      scope: {
        type: 'string',
        description: 'Search scope as a path prefix glob (e.g. "packages/core/**"). Default: entire workspace.',
      },
      topK: {
        type: 'integer',
        description: 'Number of top results to return. Default 10.',
      },
      threshold: {
        type: 'number',
        description: 'Minimum similarity score 0–1. Default 0.3.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: any) {
      const query: string = args.query
      const topK: number = args.topK ?? DEFAULT_TOP_K
      const threshold: number = args.threshold ?? DEFAULT_THRESHOLD
      const scope: string | undefined = args.scope

      const root = process.cwd()
      const files = collectCodeFiles(root, scope)
      if (files.length === 0) {
        return { results: [] as SearchHit[], totalFiles: 0, message: 'No code files found to index.' }
      }

      // Build the document corpus: each document is a file split into line-chunks.
      const docs = buildCorpus(root, files)
      if (docs.length === 0) {
        return { results: [] as SearchHit[], totalFiles: files.length, message: 'No indexable content found.' }
      }

      // Compute IDF over all documents.
      const idf = computeIdf(docs)

      // Tokenise the query and build its TF-IDF vector.
      const queryTokens = tokenise(query)
      const queryVec = tfidfVector(queryTokens, idf, docs.length)

      // Score every document by cosine similarity.
      const scored: Array<{ doc: typeof docs[number]; score: number }> = []
      for (const doc of docs) {
        const docVec = tfidfVector(doc.tokens, idf, docs.length)
        const score = cosineSimilarity(queryVec, docVec)
        if (score >= threshold) scored.push({ doc, score })
      }

      // Sort by score descending and take top-K.
      scored.sort((a, b) => b.score - a.score)
      const top = scored.slice(0, topK)

      const results: SearchHit[] = top.map(({ doc, score }) => ({
        file: doc.file,
        startLine: doc.startLine,
        endLine: doc.endLine,
        content: doc.content,
        score: Math.round(score * 1000) / 1000,
      }))

      return { results, totalFiles: files.length, totalDocs: docs.length }
    },
  }))
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/** Recursively collect code files under root, optionally filtered by scope. */
function collectCodeFiles(root: string, scope: string | undefined): string[] {
  const result: string[] = []
  const scopePrefix = scope !== undefined ? scope.replace(/\*\*/g, '').replace(/\*/g, '') : ''
  walk(root, root, result, scopePrefix)
  return result
}

/** Recursive directory walker. */
function walk(dir: string, root: string, result: string[], scopePrefix: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full, root, result, scopePrefix)
    } else if (st.isFile() && st.size <= MAX_FILE_SIZE) {
      const ext = entry.slice(entry.lastIndexOf('.'))
      if (!CODE_EXTENSIONS.has(ext)) continue
      const rel = relative(root, full).split(sep).join('/')
      if (scopePrefix.length > 0 && !rel.startsWith(scopePrefix)) continue
      result.push(full)
    }
  }
}

// ---------------------------------------------------------------------------
// Corpus building
// ---------------------------------------------------------------------------

interface DocChunk {
  file: string
  startLine: number
  endLine: number
  content: string
  tokens: string[]
}

/** Build the document corpus by splitting each file into line-chunks. */
function buildCorpus(root: string, files: string[]): DocChunk[] {
  const docs: DocChunk[] = []
  const CHUNK_SIZE = 20
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    const rel = relative(root, file).split(sep).join('/')
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
      const chunkLines = lines.slice(i, i + CHUNK_SIZE)
      const chunkContent = chunkLines.join('\n').trim()
      if (chunkContent.length === 0) continue
      const tokens = tokenise(chunkContent)
      if (tokens.length === 0) continue
      docs.push({
        file: rel,
        startLine: i + 1,
        endLine: Math.min(i + CHUNK_SIZE, lines.length),
        content: chunkContent.length > 800 ? chunkContent.slice(0, 800) + '\n...' : chunkContent,
        tokens,
      })
    }
  }
  return docs
}

// ---------------------------------------------------------------------------
// Tokenisation & TF-IDF
// ---------------------------------------------------------------------------

/** Tokenise source text: split on non-alphanumeric, expand camelCase/snake_case. */
function tokenise(text: string): string[] {
  const raw = text
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
  const tokens: string[] = []
  for (const token of raw) {
    // Split camelCase / PascalCase into sub-tokens.
    const subTokens = token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)
    for (const sub of subTokens) {
      const lower = sub.toLowerCase()
      if (lower.length > 1) tokens.push(lower)
    }
  }
  return tokens
}

/** Compute inverse document frequency for each term. */
function computeIdf(docs: DocChunk[]): Map<string, number> {
  const docCount = docs.length
  const df = new Map<string, number>()
  for (const doc of docs) {
    const seen = new Set(doc.tokens)
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  const idf = new Map<string, number>()
  for (const [term, count] of df) {
    idf.set(term, Math.log((docCount + 1) / (count + 1)) + 1)
  }
  return idf
}

/** Build a TF-IDF vector from a token list. */
function tfidfVector(tokens: string[], idf: Map<string, number>, docCount: number): Map<string, number> {
  const tf = new Map<string, number>()
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1)
  }
  const vec = new Map<string, number>()
  const total = tokens.length || 1
  for (const [term, freq] of tf) {
    const idfVal = idf.get(term) ?? (Math.log((docCount + 1) / 2) + 1)
    vec.set(term, (freq / total) * idfVal)
  }
  return vec
}

/** Cosine similarity between two sparse vectors. */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [k, v] of a) {
    normA += v * v
    const bv = b.get(k)
    if (bv !== undefined) dot += v * bv
  }
  for (const [, v] of b) {
    normB += v * v
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}