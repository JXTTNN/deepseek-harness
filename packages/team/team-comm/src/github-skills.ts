/**
 * GitHub skill search and injection for team_spawn.
 *
 * Allows subagents to search GitHub for skill repositories/files, download
 * their content, and inject it into the subagent prompt — ephemeral,
 * on-demand, with no persistent storage. Skills are "use and delete":
 * they exist only in the child prompt and are cleaned up when the
 * subagent disposes.
 *
 * @module @deepseek-ai/dsh-team-comm/github-skills
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A reference to a skill file on GitHub. */
export interface GitHubSkillRef {
  owner: string
  repo: string
  /** Path to the skill file (e.g. "SKILL.md", "skills/code-review.md"). */
  path: string
  /** Branch or tag (default: "main"). */
  ref?: string
}

/** A search result from GitHub. */
export interface GitHubSkillSearchResult {
  name: string
  description: string
  owner: string
  repo: string
  path: string
  url: string
  stars: number
  updatedAt: string
  topics: string[]
}

/** Outcome of loading GitHub skills for a spawn. */
export interface GitHubSkillLoadResult {
  /** Prompt prefix containing all found skill bodies. */
  prefix: string
  /** Names of skills that were successfully loaded. */
  found: string[]
  /** Names of skills that could not be loaded. */
  missing: string[]
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default GitHub API base URL. */
const GITHUB_API_BASE = 'api.github.com'

/** Default search topics that indicate agent skills. */
const SKILL_TOPICS = ['agent-skill', 'ai-skill', 'mcp-skill', 'llm-skill', 'prompt-skill']

/** Maximum skills to load per spawn (prevents prompt explosion). */
const MAX_GITHUB_SKILLS_PER_SPAWN = 5

/** Maximum content size per skill (256 KB). */
const MAX_SKILL_CONTENT_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Make a GitHub API request and return the JSON response.
 * Uses node:http (no external deps) with optional Bearer token.
 */
function githubApi<T>(
  path: string,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'dsh-team-comm-github-skills',
    }
    if (token !== undefined && token.length > 0) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const req = httpRequest(
      {
        hostname: GITHUB_API_BASE,
        path,
        method: 'GET',
        headers,
        signal,
      },
      (res: IncomingMessage) => {
        if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`GitHub API ${path}: HTTP ${res.statusCode}`))
          res.resume()
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T)
          } catch (err) {
            reject(new Error(`GitHub API ${path}: invalid JSON response`))
          }
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (signal !== undefined) {
      signal.addEventListener('abort', () => req.destroy())
    }
    req.end()
  })
}

/** Get the GitHub token from environment variables. */
function getGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** GitHub repository search response shape. */
interface GitHubRepoSearchResponse {
  total_count: number
  items: Array<{
    full_name: string
    name: string
    description: string | null
    html_url: string
    stargazers_count: number
    updated_at: string
    topics: string[]
    default_branch: string
  }>
}

/** GitHub code search response shape. */
interface GitHubCodeSearchResponse {
  total_count: number
  items: Array<{
    name: string
    path: string
    repository: {
      full_name: string
      name: string
      description: string | null
      html_url: string
      stargazers_count: number
      updated_at: string
    }
  }>
}

/**
 * Search GitHub for skill repositories.
 *
 * Uses the GitHub Search API to find repositories tagged with skill-related
 * topics. Returns results sorted by stars (most popular first).
 *
 * @param query - Search term (matched against repo name and description)
 * @param options - Optional filters: language, limit, token, signal
 * @returns Array of skill search results
 */
export async function searchGitHubSkills(
  query: string,
  options: {
    language?: string
    limit?: number
    token?: string
    signal?: AbortSignal
  } = {},
): Promise<GitHubSkillSearchResult[]> {
  const token = options.token ?? getGitHubToken()
  const limit = Math.min(options.limit ?? 10, 30)
  const signal = options.signal

  // Build search query: user query + skill topics
  const topicQuery = SKILL_TOPICS.map(t => `topic:${t}`).join(' ')
  let q = `${encodeURIComponent(query)} ${topicQuery}`
  if (options.language !== undefined && options.language.length > 0) {
    q += ` language:${options.language}`
  }

  const path = `/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit}`
  const response = await githubApi<GitHubRepoSearchResponse>(path, token, signal)

  return response.items.map(item => ({
    name: item.name,
    description: item.description ?? '',
    owner: item.full_name.split('/')[0] ?? '',
    repo: item.name,
    path: 'SKILL.md',
    url: item.html_url,
    stars: item.stargazers_count,
    updatedAt: item.updated_at,
    topics: item.topics ?? [],
  }))
}

