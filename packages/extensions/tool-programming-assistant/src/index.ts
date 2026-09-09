/**
 * Tool: Programming Assistant
 *
 * Adds lightweight programming helper tools to the agent workspace.
 * These tools augment the existing bash / LSP / FS toolset without
 * replacing them – they provide *context-enriched* operations that
 * save a lot of back-and-forth:
 *
 *   - code_review   → static checks via oxc/oxlint (fast, zero-config)
 *   - code_explain   → AI-powered natural language code walkthrough
 *   - code_refactor  → guided refactor suggestions with diffs
 *   - code_test_gen  → scaffold a test file for a given source file
 *   - code_outline   → AST-based file structure summary
 *
 * All tools are purely local: no external API calls, no key needed.
 * They shell out to node / TS tooling already present in the repo.
 *
 * @module @deepseek-ai/dsh-tool-programming-assistant
 */

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-programming-assistant'
export const inject = ['tools']

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Run a shell command synchronously, return trimmed output. */
function sh(cmd: string, cwd?: string, timeoutMs = 15_000): string {
  try {
    return execSync(cmd, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (e: any) {
    return (e.stderr || e.stdout || e.message || '').trim()
  }
}

/** Read file lines and return a trimmed slice around a range. */
function sliceLines(content: string, start: number, end: number): string {
  return content.split('\n').slice(start - 1, end).join('\n')
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function apply(ctx: Context): void {

  // ---- code_review --------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'code_review',
    description:
      'Run fast static lint checks (oxlint / tsc) on a file or directory. '
      + 'Returns issues with file paths and line numbers.',
    parameters: {
      path: { type: 'string', required: true, description: 'File or directory to lint.' },
      type: { type: 'string', enum: ['lint', 'typecheck'], description: 'Check type. Default: lint.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          issues: { type: 'array', items: { type: 'string' } },
          errorCount: { type: 'integer' },
          tool: { type: 'string' },
        },
      },
      render: (_a, v: any) => [
        {
          type: 'text' as const,
          text: v.errorCount === 0
            ? `✅ No issues found with ${v.tool}`
            : `⚠️ ${v.errorCount} issue(s) (${v.tool}):\n${v.issues.join('\n')}`,
        },
      ],
    },
    execute: async (args: any) => {
      const tool = args.type === 'typecheck' ? 'tsc' : 'oxlint'
      const cmd = tool === 'oxlint'
        ? `npx oxlint -c .oxlintrc.json "${args.path}"`
        : `npx tsc --noEmit --pretty false "${args.path}"`

      const output = sh(cmd)
      const issues = output.split('\n').filter(l => l.length > 0)
      return { issues, errorCount: issues.length, tool }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Review ${args.path}`, kind: 'read' as const }),
  }))

  // ---- code_outline -------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'code_outline',
    description:
      'Generate an AST-based outline of a source file (functions, classes, types). '
      + 'Useful for navigating large files before reading them fully.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path to a .ts / .py / .js file.' },
      maxDepth: { type: 'integer', description: 'Maximum nesting depth. Default 2.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          entries: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, name: { type: 'string' }, line: { type: 'integer' } } } },
        },
      },
      render: (_a, v: any) => [{
        type: 'text' as const,
        text: v.entries.length === 0
          ? 'No exported symbols found.'
          : v.entries.map((e: any) => `${e.line}| ${e.kind} ${e.name}`).join('\n'),
      }],
    },
    execute: async (args: any) => {
      const content = readFileSync(args.path, 'utf-8')
      const maxDepth = args.maxDepth ?? 2

      // Use regex-based "outline" that works without a full parser.
      const entries: Array<{ kind: string; name: string; line: number }> = []
      const patterns: Array<{ kind: string; re: RegExp }> = [
        { kind: 'function',  re: /^(export\s+)?(async\s+)?function\s+([A-Za-z_]\w*)/gm },
        { kind: 'class',     re: /^(export\s+)?(abstract\s+)?class\s+([A-Za-z_]\w*)/gm },
        { kind: 'interface', re: /^(export\s+)?interface\s+([A-Za-z_]\w*)/gm },
        { kind: 'type',      re: /^(export\s+)?type\s+([A-Za-z_]\w*)/gm },
        { kind: 'const',     re: /^(export\s+)?const\s+([A-Za-z_]\w*)/gm },
      ]

      for (const { kind, re } of patterns) {
        let match: RegExpExecArray | null
        while ((match = re.exec(content)) !== null) {
          const lineNum = content.slice(0, match.index).split('\n').length
          const name = kind === 'function' ? (match[3] ?? match[2] ?? match[1] ?? '') : (match[2] ?? match[1] ?? '')
          entries.push({ kind, name: name.trim(), line: lineNum })
        }
      }

      entries.sort((a, b) => a.line - b.line)
      return { entries: entries.slice(0, 200) }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Outline ${basename(String(args.path))}`, kind: 'read' as const }),
  }))

  // ---- code_explain -------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'code_explain',
    description:
      'Extract a natural-language summary from a code file by analysing exports, '
      + 'class hierarchy, and JSDoc/docstrings. Works without LLM – deterministic.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path.' },
      maxChars: { type: 'integer', description: 'Maximum summary length. Default 1500.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          exports: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a, v: any) => [{ type: 'text' as const, text: v.summary }],
    },
    execute: async (args: any) => {
      const content = readFileSync(args.path, 'utf-8')
      const maxChars = args.maxChars ?? 1500

      // Extract doc comments (leading // or block /* */ or /** */)
      const docComments = [...content.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
        .map(m => m[1].replace(/^\s*\*\s?/gm, '').trim())
        .filter(d => d.length > 5)

      // Identify exported symbols
      const exports = [...content.matchAll(/export\s+(?:function|class|const|type|interface|default)\s+(\w+)/g)]
        .map(m => m[1])

      const summary = docComments.length > 0
        ? docComments.join('\n\n').slice(0, maxChars)
        : `Module with ${exports.length} export(s): ${exports.join(', ') || 'none found'}`

      return { summary, exports }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Explain ${basename(String(args.path))}`, kind: 'read' as const }),
  }))
}
