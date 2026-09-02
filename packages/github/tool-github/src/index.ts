/**
 * GitHub integration tools for long-task tracking and code collaboration.
 *
 * Uses the GitHub REST API with a token from GITHUB_TOKEN env var or
 * DSH_HOME credentials. Provides issue tracking, code search, file reading,
 * and PR creation — the building blocks for prime-agent-style long-task
 * management where GitHub issues become the team's task board.
 *
 * @module @deepseek-ai/dsh-tool-github
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'tool-github'
export const inject = ['tools']

const API = 'https://api.github.com'

/** Resolve the GitHub token from env or credentials. */
function token(): string {
  const tok = process.env.GITHUB_TOKEN
  if (tok) return tok
  // Try reading from DSH credentials
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const home = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh')
    const raw = readFileSync(join(home, '.credentials.yaml'), 'utf-8')
    const m = raw.match(/GITHUB_TOKEN:\s*(\S+)/)
    if (m && m[1]) return m[1]
  } catch { /* not found */ }
  throw new Error('GITHUB_TOKEN not set. Set it as an environment variable or add it to ~/.dsh/.credentials.yaml')
}

/** Call GitHub REST API. */
async function gh(path: string, init?: RequestInit & { method?: string; body?: string }): Promise<any> {
  const url = `${API}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${JSON.stringify(data)}`)
  return data
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'github_issue_create',
    description:
      'Create a GitHub issue. Use this to track tasks, report bugs, or document work items. '
      + 'The issue becomes a durable task record that persists across sessions.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner (user or org).' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      title: { type: 'string', required: true, description: 'Issue title.' },
      body: { type: 'string', required: true, description: 'Issue body (markdown).' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Optional labels.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { number: { type: 'integer', required: true }, html_url: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text' as const, text: `Issue #${(v as any).number} created: ${(v as any).html_url}` }],
    },
    execute: async (args) => {
      const data = await gh(`/repos/${args.owner}/${args.repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: args.title, body: args.body, labels: args.labels }),
      })
      return { number: data.number, html_url: data.html_url }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Create issue: ${(args as any).title}`, kind: 'other' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'github_issue_list',
    description:
      'List GitHub issues. Use this to see the team\'s task board, check progress, or find tasks to work on.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner.' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state. Defaults to open.' },
      labels: { type: 'string', description: 'Comma-separated label filter.' },
      per_page: { type: 'integer', description: 'Results per page (max 100). Default 30.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { issues: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { number: { type: 'integer', required: true }, title: { type: 'string', required: true }, state: { type: 'string', required: true }, html_url: { type: 'string', required: true } } } } } },
      render: (_a, v) => {
        const issues = (v as any).issues as any[]
        return [{ type: 'text' as const, text: issues.length === 0 ? 'No issues found.' : issues.map((i: any) => `#${i.number} [${i.state}] ${i.title}`).join('\n') }]
      },
    },
    execute: async (args) => {
      const params = new URLSearchParams()
      if (args.state) params.set('state', args.state)
      if (args.labels) params.set('labels', args.labels)
      if (args.per_page) params.set('per_page', String(args.per_page))
      const qs = params.toString()
      const data = await gh(`/repos/${args.owner}/${args.repo}/issues${qs ? '?' + qs : ''}`)
      return { issues: (Array.isArray(data) ? data : []).map((i: any) => ({ number: i.number, title: i.title, state: i.state, html_url: i.html_url })) }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'List GitHub issues', kind: 'read' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'github_file_read',
    description:
      'Read a file from a GitHub repository. Use this to inspect code, documentation, or configuration '
      + 'in any public or accessible private repo without cloning.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner.' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      path: { type: 'string', required: true, description: 'File path relative to repo root.' },
      ref: { type: 'string', description: 'Branch name, tag, or commit SHA. Defaults to the default branch.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { content: { type: 'string', required: true }, path: { type: 'string', required: true }, size: { type: 'integer', required: true } } },
      render: (_a, v) => [{ type: 'text' as const, text: `File ${(v as any).path} (${(v as any).size} bytes):\n${(v as any).content}` }],
    },
    execute: async (args) => {
      const ref = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : ''
      const data = await gh(`/repos/${args.owner}/${args.repo}/contents/${encodeURIComponent(args.path)}${ref}`)
      const content = Buffer.from(data.content, 'base64').toString('utf-8')
      return { content, path: args.path, size: data.size }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Read ${(args as any).path}`, kind: 'read' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'github_search_code',
    description:
      'Search code across GitHub. Use this to find implementations, examples, or references '
      + 'in any public repository.',
    parameters: {
      q: { type: 'string', required: true, description: 'Search query (same syntax as GitHub code search).' },
      owner: { type: 'string', description: 'Restrict to a specific owner.' },
      repo: { type: 'string', description: 'Restrict to a specific repo (requires owner).' },
      per_page: { type: 'integer', description: 'Results per page (max 100). Default 30.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { total_count: { type: 'integer', required: true }, items: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { repository: { type: 'string', required: true }, path: { type: 'string', required: true }, html_url: { type: 'string', required: true } } } } } },
      render: (_a, v) => {
        const d = v as any
        return [{ type: 'text' as const, text: `${d.total_count} results:\n${d.items.map((i: any) => `${i.repository}: ${i.path}`).join('\n')}` }]
      },
    },
    execute: async (args) => {
      let q = args.q
      if (args.repo && args.owner) q += ` repo:${args.owner}/${args.repo}`
      else if (args.owner) q += ` user:${args.owner}`
      const params = new URLSearchParams({ q })
      if (args.per_page) params.set('per_page', String(args.per_page))
      const data = await gh(`/search/code?${params.toString()}`)
      return {
        total_count: data.total_count,
        items: (data.items || []).map((i: any) => ({ repository: i.repository?.full_name, path: i.path, html_url: i.html_url })),
      }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Search: ${(args as any).q}`, kind: 'read' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'github_pr_create',
    description:
      'Create a GitHub pull request. Use this to submit code changes for review. '
      + 'The PR becomes a durable record of the work.',
    parameters: {
      owner: { type: 'string', required: true, description: 'Repository owner.' },
      repo: { type: 'string', required: true, description: 'Repository name.' },
      title: { type: 'string', required: true, description: 'PR title.' },
      body: { type: 'string', required: true, description: 'PR description (markdown).' },
      head: { type: 'string', required: true, description: 'The branch with your changes.' },
      base: { type: 'string', required: true, description: 'The branch to merge into (e.g. main).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { number: { type: 'integer', required: true }, html_url: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text' as const, text: `PR #${(v as any).number} created: ${(v as any).html_url}` }],
    },
    execute: async (args) => {
      const data = await gh(`/repos/${args.owner}/${args.repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title: args.title, body: args.body, head: args.head, base: args.base }),
      })
      return { number: data.number, html_url: data.html_url }
    },
    presentCall: args => ({ card: 'generic' as const, title: `Create PR: ${(args as any).title}`, kind: 'other' as const }),
  }))
}