/**
 * Search GitHub for SKILL.md files in repositories.
 *
 * Uses the code search API to find files named "SKILL.md" or "*.skill.md"
 * that match the query. This is more precise than repo search but slower.
 *
 * @param query - Search term (matched against file content and repo name)
 * @param options - Optional filters: limit, token, signal
 * @returns Array of skill search results
 */
export async function searchGitHubSkillFiles(
  query: string,
  options: {
    limit?: number
    token?: string
    signal?: AbortSignal
  } = {},
): Promise<GitHubSkillSearchResult[]> {
  const token = options.token ?? getGitHubToken()
  const limit = Math.min(options.limit ?? 10, 30)
  const signal = options.signal

  // Search for SKILL.md files containing the query
  const q = `${encodeURIComponent(query)} filename:SKILL.md extension:md`
  const path = `/search/code?q=${q}&per_page=${limit}`
  const response = await githubApi<GitHubCodeSearchResponse>(path, token, signal)

  return response.items.map(item => ({
    name: item.name.replace(/\.md$/i, ''),
    description: item.repository.description ?? '',
    owner: item.repository.full_name.split('/')[0] ?? '',
    repo: item.repository.name,
    path: item.path,
    url: `${item.repository.html_url}/blob/HEAD/${item.path}`,
    stars: item.repository.stargazers_count,
    updatedAt: item.repository.updated_at,
    topics: [],
  }))
}

// ---------------------------------------------------------------------------
// Content fetch
// ---------------------------------------------------------------------------

/** GitHub contents API response shape. */
interface GitHubContentsResponse {
  content: string
  encoding: string
  size: number
  path: string
  name: string
}

/**
 * Download skill content from a GitHub repository.
 *
 * Uses the contents API to fetch the file content (base64 encoded).
 * Returns the decoded UTF-8 text. Throws if the file is too large or
 * the request fails.
 *
 * @param ref - GitHub skill reference (owner, repo, path, ref)
 * @param options - Optional: token, signal
 * @returns The skill file content as UTF-8 text
 */
