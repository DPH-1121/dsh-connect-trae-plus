import { request, createServer as createPortHolder } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createTraeAdapter } from '../src/adapter.ts'
import { TraeCatalog } from '../src/catalog.ts'
import { createTraeShim, type TraeShim } from '../src/shim.ts'
import type { TraeUpstreamClient } from '../src/upstream.ts'

const cleanup: TraeShim[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(shim => shim.close())) })

async function start(client?: TraeUpstreamClient): Promise<TraeShim> {
  const shim = createTraeShim({
    catalog: new TraeCatalog(),
    client: client ?? new (await import('../src/upstream.ts')).UnconfiguredTraeUpstreamClient(),
  })
  await shim.ready
  cleanup.push(shim)
  return shim
}

/**
 * A loopback port that is guaranteed to be taken for the duration of `use`:
 * EADDRINUSE is the deterministic way to make a bind fail on every platform.
 */
async function withPortTaken<T>(use: (port: number) => Promise<T>): Promise<T> {
  const holder = createPortHolder()
  await new Promise<void>(resolve => { holder.listen(0, '127.0.0.1', resolve) })
  try {
    return await use((holder.address() as AddressInfo).port)
  } finally {
    await new Promise<void>(resolve => { holder.close(() => resolve()) })
  }
}

function raw(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: options.headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

describe('Trae loopback shim', () => {
  it('binds an ephemeral loopback port and serves models with the secret', async () => {
    const shim = await start()
    expect(shim.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${shim.baseUrl()}/v1/models`, { headers: { authorization: `Bearer ${shim.token()}` } })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string }[] }
    expect(body.data.map(item => item.id)).toContain('DeepSeek-V4-Flash-Official')
  })

  it('rejects missing bearer and hostile Host', async () => {
    const shim = await start()
    const port = Number(new URL(shim.baseUrl()).port)
    const missing = await raw(port, { path: '/healthz', headers: { host: `127.0.0.1:${port}` } })
    expect(missing.status).toBe(401)
    const hostile = await raw(port, { path: '/healthz', headers: { host: 'evil.example', authorization: `Bearer ${shim.token()}` } })
    expect(hostile.status).toBe(403)
  })

  it('rejects hostile Origin and non-JSON chat', async () => {
    const shim = await start()
    const port = Number(new URL(shim.baseUrl()).port)
    const origin = await raw(port, {
      method: 'POST', path: '/v1/chat/completions',
      headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: '{}',
    })
    expect(origin.status).toBe(403)
    const contentType = await raw(port, {
      method: 'POST', path: '/v1/chat/completions',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain', authorization: `Bearer ${shim.token()}` },
      body: '{}',
    })
    expect(contentType.status).toBe(415)
  })

  it('returns an explicit 503 while the real protocol is disabled', async () => {
    const shim = await start()
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'DeepSeek-V4-Flash-Official', messages: [] }),
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('protocol is not configured')
  })

  it('aborts upstream when the inbound request closes', async () => {
    let seenSignal: AbortSignal | undefined
    let enteredResolve!: () => void
    const entered = new Promise<void>(resolve => { enteredResolve = resolve })
    const shim = await start({
      async chatStream(_body, signal) {
        seenSignal = signal
        enteredResolve()
        await new Promise(resolve => setTimeout(resolve, 100))
        return { ok: false, status: 503, kind: 'unconfigured', message: 'late' }
      },
    })
    const port = Number(new URL(shim.baseUrl()).port)
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` } })
    req.on('error', () => {})
    req.write('{}')
    req.end()
    await entered
    req.destroy()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seenSignal?.aborted).toBe(true)
  })
})

/**
 * The readiness contract the activation path depends on.
 *
 * Regression origin: `createTraeAdapter` used to read `shim.baseUrl()` while
 * building its model list, so constructing a provider before the listener had
 * bound threw `trae shim is not listening` *out of the plugin's startup chain*.
 * DSH's fail-loud handler turns that into a dead process, which is why a
 * missing/not-yet-ready Trae shim could take the whole harness down. These
 * tests pin the two properties that make that impossible: readiness is
 * observable without throwing, and the port is fixed at bind time.
 */
describe('Trae shim readiness contract', () => {
  it('reports readiness through a non-throwing gate instead of an exception', async () => {
    const shim = createTraeShim({
      catalog: new TraeCatalog(),
      client: new (await import('../src/upstream.ts')).UnconfiguredTraeUpstreamClient(),
    })
    cleanup.push(shim)
    // The gate is the only sanctioned way to conclude "this shim has a port".
    // A generous deadline makes the assertion deterministic: whether the bind
    // has already settled or is still in flight, a successful bind answers
    // true, and nothing here can throw.
    expect(await shim.whenListening(5_000)).toBe(true)
    expect(shim.listening).toBe(true)
    expect(shim.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('reports a failed bind as false and never throws, leaving the caller able to degrade', async () => {
    await withPortTaken(async port => {
      const shim = createTraeShim({
        catalog: new TraeCatalog(),
        client: new (await import('../src/upstream.ts')).UnconfiguredTraeUpstreamClient(),
        port,
      })
      cleanup.push(shim)
      expect(await shim.whenListening(5_000)).toBe(false)
      expect(shim.listening).toBe(false)
      // The reason is available for the degradation message rather than being
      // buried in an exception nobody catches.
      expect(String(shim.reason())).toMatch(/EADDRINUSE/)
      // Reading the URL without the gate is a programming error, and says so.
      expect(() => shim.baseUrl()).toThrow(/not listening/)
      // `ready` still rejects for callers that await it directly, but the
      // rejection is observed internally too — an unobserved one would reach
      // DSH's fail-loud handler and kill the process.
      await expect(shim.ready).rejects.toThrow()
    })
  })

  it('keeps a stable base URL across catalog reads once bound', async () => {
    const shim = await start()
    const first = shim.baseUrl()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(shim.baseUrl()).toBe(first)
  })

  it('builds a working adapter once the gate has answered, using only plain values', async () => {
    const catalog = new TraeCatalog()
    const client = new (await import('../src/upstream.ts')).UnconfiguredTraeUpstreamClient()
    // The adapter takes the resolved URL and secret, so it holds no reachable
    // handle back into the shim's startup sequence — a future refactor cannot
    // reintroduce the readiness race through it.
    const shim = createTraeShim({ catalog, client })
    cleanup.push(shim)
    expect(await shim.whenListening(5_000)).toBe(true)
    const trae = createTraeAdapter({
      baseUrl: shim.baseUrl(),
      apiKey: shim.token(),
      catalog,
      provider: 'trae',
      displayName: 'Trae',
    })
    // Building the provider read the full catalog without throwing, and the
    // route it exposes is the shim's own loopback port.
    const models = await trae.adapter.listModels('trae')
    expect(models.map(model => model.id)).toContain('DeepSeek-V4-Flash-Official')
    expect(shim.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    trae.invalidate()
    expect((await trae.adapter.listModels('trae')).length).toBeGreaterThan(0)
  })
})
