import {
  parseGitHubSkillRef,
} from '../src/github-skills'
import { describe, expect, it } from 'vitest'

describe('parseGitHubSkillRef', () => {
  it('parses owner/repo/path format', () => {
    const ref = parseGitHubSkillRef('owner/repo/SKILL.md')
    expect(ref).toEqual({
      owner: 'owner',
      repo: 'repo',
      path: 'SKILL.md',
    })
  })

  it('parses owner/repo format (defaults to SKILL.md)', () => {
    const ref = parseGitHubSkillRef('owner/repo')
    expect(ref).toEqual({
      owner: 'owner',
      repo: 'repo',
      path: 'SKILL.md',
    })
  })

  it('parses owner/repo/path/to/file format', () => {
    const ref = parseGitHubSkillRef('owner/repo/skills/code-review.md')
    expect(ref).toEqual({
      owner: 'owner',
      repo: 'repo',
      path: 'skills/code-review.md',
    })
  })

  it('parses owner/repo@branch/path format', () => {
    const ref = parseGitHubSkillRef('owner/repo@develop/SKILL.md')
    expect(ref).toEqual({
      owner: 'owner',
      repo: 'repo',
      path: 'SKILL.md',
      ref: 'develop',
    })
  })

  it('parses owner/repo@branch format (no path)', () => {
    const ref = parseGitHubSkillRef('owner/repo@v2')
    expect(ref).toEqual({
      owner: 'owner',
      repo: 'repo',
      path: 'SKILL.md',
      ref: 'v2',
    })
  })

  it('parses owner/repo@branch/path/to/file format', () => {
    const ref = parseGitHubSkillRef('owner/repo@main/skills/deep-research.md')
    expect(ref).toEqual({
      owner: 'owner',
      repo: 'repo',
      path: 'skills/deep-research.md',
      ref: 'main',
    })
  })

  it('returns null for invalid formats', () => {
    expect(parseGitHubSkillRef('just-one-word')).toBeNull()
    expect(parseGitHubSkillRef('')).toBeNull()
    expect(parseGitHubSkillRef('/')).toBeNull()
    expect(parseGitHubSkillRef('owner/')).toBeNull()
    expect(parseGitHubSkillRef('/repo')).toBeNull()
  })

  it('returns null for owner/repo/ with empty path', () => {
    expect(parseGitHubSkillRef('owner/repo/')).toBeNull()
  })
})