export async function fetchGitHubSkillContent(
  ref: GitHubSkillRef,
  options: {
    token?: string
    signal?: AbortSignal
  } = {},
): Promise<string> {
  const token = options.token ?? getGitHubToken()
  const signal = options.signal
  const branch = ref.ref ?? 'main'

  const path = `/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(ref.path)}?ref=${encodeURIComponent(branch)}`
  const response = await githubApi<GitHubContentsResponse>(path, token, signal)

  if (response.size > MAX_SKILL_CONTENT_BYTES) {
    throw new Error(
      `GitHub skill ${ref.owner}/${ref.repo}/${ref.path}: too large (${response.size} bytes, max ${MAX_SKILL_CONTENT_BYTES})`,
    )
  }

  if (response.encoding !== 'base64') {
    throw new Error(
      `GitHub skill ${ref.owner}/${ref.repo}/${ref.path}: unsupported encoding "${response.encoding}"`,
    )
  }

  // Decode base64 to UTF-8
  return Buffer.from(response.content, 'base64').toString('utf8')
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/** GitHub contents API response shape for repo metadata. */
interface GitHubRepoResponse {
  name: string
  description: string | null
  stargazers_count: number
  html_url: string
}

/**
 * Fetch repository metadata (description, stars) for prompt rendering.
 * Best-effort: returns null on failure.
 */
async function fetchRepoMetadata(
  owner: string,
  repo: string,
  token?: string,
  signal?: AbortSignal,
): Promise<GitHubRepoResponse | null> {
  try {
    return await githubApi<GitHubRepoResponse>(`/repos/${owner}/${repo}`, token, signal)
  } catch {
    return null
  }
}

/**
 * Render a GitHub skill for prompt injection.
 *
 * Formats the skill content with a header indicating its source,
 * making it clear to the subagent that this is an ephemeral skill
 * loaded from GitHub.
 */
function renderGitHubSkillForPrompt(
  ref: GitHubSkillRef,
  content: string,
  repoMetadata: GitHubRepoResponse | null,
): string {
  const source = `${ref.owner}/${ref.repo}/${ref.path}`
  const stars = repoMetadata !== null ? ` (${repoMetadata.stargazers_count} stars)` : ''
  const desc = repoMetadata?.description ?? ''
  const header = `<!-- GitHub Skill: ${source}${stars} -->`
  const descLine = desc.length > 0 ? `\n# ${repoMetadata?.name ?? ref.repo}: ${desc}` : ''
  return `${header}${descLine}\n\n${content}`
}

// ---------------------------------------------------------------------------
// Batch loading for spawn
// ---------------------------------------------------------------------------

/**
 * Parse a skill reference string into a GitHubSkillRef.
 *
 * Accepts formats:
 * - "owner/repo/path/to/SKILL.md"
 * - "owner/repo" (defaults to path "SKILL.md")
 * - "owner/repo@ref/path" (with branch/tag)
 *
 * @returns Parsed ref, or null if the string is not a valid GitHub ref
 */
export function parseGitHubSkillRef(ref: string): GitHubSkillRef | null {
  // Check for @ref syntax
  let branch: string | undefined
  let working = ref
  const atIdx = working.indexOf('@')
  if (atIdx > 0) {
    // Find the @ that's after the repo name (not in the path)
    const slashAfterAt = working.indexOf('/', atIdx)
    if (slashAfterAt > 0) {
      branch = working.substring(atIdx + 1, slashAfterAt)
      working = working.substring(0, atIdx) + working.substring(slashAfterAt)
    } else {
      // @ref at the end — no path
      branch = working.substring(atIdx + 1)
      working = working.substring(0, atIdx)
    }
  }

  const parts = working.split('/')
  if (parts.length < 2) return null
  const owner = parts[0]!
  const repo = parts[1]!
  const path = parts.length >= 3 ? parts.slice(2).join('/') : 'SKILL.md'
  if (owner.length === 0 || repo.length === 0 || path.length === 0) return null
  return { owner, repo, path, ...(branch !== undefined ? { ref: branch } : {}) }
}

/**
 * Load multiple GitHub skills for prompt injection.
 *
 * Downloads each skill's content from GitHub, renders it for the prompt,
 * and returns a combined prefix string. Skills that fail to load are
 * reported as "missing" but do not fail the entire operation.
 *
 * This is the GitHub equivalent of `loadSkillsForSpawn` in index.ts.
 * Skills are ephemeral: they exist only in the returned prefix string
 * and are not persisted to disk.
 *
 * @param refs - Array of GitHub skill references
 * @param options - Optional: token, signal
 * @returns Combined prefix, found names, and missing names
 */
export async function loadGitHubSkillsForSpawn(
  refs: GitHubSkillRef[],
  options: {
    token?: string
    signal?: AbortSignal
  } = {},
): Promise<GitHubSkillLoadResult> {
  if (refs.length === 0) {
    return { prefix: '', found: [], missing: [] }
  }

  // Safety: limit the number of skills per spawn
  const capped = refs.slice(0, MAX_GITHUB_SKILLS_PER_SPAWN)
  const token = options.token ?? getGitHubToken()
  const signal = options.signal

  const found: string[] = []
  const missing: string[] = []
  const bodies: string[] = []

  for (const ref of capped) {
    const name = `${ref.owner}/${ref.repo}/${ref.path}`
    try {
      const content = await fetchGitHubSkillContent(ref, {
        ...(token !== undefined ? { token } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (content.length === 0) {
        missing.push(name)
        continue
      }
      const metadata = await fetchRepoMetadata(ref.owner, ref.repo, token, signal)
      bodies.push(renderGitHubSkillForPrompt(ref, content, metadata))
      found.push(name)
    } catch {
      missing.push(name)
    }
  }

  // If there were more refs than the cap, report them as missing
  for (let i = capped.length; i < refs.length; i++) {
    const ref = refs[i]!
    missing.push(`${ref.owner}/${ref.repo}/${ref.path}`)
  }

  const prefix = bodies.length > 0
    ? '<!-- GitHub Skills (ephemeral, loaded on-demand) -->\n' + bodies.join('\n\n---\n\n') + '\n\n<!-- End GitHub Skills -->\n\n'
    : ''

  return { prefix, found, missing }
}

/**
 * Load GitHub skills from string references (convenience wrapper).
 *
 * Parses each string as a GitHub skill reference, then loads them.
 * Invalid references are reported as missing.
 *
 * @param refStrings - Array of "owner/repo/path" strings
 * @param options - Optional: token, signal
 * @returns Combined prefix, found names, and missing names
 */
export async function loadGitHubSkillsFromStrings(
  refStrings: string[],
  options: {
    token?: string
    signal?: AbortSignal
  } = {},
): Promise<GitHubSkillLoadResult> {
  const refs: GitHubSkillRef[] = []
  const invalid: string[] = []

  for (const s of refStrings) {
    const ref = parseGitHubSkillRef(s)
    if (ref !== null) {
      refs.push(ref)
    } else {
      invalid.push(s)
    }
  }

  const result = await loadGitHubSkillsForSpawn(refs, options)
  return {
    prefix: result.prefix,
    found: result.found,
    missing: [...result.missing, ...invalid],
  }
}