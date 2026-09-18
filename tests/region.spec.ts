import { describe, expect, it } from 'vitest'
import {
  REGION_GATEWAYS,
  regionOfCredential,
  regionOfEdition,
  regionOfHost,
  regionOfUserRegion,
} from '../src/region.ts'
import { regionStateOf } from '../src/index.ts'
import { nextRegionSlots } from '../src/status-paths.ts'

describe('regionOfEdition', () => {
  it('maps the four editions onto the two routing buckets', () => {
    expect(regionOfEdition('cn')).toBe('cn')
    expect(regionOfEdition('solo')).toBe('cn')
    expect(regionOfEdition('sg')).toBe('ai')
    expect(regionOfEdition('solo-sg')).toBe('ai')
  })
})

describe('regionOfUserRegion', () => {
  it('reads the desktop object shape {region: "CN"|"SG"}', () => {
    expect(regionOfUserRegion({ region: 'CN', _aiRegion: 'CN' })).toBe('cn')
    expect(regionOfUserRegion({ region: 'SG', _aiRegion: 'SG' })).toBe('ai')
  })

  it('accepts bare strings and is case-blind (app logs spell "sg" lowercase)', () => {
    expect(regionOfUserRegion('CN')).toBe('cn')
    expect(regionOfUserRegion('sg')).toBe('ai')
    expect(regionOfUserRegion('SG')).toBe('ai')
    expect(regionOfUserRegion('  ai ')).toBe('ai')
  })

  it('returns undefined for absent or unrecognized claims', () => {
    expect(regionOfUserRegion(undefined)).toBeUndefined()
    expect(regionOfUserRegion('')).toBeUndefined()
    expect(regionOfUserRegion('eu')).toBeUndefined()
    expect(regionOfUserRegion({})).toBeUndefined()
    expect(regionOfUserRegion([1])).toBeUndefined()
  })
})

describe('regionOfHost', () => {
  it('routes trae.ai hosts to ai and trae.cn hosts to cn', () => {
    expect(regionOfHost('https://growsg-normal.trae.ai')).toBe('ai')
    expect(regionOfHost('https://api-sg-central.trae.ai/')).toBe('ai')
    expect(regionOfHost('coresg-normal.trae.ai')).toBe('ai')
    expect(regionOfHost('https://api.trae.cn')).toBe('cn')
    expect(regionOfHost('https://www.trae.com.cn')).toBe('cn')
  })

  it('returns undefined for empty or foreign hosts', () => {
    expect(regionOfHost(undefined)).toBeUndefined()
    expect(regionOfHost('')).toBeUndefined()
    expect(regionOfHost('https://example.com')).toBeUndefined()
  })
})

describe('regionOfCredential', () => {
  it('prefers the userRegion claim over host and edition', () => {
    // The desktop international credential: SG claim + SG host + SG edition.
    expect(regionOfCredential({ edition: 'sg', host: 'https://api-sg-central.trae.ai', userRegion: 'SG' })).toBe('ai')
    // A CN claim wins even when later levels disagree.
    expect(regionOfCredential({ edition: 'solo-sg', host: 'https://growsg-normal.trae.ai', userRegion: 'cn' })).toBe('cn')
  })

  it('falls back to the host suffix, then the edition label', () => {
    expect(regionOfCredential({ edition: 'cn', host: 'https://api-sg-central.trae.ai' })).toBe('ai')
    expect(regionOfCredential({ edition: 'solo-sg', host: 'https://api.trae.cn' })).toBe('cn')
    // CLI tokens carry neither claim nor usable host: the edition decides.
    expect(regionOfCredential({ edition: 'cn', host: 'https://api.trae.cn' })).toBe('cn')
    expect(regionOfCredential({ edition: 'solo' })).toBe('cn')
    expect(regionOfCredential({ edition: 'solo-sg' })).toBe('ai')
  })
})

