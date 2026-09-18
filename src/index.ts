import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import type { SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  createTraeAdapter,
  regionOfTraeProvider,
  TRAE_AI_PROVIDER,
  TRAE_PROVIDER,
  TRAE_PROVIDER_DISPLAY_NAMES,
  TRAE_PROVIDERS,
} from './adapter.ts'
import type { TraeAdapter } from './adapter.ts'
import { TraeCredentialStore } from './auth.ts'
import { applyImageSelection, deriveCatalog, discoveredCatalog, FALLBACK_TRAE_MODELS, fallbackModelsFor, mergeTraeModelSources, sanitizeCatalog, TraeCatalog, traeInputModalities, traeModelDisplayName, type TraeModelInfo } from './catalog.ts'
import { refreshTraeCredential, type TraeRefreshDevice } from './refresh.ts'
import { readTraeIdentity, resolveTraeIdentity } from './identity.ts'
import { traeStorageCandidates, type TraeEdition } from './paths.ts'
import { regionOfCredential, regionOfEdition, regionOfHost, regionOfUserRegion, REGION_GATEWAYS, type TraeRegion, type TraeRegionGateways } from './region.ts'
import { createTraeShim } from './shim.ts'
import type { TraeShim } from './shim.ts'
import { TraeSoloUpstreamClient } from './solo.ts'
import { TraeSoloBridge } from './solo-bridge.ts'
import type { TraeWireTarget } from './solo-bridge.ts'
import { TraeSoloRemoteCatalogClient } from './solo-remote.ts'
import { TraeRawChatUpstreamClient } from './raw-upstream.ts'
import { createTraeRawGateway } from './raw-gateway.ts'
import { resolveTraeRawRuntime } from './raw-resolver.ts'
import type { TraeRawDiagnostic } from './raw-diagnostic.ts'
import { TraeDelegatingUpstreamClient } from './delegating-upstream.ts'
import { TraeUsageClient } from './usage.ts'
import { registerTraeUsageRoute } from './web-status.ts'

export {
  createTraeAdapter,
  regionOfTraeProvider,
  TRAE_AI_PROVIDER,
  TRAE_PROVIDER,
  TRAE_PROVIDER_DISPLAY_NAMES,
  TRAE_PROVIDERS,
  TRAE_STREAM_IDLE_TIMEOUT_MS,
  type TraeAdapter,
} from './adapter.ts'
export {
  legacyTraeOwnAuthPath,
  normalizeTraeCredential,
  traeOwnAuthPath,
  TraeCredentialStore,
  type TraeCredential,
} from './auth.ts'
export {
  regionOfCredential,
  regionOfEdition,
  regionOfHost,
  regionOfUserRegion,
  REGION_GATEWAYS,
  type TraeRegion,
  type TraeRegionGateways,
} from './region.ts'
export { applyContextBudgets, applyImageSelection, deriveCatalog, discoveredCatalog, FALLBACK_TRAE_MODELS, FALLBACK_TRAE_MODELS_AI, fallbackModelsFor, mergeTraeModelSources, sanitizeCatalog, TraeCatalog, traeInputModalities, traeModelDisplayName, type TraeContextBudget, type TraeInputModality, type TraeModelInfo, type TraeWireModel } from './catalog.ts'
export { decryptTraeStorageValue, parseTraeAuthValue, parseTraeStorageDocument } from './decrypt.ts'
export { identityHeaders, pickTraeStorageIdentity, readTraeCliIdentity, readTraeIdentity, resolveTraeIdentity, type TraeIdentity } from './identity.ts'
export { parseObservedModelConfig, type TraeObservedModelConfig } from './model-config.ts'
export { parseTraeCachedModel, readTraeCachedModel, type TraeCachedModelConfig } from './model-cache.ts'
export { parseTraeModelExtraConfigLogLine, parseTraeRawChatBehaviorConfig, type TraeRawChatBehaviorConfig } from './model-extra-config.ts'
export { buildTraeModelDetailRequest, TRAE_MODEL_DETAIL_FUNCTIONS, TRAE_MODEL_DETAIL_PATH, type TraeModelDetailRequest } from './model-detail.ts'
export { parseTraeRemoteModel, type TraeDiscoveredModel, type TraeDiscoveredReasoning } from './model-metadata.ts'
export { traeStorageCandidates, type TraeEdition, type TraeStorageCandidate } from './paths.ts'
export { buildTraeAgentTaskBody, buildTraeCnHeaders, normalizeTraeVersionCode, TRAE_CN_AGENT_TASK_PATH, TRAE_CN_TITLE_PATH, TRAE_VERSION_CODE_FALLBACK, traeEndpoint } from './protocol.ts'
export { buildTraeRawChatDraft, decodeRawChatChunk, TRAE_RAW_CHAT_V1_PATH, TRAE_RAW_CHAT_V2_PATH, type RawChatDelta, type RawChatMessage, type RawChatTool } from './raw-chat.ts'
export { buildTraeFusionRawChatEnvelope, hashTraeRawChatArg, type TraeFusionRawChatEnvelope } from './raw-envelope.ts'
export { buildTraeRawChatRuntimeConfig, traeRawChatExtraInfo, type TraeRawChatRuntimeConfig } from './raw-runtime-config.ts'
export { resolveTraeRawRuntime, type TraeRawResolverResult } from './raw-resolver.ts'
export { rawCapabilityFingerprint } from './raw-fingerprint.ts'
export { rawCapabilityDiagnostic, type TraeRawDiagnostic, type TraeRawDiagnosticState } from './raw-diagnostic.ts'
export { createTraeRawGateway, type TraeRawGateway, type TraeRawGatewayOptions } from './raw-gateway.ts'
export { classifyTraeRawChatFailure, TraeRawChatUpstreamClient, type TraeRawChatClientOptions, type TraeRawChatConfig, type TraeRawChatFailureReason } from './raw-upstream.ts'
export { probeTraeRawChatCapability, type TraeRawChatCapability } from './raw-capability.ts'
export { TraeRawCapabilityState, type TraeRawCapabilitySnapshot } from './raw-capability-state.ts'
export { TraeRawCapabilityController, type TraeRawCapabilityControllerOptions } from './raw-capability-controller.ts'
export { TraeFallbackUpstreamClient, type TraeFallbackUpstreamOptions } from './fallback-upstream.ts'
export { TraeGatedUpstreamClient, type TraeGatedUpstreamOptions } from './gated-upstream.ts'
export { applyReasoningEffort, parseReasoningCapability, TRAE_REASONING_EFFORTS, type TraeReasoningCapability, type TraeReasoningEffort } from './reasoning.ts'
export { refreshTraeCredential, type TraeRefreshDevice } from './refresh.ts'
export { decodeTraeEvent, SseDecoder, type SseEvent, type TraeStreamEvent } from './sse.ts'
export { prepareSoloBody, TraeSoloUpstreamClient, TRAE_SOLO_CHAT_PATH, TRAE_SOLO_FUNCTION, TRAE_SOLO_MODELS_PATH, type TraeSoloClientOptions } from './solo.ts'
export { bridgeTraeSoloStream, TraeSoloBridge } from './solo-bridge.ts'
export { TraeSoloRemoteCatalogClient, TRAE_SOLO_REMOTE_BASE, type TraeSoloRemoteCatalogOptions } from './solo-remote.ts'
export { TraeDelegatingUpstreamClient } from './delegating-upstream.ts'
export { TRAE_PAY_BASE, TraeUsageClient, type TraeActivityRule, type TraeCheckinStatus, type TraeUsageOptions, type TraeUsagePack, type TraeUsageSnapshot, type TraeUsageSummary, type TraeUsageView } from './usage.ts'
export { registerTraeUsageRoute, traeWebUsage, type TraeUsageRouteOptions } from './web-status.ts'
export {
  regionOfTraeStatusUrl,
  TRAE_REGION_PARAM,
  TRAE_REGIONS,
  TRAE_USAGE_PATH,
  withTraeRegion,
  type TraeWebActivity,
  type TraeWebCheckin,
  type TraeWebCredits,
  type TraeWebUsage,
} from './status-paths.ts'
export { createTraeShim, type TraeShim } from './shim.ts'
export { UnconfiguredTraeUpstreamClient, type TraeChatResult, type TraeUpstreamClient } from './upstream.ts'

