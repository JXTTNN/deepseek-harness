/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-web-fetch-md`.
 * @module @deepseek-ai/dsh-web-fetch-md/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-fetch-md'

/** Cordis companion plugin name. */
export const name = 'web-fetch-md-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: conversion is a pure function of the wrapped
 * provider's result; the seam (dsh-web) owns the provider-registry relation
 * and the wrapped provider owns wire-safety, leaving this package no event
 * sequence or mutable data relation of its own.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