describe('REGION_GATEWAYS', () => {
  it('keeps one verified gateway per region and never shares a chat base', () => {
    expect(REGION_GATEWAYS.cn.chat).toBe('https://trae-api-cn.mchost.guru')
    expect(REGION_GATEWAYS.ai.chat).toBe('https://coresg-normal.trae.ai')
    expect(REGION_GATEWAYS.cn.remote).toContain('solo.trae.cn')
    expect(REGION_GATEWAYS.ai.remote).toContain('coresg-normal.trae.ai')
    expect(REGION_GATEWAYS.cn.chat).not.toBe(REGION_GATEWAYS.ai.chat)
    expect(REGION_GATEWAYS.cn.remote).not.toBe(REGION_GATEWAYS.ai.remote)
  })
})

describe('regionStateOf (config bucket migration)', () => {
  it('returns the explicit region slot when present', () => {
    const config = {
      regions: {
        cn: { enabledModelIds: ['glm-5.2'] },
        ai: { enabledModelIds: ['gpt-5.4'] },
      },
      enabledModelIds: ['legacy'],
    }
    expect(regionStateOf(config, 'cn')).toEqual({ enabledModelIds: ['glm-5.2'] })
    expect(regionStateOf(config, 'ai')).toEqual({ enabledModelIds: ['gpt-5.4'] })
  })

  it('reads the pre-split flat fields as the CN region and only for CN', () => {
    const legacy = {
      lastCatalog: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
      enabledModelIds: ['glm-5.2'],
      imageModelIds: ['glm-5.2'],
      contextBudgets: { 'glm-5.2': 200_000 },
    }
    // Pre-split configs were always captured from the CN endpoint, so the flat
    // fields are the CN state exactly.
    expect(regionStateOf(legacy, 'cn')).toEqual(legacy)
    // The ai region NEVER inherits them: that inheritance is the bug where a
    // stale CN directory is intersected with the international catalog and
    // silently drops the user's picks.
    expect(regionStateOf(legacy, 'ai')).toEqual({})
  })

  it('ignores absent flat fields instead of materializing undefined keys', () => {
    const state = regionStateOf({}, 'cn')
    expect('lastCatalog' in state).toBe(false)
    expect('enabledModelIds' in state).toBe(false)
    expect('imageModelIds' in state).toBe(false)
    expect('contextBudgets' in state).toBe(false)
  })
})

describe('nextRegionSlots (card save merge)', () => {
  it('writes only the signed-in region and carries the other slot untouched', () => {
    const existing = {
      cn: { enabledModelIds: ['glm-5.2'], lastCatalog: [], imageModelIds: [], contextBudgets: { 'glm-5.2': 200_000 } },
      ai: { enabledModelIds: ['gpt-5.4'], lastCatalog: [], imageModelIds: [], contextBudgets: {} },
    }
    const next = nextRegionSlots(existing, 'ai', {
      lastCatalog: [{ id: 'gemini-3.1-pro', name: 'Gemini-3.1-Pro-Preview', input: ['text'] }],
      enabledModelIds: ['gemini-3.1-pro'],
      imageModelIds: [],
      contextBudgets: {},
    })
    // The ai slot is the new write; the cn slot is carried byte-for-byte.
    expect(next['ai']).toMatchObject({ enabledModelIds: ['gemini-3.1-pro'] })
    expect(next['cn']).toEqual(existing['cn'])
  })

  it('tolerates an absent or malformed stored regions value', () => {
    expect(nextRegionSlots(undefined, 'cn', { enabledModelIds: [] })).toEqual({ cn: { enabledModelIds: [] } })
    expect(nextRegionSlots('garbage', 'ai', { enabledModelIds: [] })).toEqual({ ai: { enabledModelIds: [] } })
    expect(nextRegionSlots([1, 2], 'cn', { enabledModelIds: [] })).toEqual({ cn: { enabledModelIds: [] } })
  })
})