export const name = 'dsh-connect-trae'
export const inject = ['llm']
/**
 * Settings namespace, as a plain lowercase literal. DSH 0.1.2 removed the
 * `settingsNamespace` brand constructor from the npm package (the Desktop
 * host still ships it as a legacy shim), and every consumer of this constant —
 * `registerModelDiscovery`, `registerConfigurableProviders`,
 * `settings.installSection`, the settings test — takes it as a kebab string,
 * so no branding is needed for either host generation.
 */
export const TRAE_SETTINGS_NS = 'trae'

/** One region's saved model state: its own directory and the user's selection within it. */
export interface TraeRegionState {
  /** The last-refreshed raw directory for this region; what the card displays. */
  lastCatalog?: TraeModelInfo[]
  /** The user's selection in this region, as model ids (= Trae name). */
  enabledModelIds?: string[]
  /** Models the user explicitly enabled for image input in this region. */
  imageModelIds?: string[]
  /** Local DSH context budget per model in this region. */
  contextBudgets?: Record<string, number>
}

export interface Config {
  authFile?: string
  edition?: 'auto' | 'cn' | 'sg' | 'solo' | 'solo-sg'
  /**
   * @deprecated Legacy single-slot account selector from before the dual
   * provider split. It is attributed to whichever region the account actually
   * belongs to (resolved once at startup from the local account scan); new
   * writes go to {@link Config.accounts}.
   */
  accountId?: string
  /**
   * Per-region account selections, keyed `cn` | `ai`. Each region's tab writes
   * its own slot; tokens remain outside settings.
   */
  accounts?: Partial<Record<TraeRegion, string>>
  /**
   * Per-region model state, keyed `cn` | `ai`. The CN and international apps
   * expose different rosters, so each keeps its own directory and selection
   * and switching accounts never drops the other region's picks.
   */
  regions?: Partial<Record<TraeRegion, TraeRegionState>>
  /**
   * @deprecated Legacy single-slot fields from before the region split. They
   * predate international support and are read as the CN region's state when
   * `regions.cn` is absent; new writes go to `regions`.
   */
  lastCatalog?: TraeModelInfo[]
  /** @deprecated See {@link Config.lastCatalog}. */
  enabledModelIds?: string[]
  /** @deprecated See {@link Config.lastCatalog}. */
  contextBudgets?: Record<string, number>
  /** @deprecated See {@link Config.lastCatalog}. */
  imageModelIds?: string[]
  /** @deprecated Legacy generated runtime catalog; kept for backwards compatibility. */
  models?: TraeModelInfo[]
}

