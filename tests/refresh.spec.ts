import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshTraeCredential, type TraeRefreshDevice } from '../src/refresh.ts'
import type { TraeCredential } from '../src/auth.ts'

function credential(edition: TraeCredential['edition'], host: string): TraeCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    userId: 'uid',
    host,
    expiresAtMs: Date.now() - 1000,
    edition,
    source: 'desktop',
  }
}

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

function stubFetch(): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    captured.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    return new Response(JSON.stringify({ Result: { Token: 'fresh', RefreshToken: 'rt2', TokenExpireAt: Date.now() + 60_000 } }), { status: 200 })
  }))
  return captured
}

afterEach(() => { vi.unstubAllGlobals() })

describe('refreshTraeCredential per-edition contract', () => {
  it('cn, sg, and solo share the /cloudide path and the CN ClientID', async () => {
    for (const edition of ['cn', 'sg', 'solo'] as const) {
      const captured = stubFetch()
      await refreshTraeCredential(credential(edition, 'https://api.trae.cn'))
      expect(captured).toHaveLength(1)
      expect(captured[0]!.url).toBe('https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken')
      expect(captured[0]!.body['ClientID']).toBe('ono9krqynydwx5')
      expect(captured[0]!.body['DeviceInfo']).toBeUndefined()
      vi.unstubAllGlobals()
    }
  })

  it('the international desktop edition hangs off its own host with the same contract', async () => {
    const captured = stubFetch()
    await refreshTraeCredential(credential('sg', 'https://api-sg-central.trae.ai'))
    expect(captured[0]!.url).toBe('https://api-sg-central.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken')
    expect(captured[0]!.body['ClientID']).toBe('ono9krqynydwx5')
  })

  it('solo-sg uses the newer /trae path, its own ClientID, and a DeviceInfo body', async () => {
    const captured = stubFetch()
    const device: TraeRefreshDevice = { deviceId: 'device-1', machineId: 'machine-1' }
    const outcome = await refreshTraeCredential(credential('solo-sg', 'https://growsg-normal.trae.ai'), undefined, device)
    expect(captured[0]!.url).toBe('https://growsg-normal.trae.ai/trae/api/v3/oauth/ExchangeToken')
    expect(captured[0]!.body['ClientID']).toBe('en1oxy7wnw8j9n')
    expect(captured[0]!.body['DeviceInfo']).toMatchObject({
      DeviceID: 'device-1',
      MachineID: 'machine-1',
      PlatformCode: 'SOLO_PC',
      DeviceType: 'PC',
    })
    expect(outcome).toMatchObject({ accessToken: 'fresh', refreshToken: 'rt2' })
  })

  it('omits DeviceInfo rather than sending an empty object when no device resolved', async () => {
    const captured = stubFetch()
    await refreshTraeCredential(credential('solo-sg', 'https://growsg-normal.trae.ai'))
    expect(captured[0]!.body['DeviceInfo']).toBeUndefined()
  })

  it('requires a refresh token and propagates upstream failures', async () => {
    const { refreshToken: _omit, ...withoutRefresh } = credential('cn', 'https://api.trae.cn')
    await expect(refreshTraeCredential(withoutRefresh))
      .rejects.toThrow(/refresh token is missing/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    await expect(refreshTraeCredential(credential('cn', 'https://api.trae.cn')))
      .rejects.toThrow(/refresh failed \(http 401\)/)
  })
})
