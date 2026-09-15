/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-team-comm`.
 * @module @deepseek-ai/dsh-team-comm/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-team-comm'

/** Cordis companion plugin name. */
export const name = 'team-comm-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this model-facing adapter owns no session-owned event
 * stream or mutable registry; durable team state lives in workspace `.team/`
 * files synchronized per tool call, outside any session event relation a
 * package-level check could assert.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