/**
 * One region's saved state. A config written before the region split has only
 * the flat fields: those were always captured from the CN endpoint (the
 * plugin had no international support), so they are read as the CN state and
 * only when no explicit CN slot exists. The ai region never inherits them —
 * that inheritance is exactly the bug where a stale CN directory would be
 * intersected with the international catalog and silently drop the user's
 * picks (the same failure workbuddy fixed with its region split).
 */
export function regionStateOf(config: Config, region: TraeRegion): TraeRegionState {
  const stored = config.regions?.[region]
  if (stored !== undefined) return stored
  if (region !== 'cn') return {}
  return {
    ...config.lastCatalog === undefined ? {} : { lastCatalog: config.lastCatalog },
    ...config.enabledModelIds === undefined ? {} : { enabledModelIds: config.enabledModelIds },
    ...config.imageModelIds === undefined ? {} : { imageModelIds: config.imageModelIds },
    ...config.contextBudgets === undefined ? {} : { contextBudgets: config.contextBudgets },
  }
}

const modelConfig = z.object({
  id: z.string().required(),
  name: z.string().required(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(['text', 'image'])),
  // Declared so the multiplier survives future hosts whose settings schema
  // might strip unknown fields; it feeds the DSH-facing display name.
  creditMultiplier: z.number(),
  // The directory function this model must be called through (Trae's roster is
  // split across SOLO-mode functions; glm-5.3 answers only solo_work_remote).
  // Persisted so a saved directory keeps working after a restart.
  wireFunction: z.string(),
})

const regionStateConfig = z.object({
  lastCatalog: z.array(modelConfig).default([]),
  enabledModelIds: z.array(z.string()).default([]),
  imageModelIds: z.array(z.string()).default([]),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}),
})

const accountSelectionConfig = z.object({
  cn: z.string().description('Selected domestic (CN) account id (never a token)'),
  ai: z.string().description('Selected international account id (never a token)'),
})

export const Config: z<Config> = z.object({
  authFile: z.string().description('Optional Trae storage.json path override'),
  edition: z.union(['auto', 'cn', 'sg', 'solo', 'solo-sg']).default('auto').description('Trae edition hint'),
  accountId: z.string().description('Deprecated: pre-split account selector, attributed to its own region'),
  accounts: accountSelectionConfig.description('Per-region account selections, keyed cn | ai'),
  regions: z.dict(regionStateConfig).default({}).description('Per-region model directory and selection, keyed cn | ai'),
  lastCatalog: z.array(modelConfig).description('Deprecated: pre-region-split CN model directory') as z<TraeModelInfo[]>,
  enabledModelIds: z.array(z.string()).default([]).description('Deprecated: pre-region-split CN selection'),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description('Deprecated: pre-region-split CN context budgets'),
  imageModelIds: z.array(z.string()).default([]).description('Deprecated: pre-region-split CN image opt-in'),
  models: z.array(modelConfig).description('Legacy generated Trae model list') as z<TraeModelInfo[]>,
})

/** Every region, in card tab order. */
const REGION_KEYS: readonly TraeRegion[] = ['cn', 'ai']

/**
 * How long activation waits for one region's loopback listener to bind before
 * giving up on that region.
 *
 * Binding an ephemeral port on the loopback interface is an immediate syscall,
 * so the normal case settles in well under a millisecond and this deadline is
 * only ever reached when the environment is already broken (an exhausted port
 * space, a security product blocking the bind). It exists so a listener that
 * never settles degrades one provider instead of stalling activation forever —
 * the harness serves the rest of its providers either way.
 */
const SHIM_BIND_TIMEOUT_MS = 5_000

/**
 * One region's complete runtime stack: its own credential store, model
 * catalog, wire map, upstream clients, and loopback shim. The two regions are
 * fully parallel provider stacks, so a domestic and an international account
 * serve simultaneously and a change on one side (account switch, catalog
 * refresh) never touches the other.
 */
interface TraeRegionStack {
  region: TraeRegion
  store: TraeCredentialStore
  catalog: TraeCatalog
  shim: TraeShim
  delegating: TraeDelegatingUpstreamClient
  usageClient: TraeUsageClient
  /** Re-read this region's live directory from the upstream. */
  discoverModels(signal?: AbortSignal): Promise<readonly TraeModelInfo[]>
  /** Rebuild the adapter snapshot after `catalog.set`; no-op before registration. */
  invalidateAdapter: () => void
  /** Raw-Chat capability state for this region's card route. */
  rawDiagnostic: () => TraeRawDiagnostic
}

