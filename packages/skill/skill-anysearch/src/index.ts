import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SkillProvider, SkillProviderControl, SkillProviderObservation, SkillDefinition } from '@deepseek-ai/dsh-skill'

export const name = 'anysearch'
export const inject = []

/** AnySearch skill provider configuration. */
export interface Config {
  /** Whether to use the DuckDuckGo instant answer API (default: true). */
  useDuckDuckGo?: boolean
}

/** Schemastery config for the anysearch skill policy. */
export const Config = z.object({
  useDuckDuckGo: z.boolean().default(true),
})

type ResolvedConfig = {
  useDuckDuckGo: boolean
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    useDuckDuckGo: config.useDuckDuckGo ?? true,
  }
}

/** Skill definition for anysearch. */
export const anysearchSkill: SkillDefinition = {
  name: 'anysearch',
  description: 'Free web search using DuckDuckGo (or anysearch if configured).',
  invocation: {
    modelInvocable: true,
    userInvocable: true,
  },
  provider: 'anysearch',
  resourceBase: { kind: 'directory', path: '' },
  path: '',
  content: '',
}

/** Provider that registers the anysearch skill. */
export class AnySearchSkillProvider implements SkillProvider {
  readonly name = 'anysearch'
  private readonly ctx: Context
  private readonly control: SkillProviderControl
  private readonly config: ResolvedConfig

  constructor(ctx: Context, control: SkillProviderControl, config: Config = {}) {
    this.ctx = ctx
    this.control = control
    this.config = resolveConfig(config)
  }

  async list(): Promise<SkillDefinition[] | SkillProviderObservation> {
    // Return our single skill definition
    return [anysearchSkill]
  }

  async get(candidate: SkillDefinition, options?: { signal?: AbortSignal }): Promise<SkillDefinition | undefined> {
    if (candidate.name === 'anysearch') {
      // Return a copy with executable content? We'll keep definition and handle invocation via tool.
      return candidate
    }
    return undefined
  }

  // Optional: implement dispose if needed
  dispose(): Promise<void> | undefined {
    return undefined
  }
}

/** Register the anysearch skill provider on `ctx.skills`. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.skills.registerProvider((control) => {
    return new AnySearchSkillProvider(ctx, control, config)
  })
}