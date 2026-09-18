import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as Trae from '../src/index.ts'

/**
 * Activation must not be able to hand DSH an unhandled rejection.
 *
 * Regression origin: the provider-registration block ran inside an awaited
 * `Promise.all(...).then(...)` chain whose only error handling was a trailing
 * `.catch`. Any throw from a step in that chain — the shim not listening yet,
 * a rejected provider route, a late teardown registration after an HMR reload —
 * escaped as a rejection nobody observed. DSH installs a process-wide
 * fail-loud handler on `unhandledRejection` that terminates the process, so a
 * third-party provider plugin could stop the whole harness from starting.
 *
 * These tests assert the *observable* contract that replaces it: activation
 * completes, the plugin is mounted, and no rejection reaches the process.
 */

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.storedDocument)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
afterEach(async () => { await context?.fiber.dispose(); context = undefined })

/** Collect any rejection that escapes to the process during `run`. */
async function escapedRejections(run: () => Promise<void>, settleMs = 300): Promise<unknown[]> {
  const seen: unknown[] = []
  const onRejection = (reason: unknown): void => { seen.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    await run()
    await new Promise(resolve => setTimeout(resolve, settleMs))
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  return seen
}

/** Run `apply` against a bare root context, with the host seams stubbed. */
async function applyToBareContext(): Promise<{ warn: ReturnType<typeof vi.fn> }> {
  const warn = vi.fn()
  const root = new Context()
  const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }
  // A minimal host seam: the plugin injects `llm`, so a bare context has no
  // service to provide one. `apply` must degrade rather than throw.
  Object.defineProperty(root, 'llm', { get: () => undefined, configurable: true })
  Object.defineProperty(root, 'logger', { get: () => logger, configurable: true })
  Trae.apply(root as never, { edition: 'auto' } as never)
  return { warn }
}

describe('activation never escapes as an unhandled rejection', () => {
  it('completes a full activation without emitting one', async () => {
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-trae-rejection-'))
    const ctx = new Context()
    context = ctx
    try {
      const escaped = await escapedRejections(async () => {
        await ctx.plugin(LlmRuntime)
        await ctx.plugin(MemorySettings)
        await ctx.plugin(Trae, {
          edition: 'auto',
          authFile: '/nonexistent/dsh-connect-trae-rejection-storage.json',
        })
      })
      expect(escaped.map(String)).toEqual([])
      // The plugin really did activate — this is not passing by doing nothing.
      await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('trae-global')
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('reports a missing host service instead of rejecting', async () => {
    const escaped = await escapedRejections(async () => {
      const { warn } = await applyToBareContext()
      // A host with no `llm` service cannot hold provider routes at all. Each
      // affected region is named, the failure is scoped, and activation
      // returns — no throw, no rejection.
      await expect.poll(() => warn.mock.calls.length).toBeGreaterThan(0)
      const messages = warn.mock.calls.map(call => String(call[0]))
      expect(messages.some(message => message.includes('the trae provider could not be registered'))).toBe(true)
      expect(messages.some(message => message.includes('the trae-global provider could not be registered'))).toBe(true)
      expect(messages.some(message => message.includes('while every other provider keeps working'))).toBe(true)
    })
    expect(escaped.map(String)).toEqual([])
  })

  it('contains a rejection from the discovery seed', async () => {
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-trae-seed-'))
    const ctx = new Context()
    context = ctx
    try {
      const escaped = await escapedRejections(async () => {
        await ctx.plugin(LlmRuntime)
        await ctx.plugin(MemorySettings)
        // No credentials and a dead authFile: the startup directory seed is
        // guaranteed to fail. It must fall back to the configured catalog.
        await ctx.plugin(Trae, {
          edition: 'auto',
          authFile: '/nonexistent/dsh-connect-trae-seed-storage.json',
        })
        await expect.poll(() => ctx.llm.listProviders().map(provider => provider.id)).toContain('trae')
        expect((await ctx.llm.listModels('trae')).map(model => model.id)).toContain('DeepSeek-V4-Flash-Official')
      })
      expect(escaped.map(String)).toEqual([])
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })
})