export function apply(ctx: Context, config: Config): void {
  let current = () => config

  /**
   * Render an unknown thrown value as one readable line. Plugin degradation
   * messages must carry the real cause — a swallowed reason is what turns a
   * five-second diagnosis into an afternoon of guessing.
   */
  const reasonText = (error: unknown): string =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  /**
   * Register a disposal effect without letting the registration itself break
   * activation.
   *
   * `ctx.effect` throws when it is called after the plugin's fiber is gone —
   * which is reachable from any `await`ed startup step that resumes after a
   * dispose or an HMR reload. That throw used to escape into the
   * `Promise.all(...).then(...)` chain, where it became an unhandled rejection:
   * DSH's fail-loud handler then killed the whole process, and because the
   * actual error was replaced by that generic exit the cause was invisible.
   * Activation must never depend on the timing of a teardown registration, so
   * a failure here is a warning and the caller's `fallback` still runs the
   * release at the point of failure.
   */
  const registerEffect = (effect: () => () => void, label: string, fallback?: () => void): void => {
    try {
      ctx.effect(effect, label)
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-connect-trae: could not register the "${label}" cleanup; running it immediately`, reasonText(error))
      fallback?.()
    }
  }
  const enabledSet = (value: Config, region: TraeRegion): ReadonlySet<string> => new Set(regionStateOf(value, region).enabledModelIds ?? [])
  const imageSet = (value: Config, region: TraeRegion): ReadonlySet<string> => new Set(regionStateOf(value, region).imageModelIds ?? [])
  /**
   * Per-region wire state. Each region's discovery owns its own maps: the CN
   * and international rosters overlap (and spell some ids differently), so a
   * shared map would let one region's answer filter the other region's
   * catalog. Display keys (lowercased id AND name) of every model known to be
   * callable via `llm_utils_chat` are recorded by that region's discovery; a
   * model whose id and name are both absent is a dead config_name (Remote
   * advertises it, `get_detail_param` has no match, e.g. `Doubao-Seed-Code` /
   * `glm-5.3`) and must never be served — even from a stale saved
   * `lastCatalog` / `models` / `enabledModelIds` that still lists it.
   */
  const wireState = {} as Record<TraeRegion, {
    callableKeys: Set<string>
    /**
     * Whether discovery has actually produced a directory this run. Only a
     * completed merge may filter anything: an empty `callableKeys` means "no
     * wire answer yet" (no credentials, startup discovery failed or still in
     * flight) and must not be read as "nothing is callable".
     */
    resolved: boolean
    byId: Map<string, TraeWireTarget>
    byName: Map<string, TraeWireTarget>
  }>
  for (const region of REGION_KEYS) {
    wireState[region] = { callableKeys: new Set(), resolved: false, byId: new Map(), byName: new Map() }
  }
  // Drop dead rows from a (possibly stale) saved directory. No-op when that
  // region's wire map has not been resolved yet, so a transient network
  // failure never hides the whole catalog.
  const dropDeadModels = (rows: readonly TraeModelInfo[], region: TraeRegion): readonly TraeModelInfo[] => {
    const wire = wireState[region]
    if (!wire.resolved) return rows
    return rows.filter(model =>
      wire.callableKeys.has(model.id.trim().toLowerCase()) || wire.callableKeys.has(model.name.trim().toLowerCase()))
  }
  // Runtime catalog derives from the last-refreshed raw directory plus the
  // user's selection and context budgets. Legacy `models` and pre-budget
  // `lastCatalog` rows are sanitized, so saved `@1m` variants cannot return.
  // Dead config_names are dropped against the live wire map, so a stale save
  // cannot resurrect `Doubao-Seed-Code` / `glm-5.3`. An empty selection serves
  // the whole directory, so a never-configured plugin still exposes models.
  // Built-in last resort. It is this plugin's own static list, never a row
  // Remote advertised, so it must NOT be run through `dropDeadModels`: the
  // live wire map can only ever confirm the ids it happens to know, and
  // filtering against it would let a partial catalog delete the safety net
  // precisely when it is needed. Its ids are the well-known Trae model names.
  // Region-scoped: the two regions expose different rosters, so an account
  // must never see the other region's fallback list.
  const fallbackModels = (value: Config, region: TraeRegion): readonly TraeModelInfo[] =>
    applyImageSelection(fallbackModelsFor(region), imageSet(value, region))
  const derive = (value: Config, raw: readonly TraeModelInfo[], region: TraeRegion): readonly TraeModelInfo[] => {
    const selectedImages = imageSet(value, region)
    const derived = deriveCatalog(applyImageSelection(sanitizeCatalog(dropDeadModels(raw, region)), selectedImages), enabledSet(value, region), regionStateOf(value, region).contextBudgets ?? {})
    return derived.length > 0 ? derived : fallbackModels(value, region)
  }
  // Runtime catalog for one region: that region's saved directory (explicit
  // slot, else the pre-split flat fields which are CN-only), else the legacy
  // `models` list (also CN-only), else the region's fallback.
  const configuredModels = (value: Config, region: TraeRegion): readonly TraeModelInfo[] => {
    const state = regionStateOf(value, region)
    return state.lastCatalog?.length ? derive(value, state.lastCatalog, region)
      : region === 'cn' && value.models?.length ? derive(value, value.models, region)
        : fallbackModels(value, region)
  }
  // What the plugin card displays: the region's last-refreshed raw directory,
  // so the user re-reads the current Trae catalog rather than a stale snapshot.
  const displayModels = (value: Config, region: TraeRegion): readonly TraeModelInfo[] => {
    const state = regionStateOf(value, region)
    return state.lastCatalog?.length ? dropDeadModels(sanitizeCatalog(state.lastCatalog), region)
      : region === 'cn' && value.models?.length ? dropDeadModels(sanitizeCatalog(value.models), region)
        : fallbackModelsFor(region)
  }
  /**
   * Legacy migration for the pre-split single `accountId`: its region is
   * resolved once from the local account scan and the selection is then
   * attributed to that region ONLY — the other region keeps its documented
   * default (first discovered account of that region) instead of silently
   * inheriting a selection that belongs to the other side of the split.
   */
  let legacyAccountRegion: TraeRegion | undefined
  const effectiveAccountFor = (region: TraeRegion, value: Config): string | undefined => {
    const explicit = value.accounts?.[region]
    if (explicit !== undefined) return explicit
    return legacyAccountRegion === region ? value.accountId : undefined
  }

  /**
   * Retry a directory read once. The gateways answer an intermittent 401 for a
   * credential that works moments later (observed 2026-09-15), and a failed
   * skeleton read would otherwise drop the runtime catalog back to the saved
   * snapshot — hiding every model added since that save (issue #7's glm-5.3
   * among them).
   */
  async function withDirectoryRetry<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch (first: unknown) {
      await new Promise(resolve => setTimeout(resolve, 800))
      try {
        return await read()
      } catch {
        throw first
      }
    }
  }

  const stacks = {} as Record<TraeRegion, TraeRegionStack>
  for (const region of REGION_KEYS) {
    const catalog = new TraeCatalog(region)
    const wire = wireState[region]
    /**
     * Best-effort device identity for this region's installation. Prefer the
     * selected credential's own edition so an international account reads its
     * own installation's identity (machine/device ids are per-install),
     * mirroring the credential store's account binding; the explicit `edition`
     * config still wins as the user's own narrowing. Candidates are then
     * narrowed to THIS region's editions, so the CN stack can never read an
     * international install's identity (and vice versa).
     */
    const identity = async () => {
      let preferred: TraeEdition | undefined
      try { preferred = (await store.current())?.edition } catch { /* fall through to every candidate */ }
      const explicit = config.edition !== undefined && config.edition !== 'auto' ? config.edition : undefined
      const hint = explicit ?? preferred
      // Pick the first desktop candidate whose storage file actually exists,
      // mirroring the credential store's skip-missing semantics. Windows
      // machines often install only SOLO, so pinning the first (cn) candidate
      // and reading a missing file used to throw ENOENT and break every
      // refresh/chat request.
      const candidates = config.authFile === undefined
        ? traeStorageCandidates().filter(item => item.source === 'desktop'
          && (hint !== undefined ? item.edition === hint : regionOfEdition(item.edition) === region))
        : [{ edition: hint ?? (region === 'ai' ? 'sg' as const : 'solo' as const), path: config.authFile, source: 'desktop' as const }]
      // Desktop storage first; a machine with only the CLI (`traecli`, the WSL2
      // case) has no storage.json at all, and identity resolution falls back to
      // the CLI home's own deterministic identifiers instead of failing every
      // directory refresh and chat request.
      const cliEdition = hint ?? (region === 'ai' ? 'solo-sg' as const : 'cn' as const)
      return resolveTraeIdentity(candidates, cliEdition)
    }
    /**
     * Resolution failures degrade to omitting DeviceInfo (its being required
     * is unverified, docs/INTL_SG_EVIDENCE.md §5) rather than failing the
     * refresh.
     */
    const refreshDeviceSafe = async (): Promise<TraeRefreshDevice | undefined> => {
      try {
        const value = await identity()
        return { deviceId: value.deviceId, machineId: value.machineId }
      } catch {
        return undefined
      }
    }
    const store = new TraeCredentialStore({
      region,
      ...config.authFile === undefined ? {} : { storagePath: config.authFile },
      edition: config.edition ?? 'auto',
      // The refresh callback resolves the device identity lazily so an
      // international SOLO account refreshes with its own installation's
      // machine/device ids (the official client sends a DeviceInfo body there).
      refresh: async credential => refreshTraeCredential(credential, undefined, await refreshDeviceSafe()),
    })
    // No baseUrl: the chat gateway follows the selected credential's region
    // (`trae-api-cn.mchost.guru` for CN, `coresg-normal.trae.ai` for ai).
    const solo = new TraeSoloUpstreamClient({
      credential: () => store.resolve(),
      identity,
      log: (message, detail) => ctx.logger.warn(message, detail),
    })
    const remoteCatalog = new TraeSoloRemoteCatalogClient({ credential: () => store.resolve() })
    // Keep the native llm_utils_chat bridge as the only chat route: unlike the
    // polling Remote session API, it preserves Trae's structured tool_calls so
    // DSH can execute local read/write/bash tools and continue the agent loop.
    // A wire resolver maps each display model id to its real llm_utils_chat
    // config_name. It is populated once at startup from get_detail_param and
    // never depends on a user-refreshed or re-saved directory, so Seed-Code and
    // other models whose wire id differs from the display id resolve correctly
    // even on a fresh install. The map is per region: the two rosters overlap
    // but are not identical, and a shared map would cross-resolve ids.
    const wireResolver = (displayId: string): TraeWireTarget | undefined =>
      wire.byId.get(displayId) ?? wire.byName.get(displayId.trim().toLowerCase())
    const upstream = new TraeSoloBridge(solo, catalog, wireResolver)
    // The shim always sees a stable client; the Raw gateway may replace the
    // delegate asynchronously, but it stays disabled until a probe succeeds.
    const delegating = new TraeDelegatingUpstreamClient(upstream)
    const shim = createTraeShim({ catalog, client: delegating, logger: ctx.logger })
    let rawDiagnostic = (): TraeRawDiagnostic => ({ state: 'disabled' })

    // Raw Chat is probed on the CN stack only: the probe model
    // (`qwen-3.7-plus`) is CN-only, and the gateway stays disabled either way
    // — SOLO remains the only live path. The international stack therefore
    // reports `disabled` and never touches the raw endpoint.
    if (region === 'cn') {
      void (async () => {
        try {
          const probeModel = 'qwen-3.7-plus'
          const resolved = await resolveTraeRawRuntime(store, probeModel)
          const rawClient = new TraeRawChatUpstreamClient({
            credential: () => store.resolve(),
            identity: async () => resolved.identity,
            config: { model: resolved.runtime.modelName, configName: resolved.runtime.configName, passBackReasoning: true, runtime: resolved.runtime },
          })
          const gateway = createTraeRawGateway({
            raw: rawClient,
            solo: upstream,
            endpoint: `${REGION_GATEWAYS.cn.chat}/api/ide/v2/llm_raw_chat`,
            edition: resolved.identity.edition,
            identity: { appVersion: resolved.identity.appVersion ?? '', buildVersion: resolved.identity.buildVersion ?? '' },
            runtime: resolved.runtime,
            // Raw Chat stays opt-in and unverified; SOLO remains the only live path.
            enabled: false,
          })
          delegating.replace(gateway.upstream)
          rawDiagnostic = () => gateway.diagnostic()
          registerEffect(() => () => gateway.invalidate(), 'dsh-connect-trae: Raw capability invalidation')
        } catch (error: unknown) {
          ctx.logger.warn('dsh-connect-trae: Raw gateway unavailable; continuing with native SOLO tool-call channel', error)
        }
      })()
    }

    // Read-only usage/credit summary served to the browser half. Optional on
    // the `webServer` seam; absent in headless runs, the host provider still
    // works.
    //
    // Account selection is strictly the user's choice: the store resolves the
    // explicitly selected `accountId` verbatim, and only falls back to the
    // first discovered account when nothing has been selected yet. The plugin
    // must NOT silently switch to a different account that happens to have
    // general credits — that would bill the wrong account against the user's
    // intent.
    const usageClient = new TraeUsageClient({ credential: () => store.resolve() })

    stacks[region] = {
      region,
      store,
      catalog,
      shim,
      delegating,
      usageClient,
      discoverModels: async (signal?: AbortSignal): Promise<readonly TraeModelInfo[]> => {
        // The Remote /models directory is the model skeleton (display id, name,
        // context, credit, reasoning). get_detail_param only supplies the real
        // llm_utils_chat config_name for models whose display id differs from
        // the wire id (e.g. Seed-Code); it does not define the catalog itself.
        // The remote directory is the merge skeleton (it is what filters
        // agent-internal configs out of the wire roster). Trae's directory
        // endpoints rate-limit aggressively — observed as an intermittent
        // HTTP 401 on a credential that answers 200 seconds earlier — so a
        // transient rejection must not silently collapse the whole catalog to
        // the saved snapshot. Retry it once before giving up.
        const remote = await withDirectoryRetry(() => remoteCatalog.fetchModels(signal))
        const wireModels = await solo.fetchModels(signal)
        const merged = mergeTraeModelSources(remote, wireModels)
        // Record every callable display key (id and name) so stale saved
        // catalogs are filtered against the live wire map and dead
        // config_names cannot be resurrected from an old `lastCatalog` /
        // `models` / `enabledModelIds`.
        wire.callableKeys.clear()
        for (const model of merged) {
          wire.callableKeys.add(model.id.trim().toLowerCase())
          wire.callableKeys.add(model.name.trim().toLowerCase())
        }
        // Mark the wire map authoritative only once a merge produced rows. A
        // live Trae account that reports only part of the catalog (or an
        // edition whose `/models` list is a subset) would otherwise let this
        // filter delete every model it did not mention — including the
        // built-in fallback set, which Remote never advertised and so can
        // never appear in `callableKeys`.
        wire.resolved = merged.length > 0
        // Populate the startup wire resolver (display id and display name →
        // wire config_name) so the chat bridge resolves the real config_name
        // even when the persisted catalog lacks `wireConfigName` (the settings
        // schema drops unknown fields on save/load).
        wire.byId.clear()
        wire.byName.clear()
        for (const model of merged) {
          if (model.wireConfigName !== undefined) {
            const target = {
              configName: model.wireConfigName,
              ...model.wireFunction === undefined ? {} : { function: model.wireFunction },
            }
            wire.byId.set(model.id, target)
            wire.byName.set(model.name.trim().toLowerCase(), target)
          }
        }
        // Discovery is a pure data return (workbuddy semantics): the card's
        // "refresh" drafts this list for an explicit save, and the startup
        // seed installs it into the live catalog. Writing it here would leak
        // un-enabled models into the runtime catalog until the next save.
        return merged
      },
      invalidateAdapter: () => {},
      rawDiagnostic: () => rawDiagnostic(),
    }
  }

  // Same-origin routes backing the card. Each request names the region whose
  // tab it belongs to; the region-scoped accessors below then read (and the
  // save writes back into) that region's own slot.
  ctx.inject(['webServer'], (webCtx) => registerTraeUsageRoute(webCtx, {
    store: region => stacks[region].store,
    client: region => stacks[region].usageClient,
    displayModels: region => displayModels(current(), region),
    enabledModelIds: region => regionStateOf(current(), region).enabledModelIds ?? [],
    discoverModels: (region, signal) => stacks[region].discoverModels(signal),
    rawDiagnostic: region => stacks[region].rawDiagnostic(),
  }))

  /** Push the current config into every region's store selection and catalog. */
  const applySelection = (value: Config): void => {
    for (const region of REGION_KEYS) {
      const stack = stacks[region]
      stack.store.setSource(value.authFile, value.edition ?? 'auto', effectiveAccountFor(region, value))
      stack.catalog.set(configuredModels(value, region))
      stack.invalidateAdapter()
    }
  }

  const sectionHooks: SettingsSectionHooks<Config> = {
    setSource(source) { current = source },
    onChange() { applySelection(current()) },
  }

  // Initial wiring: selections and per-region catalogs from the saved state.
  applySelection(config)

  // Attribute the legacy single-account selection to its own region once the
  // local scan can tell which one that is, then re-apply. Until this resolves
  // (or when no legacy field exists) both regions simply run their defaults.
  void (async () => {
    const id = current().accountId
    if (id === undefined) return
    try {
      for (const region of REGION_KEYS) {
        const accounts = await stacks[region].store.accounts()
        if (accounts.some(account => account.id === id)) {
          legacyAccountRegion = region
          applySelection(current())
          return
        }
      }
      // The saved account vanished (Trae replaced its sign-in): no attribution,
      // both regions keep their defaults, and the card lets the user re-select.
    } catch {
      // Scan failure: keep defaults; the next card-driven scan converges.
    }
  })()
  // DSH 0.1.2 replaced the free `installSettingsSection` helper with the
  // `settings` service's `installSection` method. The Desktop host keeps the
  // old helper as a legacy shim, but npm installs of 0.1.2 do not — and a
  // named import of a missing export fails at ESM link time, so the plugin
  // reads it defensively off the module namespace. Prefer the helper when it
  // exists (0.1.1 hosts and shimmed 0.1.2 hosts) and fall back to the service
  // method everywhere else, so one build serves both host generations.
  const legacyInstallSettingsSection = (dshSettings as {
    installSettingsSection?: (ctx: Context, ns: string, schema: z<Config>, entry: Config, hooks: SettingsSectionHooks<Config>) => void
  }).installSettingsSection
  if (typeof legacyInstallSettingsSection === 'function') {
    legacyInstallSettingsSection(ctx, TRAE_SETTINGS_NS, Config, config, sectionHooks)
  } else {
    ctx.inject(['settings'], settingsCtx => {
      settingsCtx.settings.installSection(ctx, TRAE_SETTINGS_NS, Config, config, sectionHooks)
    })
  }

  let stopped = false
  // Dispose contract, registered synchronously in `apply` (never from inside an
  // `await`ed startup step, where a late resume could throw into the boot
  // chain): stop the seed/discovery work and tear the two loopback listeners
  // down.
  registerEffect(() => () => {
    stopped = true
    for (const region of REGION_KEYS) void stacks[region].shim.close()
  }, 'dsh-connect-trae: loopback shim shutdown')

  /**
   * Wait until one region's loopback shim is actually bound, or give up after
   * `timeoutMs` with a warning.
   *
   * This is the gate the adapter's `baseUrl` precondition depends on: it is the
   * only place that may conclude "this region has a port". A failure is
   * reported and mapped to `false`, never thrown — a listener that will not
   * bind must degrade its own region, not the boot.
   */
  const shimListening = async (region: TraeRegion): Promise<boolean> => {
    const shim = stacks[region].shim
    const listening = await shim.whenListening(SHIM_BIND_TIMEOUT_MS)
    if (!listening) {
      ctx.logger.warn(`dsh-connect-trae: the ${region} loopback shim did not bind within ${SHIM_BIND_TIMEOUT_MS}ms; the ${TRAE_PROVIDERS[region]} provider stays unregistered (other providers are unaffected)`, shim.reason())
    }
    return listening
  }

  /**
   * Build and register one region's provider route.
   *
   * Scoped per region on purpose: the two stacks are independent, and a failure
   * on one side (no credentials, an image-less catalog, a rejected route) must
   * not take the other side down with it. Returns the release handle, or
   * `undefined` after reporting why this region is unavailable.
   */
  const registerRegionProvider = (region: TraeRegion): (() => void) | undefined => {
    const stack = stacks[region]
    try {
      const trae = createTraeAdapter({
        baseUrl: stack.shim.baseUrl(),
        apiKey: stack.shim.token(),
        catalog: stack.catalog,
        provider: TRAE_PROVIDERS[region],
        displayName: TRAE_PROVIDER_DISPLAY_NAMES[region],
        resolveAttachments: () => ctx.get('attachments'),
      })
      const release = ctx.llm.registerAdapter([TRAE_PROVIDERS[region]], trae.adapter)
      // Only after the route is live: until then the catalog change has no
      // adapter to invalidate.
      stack.invalidateAdapter = () => { trae.invalidate() }
      return release
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-connect-trae: the ${TRAE_PROVIDERS[region]} provider could not be registered; its models stay unavailable while every other provider keeps working`, reasonText(error))
      return undefined
    }
  }

  /**
   * One activation pass: bind gate, provider routes, directory metadata, then
   * the background seed.
   *
   * Every failure mode below is contained and reported. Nothing in this
   * function may reject: the caller has no way to recover, and a rejection here
   * is exactly what used to become an unhandled rejection and abort the entire
   * harness process.
   */
  const boot = async (): Promise<void> => {
    await Promise.all(REGION_KEYS.map(shimListening))
    if (stopped) return

    const releases: (() => void)[] = []
    for (const region of REGION_KEYS) {
      const release = registerRegionProvider(region)
      if (release !== undefined) releases.push(release)
    }
    const releaseAll = (): void => {
      releases.splice(0).forEach(release => { release() })
    }
    registerEffect(() => releaseAll, 'dsh-connect-trae: provider route registration', releaseAll)

    try {
      ctx.llm.registerModelDiscovery(TRAE_SETTINGS_NS, async (request, signal) => {
        const region = regionOfTraeProvider(request.provider ?? '')
        if (region === undefined) return []
        // Discovery must advertise the same image capability as the live
        // adapter catalog. The upstream flag is deliberately ignored; only the
        // user's explicit `imageModelIds` selection is authoritative.
        //
        // DSH 0.1.2 moved discovery cancellation from `request.signal` onto
        // the callback's second argument; 0.1.1 hosts still pass it on the
        // request object, so read both.
        const cancellation = signal ?? (request as { signal?: AbortSignal }).signal
        const next = applyImageSelection(
          await stacks[region].discoverModels(cancellation),
          imageSet(current(), region),
        )
        return next.map(model => ({
          id: model.id,
          name: traeModelDisplayName(model),
          ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
          ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
          // Current dsh-llm discovery types do not yet declare this field, but
          // model-management consumers already understand it. Keep the value
          // aligned with the adapter catalog; DSH core may discard it today.
          inputModalities: traeInputModalities(model),
        }))
      })
      const releaseDirectory = ctx.llm.registerConfigurableProviders(REGION_KEYS.map(region => ({
        provider: TRAE_PROVIDERS[region],
        displayName: TRAE_PROVIDER_DISPLAY_NAMES[region],
        settingsNs: TRAE_SETTINGS_NS,
        settingsPath: [],
        declared: false,
      })))
      releases.push(releaseDirectory)
    } catch (error: unknown) {
      // The routes themselves are already live; only the settings-facing
      // directory metadata is missing. Report and keep serving.
      ctx.logger.warn('dsh-connect-trae: the provider directory could not be registered; the routes keep serving while the model picker may show them as unconfigured', reasonText(error))
    }

    // Startup seed per region (workbuddy semantics): resolve the wire-id map
    // once at startup before serving requests, so the chat bridge can
    // translate display ids to real config_names without the user ever opening
    // the model card or re-saving the directory. The runtime catalog derives
    // from the LIVE directory of that region's selected account, so DSH serves
    // what the upstream actually answers today — an account on a
    // never-configured region gets its real roster (with wire ids) immediately,
    // without pressing "refresh" + "save" first. `lastCatalog` is deliberately
    // NOT seeded here: it belongs to the user's explicit save. A discovery
    // failure (no credentials, upstream down) degrades to the configured
    // state — the saved directory, else the region's fallback.
    for (const region of REGION_KEYS) {
      void (async () => {
        const stack = stacks[region]
        try {
          const models = await stack.discoverModels()
          if (stopped) return
          stack.catalog.set(derive(current(), models, region))
        } catch (error: unknown) {
          if (stopped) return
          ctx.logger.warn(`dsh-connect-trae: live ${region} model directory unavailable; serving the configured catalog`, reasonText(error))
          stack.catalog.set(configuredModels(current(), region))
        }
        stack.invalidateAdapter()
      })().catch((error: unknown) => {
        // Belt and braces: the body above handles its own failures, so reaching
        // here means an unexpected one. It must still not become an unhandled
        // rejection.
        ctx.logger.warn(`dsh-connect-trae: the ${region} startup catalog seed failed`, reasonText(error))
      })
    }
  }

  void boot().catch((error: unknown) => {
    ctx.logger.warn('dsh-connect-trae: startup did not complete; the plugin is mounted but its providers may be unavailable (the rest of the harness is unaffected)', reasonText(error))
  })
}
