/**
 * Node-free constants and types shared by the Host and browser halves.
 * Mirrors the `dsh-workbuddy-connect` status-route pattern so the plugin card
 * stays consistent with that project's external presentation.
 */
import type { TraeRegion } from './region.ts'

/** Plugin-owned usage endpoint consumed by its browser half. */
export const TRAE_USAGE_PATH = '/plugins/dsh-connect-trae/usage'
/** Plugin-owned live model refresh endpoint. */
export const TRAE_MODELS_REFRESH_PATH = '/plugins/dsh-connect-trae/models/refresh'
/** Plugin-owned local account rescan endpoint. */
export const TRAE_ACCOUNTS_REFRESH_PATH = '/plugins/dsh-connect-trae/accounts/refresh'

/** Query parameter naming the region a card request addresses. */
export const TRAE_REGION_PARAM = 'region'

/** Every region, in card tab order. */
export const TRAE_REGIONS: readonly TraeRegion[] = ['cn', 'ai']

/**
 * Address one region's status route. The two regions are separate provider
 * stacks; every card request carries the region whose tab the user is on.
 */
export function withTraeRegion(path: string, region: TraeRegion): string {
  return `${path}?${TRAE_REGION_PARAM}=${region}`
}

/**
 * Read the region parameter off a status-route URL. Absent means the domestic
 * tab (`cn`); a present-but-unknown value returns undefined so the route can
 * answer 400 instead of guessing.
 */
export function regionOfTraeStatusUrl(url: string): TraeRegion | undefined {
  const at = url.indexOf('?')
  const value = at === -1 ? null : new URLSearchParams(url.slice(at + 1)).get(TRAE_REGION_PARAM)
  if (value === null || value === '') return 'cn'
  return (TRAE_REGIONS as readonly string[]).includes(value) ? value as TraeRegion : undefined
}

/** One credit pack and its remaining credit. */
export interface TraeWebCreditAccount {
  displayDesc: string
  remain: number
  size: number
}

/** Aggregated usage/credit answer rendered by the plugin card. */
export interface TraeWebCredits {
  total: number
  consumed: number
  available: number
  workAvailable: number
  generalAvailable: number
  accounts: readonly TraeWebCreditAccount[]
}

/** Editable Trae model row rendered by the plugin-owned settings card. */
export interface TraeWebModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  input?: ('text' | 'image')[]
  creditMultiplier?: number
  reasoningSupported?: boolean
  reasoning?: {
    supported: string[]
    defaultEffort?: string
  }
  maxContextWindow?: number
}

/** Daily check-in status rendered by the card. */
export interface TraeWebCheckin {
  checkedIn: boolean
  credits: number
}

/** One reward activity rule (name + work/general credits when present). */
export interface TraeWebActivity {
  activityId: string
  enabled: boolean
  workCredits?: number
  generalCredits?: number
}

export interface TraeWebAccount {
  id: string
  accountName: string
  edition: 'cn' | 'sg' | 'solo' | 'solo-sg'
  /** Routing bucket of this account, derived from its credential. */
  region: TraeRegion
  source: 'desktop' | 'dsh' | 'cli'
  tokenExpiresAtMs: number
  selected: boolean
}

/** One probed candidate path and why it did not yield an account. */
export interface TraeWebSearchPath {
  path: string
  edition: 'cn' | 'sg' | 'solo' | 'solo-sg'
  source: 'desktop' | 'cli'
  reason: 'missing' | 'unreadable' | 'invalid'
  message?: string
}

/**
 * Build the next `regions` settings value for the card's save. The write
 * targets ONLY the signed-in account's region slot; every other region's slot
 * is carried over untouched, so switching accounts never clobbers the other
 * region's picks. Tolerates any stored shape (absent, non-object) by starting
 * from an empty document.
 */
export function nextRegionSlots<Slot extends object>(
  regions: unknown,
  region: TraeRegion,
  slot: Slot,
): Record<string, unknown> {
  const base = typeof regions === 'object' && regions !== null && !Array.isArray(regions)
    ? regions as Record<string, unknown>
    : {}
  return { ...base, [region]: slot }
}

/** Subscription status of an international (ai) account, rendered instead of the CN credit packs. */
export interface TraeWebPayStatus {
  isDollarUsageBilling: boolean
  hasPackage: boolean
  isPayFreshman: boolean
  inTrial: boolean
  trialEndTimeMs: number
  enableSoloLite: boolean
  enableSoloBuilder: boolean
  enableSoloCoder: boolean
  enableSoloWeb: boolean
  fission?: { startTimeMs: number; expireTimeMs: number; maxUsage: number }
}

/** The JSON document the plugin card renders. */
export type TraeWebUsage =
  | { status: 'signed-out'; accounts: readonly TraeWebAccount[]; message?: string; searched?: readonly TraeWebSearchPath[] }
  | {
    status: 'signed-in'
    accountId: string
    accountName: string
    tokenExpiresAtMs: number
    /** Which per-region model directory and selection this account owns. */
    region: TraeRegion
    accounts: readonly TraeWebAccount[]
    models: readonly TraeWebModel[]
    enabledModelIds: readonly string[]
    rawChat?: {
      state: 'disabled' | 'unchecked' | 'available' | 'protocol-gated' | 'authentication' | 'credit' | 'rate' | 'transport' | 'server'
      checkedAtMs?: number
      status?: number
    }
    credits?: TraeWebCredits
    creditsError?: string
    /** Subscription status of an international account (region ai only). */
    payStatus?: TraeWebPayStatus
    payStatusError?: string
  }
  | { status: 'error'; message: string }
