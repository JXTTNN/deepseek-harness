import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SkillProvider, SkillProviderControl, SkillDefinition } from '@deepseek-ai/dsh-skill'
import { access, readFile, writeFile, constants } from 'node:fs/promises'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'

export const name = 'memory'
export const inject = []

/** Memory skill provider configuration. */
export interface Config {
  /** Path to the memory file (default: $DSH_HOME/memory.json). */
  memoryFilePath?: string
}

/** Schemastery config for the memory skill policy. */
export const Config = z.object({
  memoryFilePath: z.string().optional(),
})

type ResolvedConfig = {
  memoryFilePath: string
}

function resolveConfig(config: Config): ResolvedConfig {
  const dshHome = resolveDshHome(undefined)
  const defaultPath = join(dshHome, 'memory.json')
  return {
    memoryFilePath: config.memoryFilePath ?? defaultPath,
  }
}

/** Skill definition for memory. */
export const memorySkill: SkillDefinition = {
  name: 'memory',
  description: 'Simple key‑value memory persisted to $DSH_HOME/memory.json.',
  invocation: {
    modelInvocable: true,
    userInvocable: true,
  },
  provider: 'memory',
  resourceBase: { kind: 'directory', path: '' },
  path: '',
  content: '',
}

/** Provider that registers the memory skill. */
export class MemorySkillProvider implements SkillProvider {
  readonly name = 'memory'
  private readonly ctx: Context
  private readonly control: SkillProviderControl
  private readonly config: ResolvedConfig

  constructor(ctx: Context, control: SkillProviderControl, config: Config = {}) {
    this.ctx = ctx
    this.control = control
    this.config = resolveConfig(config)
  }

  async list(): Promise<SkillDefinition[] | SkillProviderObservation> {
    return [memorySkill]
  }

  async get(candidate: SkillDefinition, options?: { signal?: AbortSignal }): Promise<SkillDefinition | undefined> {
    if (candidate.name === 'memory') {
      return memorySkill
    }
    return undefined
  }

  dispose(): Promise<void> | undefined {
    return undefined
  }
}

/** Register the memory skill provider on `ctx.skills`. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.skills.registerProvider((control) => {
    return new MemorySkillProvider(ctx, control, config)
  })
}