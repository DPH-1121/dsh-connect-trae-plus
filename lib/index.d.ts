import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/reasoning.d.ts
declare const TRAE_REASONING_EFFORTS: readonly ["minimal", "low", "medium", "high", "xhigh"];
type TraeReasoningEffort = typeof TRAE_REASONING_EFFORTS[number];
interface TraeReasoningCapability {
  supported: readonly TraeReasoningEffort[];
  defaultEffort?: TraeReasoningEffort;
}
declare function parseReasoningCapability(value: unknown): TraeReasoningCapability | undefined;
/** Add effort only when the selected model advertises that exact value. */
declare function applyReasoningEffort<T extends Record<string, unknown>>(body: T, effort: TraeReasoningEffort | undefined, capability: TraeReasoningCapability | undefined): T & {
  reasoning_effort?: TraeReasoningEffort;
};
//#endregion
//#region src/model-metadata.d.ts
interface TraeDiscoveredReasoning {
  supported: TraeReasoningEffort[];
  defaultEffort?: TraeReasoningEffort;
}
interface TraeDiscoveredModel {
  id: string;
  name: string;
  multimodal: boolean;
  contextWindow?: number;
  maxContextWindow?: number;
  creditMultiplier?: number;
  reasoningSupported: boolean;
  reasoning?: TraeDiscoveredReasoning;
}
/** Parse only capabilities explicitly advertised by Trae's remote model API. */
declare function parseTraeRemoteModel(value: unknown): TraeDiscoveredModel | undefined;
//#endregion
//#region src/paths.d.ts
type TraeEdition = 'cn' | 'sg' | 'solo' | 'solo-sg';
/**
 * Where a local sign-in was persisted. `desktop` candidates hold an Electron
 * `globalStorage/storage.json` whose auth value is encrypted; `cli` candidates
 * hold a bare JWT written by the Trae CLI, which needs no decryption.
 */
type TraeCredentialSource = 'desktop' | 'cli';
interface TraeStorageCandidate {
  edition: TraeEdition;
  path: string;
  source: TraeCredentialSource;
}
declare function traeStorageCandidates(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): TraeStorageCandidate[];
//#endregion
//#region src/region.d.ts
/** Storage/routing bucket: the CN service or the international (ai) service. */
type TraeRegion = 'cn' | 'ai';
/** One region's upstream gateway bases. */
interface TraeRegionGateways {
  /** Chat + agent API base (the `llm_utils_chat` / raw-chat family). */
  readonly chat: string;
  /** SOLO remote model directory base (`/api/remote/v1`). */
  readonly remote: string;
  /** Pay/status API base; the credential's own host is preferred when known. */
  readonly pay: string;
}
/**
 * Verified gateway bases per region (docs/INTL_SG_EVIDENCE.md §2).
 * The AI gateway is shared by both international installs (Trae desktop and
 * TRAE SOLO); its mchost shards (`api16/api22-normal-alisg.mchost.guru`)
 * answer the same bytes but stay internal — `coresg-normal.trae.ai` is the
 * single stable entry point.
 */
declare const REGION_GATEWAYS: Readonly<Record<TraeRegion, TraeRegionGateways>>;
/** Region for an edition label: the international installs belong to `ai`. */
declare function regionOfEdition(edition: TraeEdition): TraeRegion;
/**
 * Region from the credential's `userRegion` claim. The desktop storage spells
 * it as an object (`{"region":"CN","_aiRegion":"CN"}`); the app logs also
 * spell the bare value lowercase (`"sg"`). Both are accepted, case-blind.
 */
declare function regionOfUserRegion(value: unknown): TraeRegion | undefined;
/** Region from a credential host (`.trae.ai` → ai, `.trae.cn`/`.trae.com.cn` → cn). */
declare function regionOfHost(host: string | undefined): TraeRegion | undefined;
/**
 * Region of a credential: the `userRegion` claim wins, the host suffix is the
 * fallback, and the edition label is the last resort. Every level is derived
 * from data the credential itself carries, so no user configuration is needed.
 */
declare function regionOfCredential(credential: {
  edition: TraeEdition;
  host?: string;
  userRegion?: string;
}): TraeRegion;
//#endregion
//#region src/catalog.d.ts
type TraeInputModality = 'text' | 'image';
/**
 * One model the adapter exposes. `contextWindow` is the effective DSH context
 * after the user's budget; `maxContextWindow` is the native Max window Trae
 * advertises (capability display only — never a second model entry).
 */
interface TraeModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: TraeInputModality[];
  creditMultiplier?: number;
  reasoningSupported?: boolean;
  reasoning?: TraeDiscoveredReasoning;
  reasoningEfforts?: Partial<Record<TraeReasoningEffort, string | null>>;
  maxContextWindow?: number;
  /** The `config_name` `llm_utils_chat` accepts; absent means `id` is already the wire id. */
  wireConfigName?: string;
  /** The directory function this model must be called through (see {@link TraeWireModel.function}). */
  wireFunction?: string;
}
/**
 * Bootstrap catalog: identity only where current Trae metadata has not been
 * fetched yet.
 *
 * Every id here must be a `config_name` that `llm_utils_chat` actually accepts,
 * because this list is served verbatim before the first live refresh lands and
 * it is NOT filtered against the wire map (the wire map can only confirm ids it
 * happens to know, so filtering would delete the safety net exactly when it is
 * needed — see `fallbackModels` in index.ts). The current CN roster was
 * verified against the live remote directory on 2026-09-15
 * (docs/DS41_CALLABILITY.md): `DeepSeek-V4-Flash-Official` and
 * `DeepSeek-V4-Pro-Official` carry the `-Official` suffix, and there is no
 * `auto` config_name — an `auto` row was previously served here and would have
 * failed on selection.
 *
 * Every row MUST also carry a positive-integer `contextWindow`. DSH rejects an
 * adapter whose model has no usable context (`INVALID_MODEL_CONTEXT`), and that
 * failure is per-provider — one bad row takes the whole region offline. These
 * rows are exactly the ones served when no live directory is available (no
 * install for that region, signed out, or a failed refresh), which is precisely
 * when the fallback is doing its job, so a missing field here is fatal rather
 * than cosmetic. See docs/ISSUE8_DIAGNOSIS.md.
 */
declare const FALLBACK_TRAE_MODELS: readonly TraeModelInfo[];
/**
 * Bootstrap catalog for the international (ai) region, captured from the
 * live `coresg-normal.trae.ai/api/remote/v1/models` directory on 2026-09-15
 * (docs/INTL_SG_EVIDENCE.md §3). The two rosters barely overlap (the CN list
 * has no Gemini/GPT/MiniMax entries), so an international account must never
 * be seeded with the CN list. Like the CN fallback it is replaced by the live
 * refresh; image input stays the user's explicit opt-in (`imageModelIds`).
 *
 * The `contextWindow` values are the measured ones from that same capture
 * (`docs/INTL_SG_EVIDENCE.md` §3) and are required for the same reason as the
 * CN fallback: without them the whole `trae-global` provider fails to load.
 */
declare const FALLBACK_TRAE_MODELS_AI: readonly TraeModelInfo[];
/**
 * Static fallback directory for a region. Each region keeps its own model
 * slot in settings; the fallback must match the region so an account never
 * shows the other region's roster.
 */
declare function fallbackModelsFor(region: TraeRegion): readonly TraeModelInfo[];
/** Exact DSH modalities for one catalog entry; absent metadata is text-only. */
declare function traeInputModalities(model: Pick<TraeModelInfo, 'input'>): TraeInputModality[];
/**
 * Compose the DSH-facing model name: Trae's own model picker renders each
 * entry as `Name · x<rate>`, so the credit multiplier is shown inside the
 * name. `TraeModelInfo.name` keeps the pure Trae display name — every join
 * (wire resolution, callable-key filtering) must keep matching the
 * undecorated name; only the model rows handed to DSH (adapter catalog and
 * model discovery) use this decorated name.
 */
declare function traeModelDisplayName(model: Pick<TraeModelInfo, 'name' | 'creditMultiplier'>): string;
/** Apply the user's explicit image opt-ins; upstream and saved row hints are ignored. */
declare function applyImageSelection(models: readonly TraeModelInfo[], selected: ReadonlySet<string>): TraeModelInfo[];
/** One row from `get_detail_param`: the authoritative llm_utils_chat wire id + display name. */
interface TraeWireModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: TraeReasoningCapability;
  /**
   * The `get_detail_param` function this config_name came from. Trae splits its
   * callable roster across several functions (SOLO modes), and a model is only
   * callable through the function that actually lists it — glm-5.3 answers
   * `solo_work_remote` but rejects `solo_work_lite` with 4001. The chat call
   * therefore has to replay the directory's own function.
   */
  function?: string;
}
/**
 * Merge the two Trae model sources into one authoritative catalog.
 *
 * `remote` (the solo.trae.cn `/models` directory) is the authoritative model
 * skeleton: it supplies the display id, display name, context windows, credit
 * multiplier, reasoning and multimodal flags. `wire` (from `get_detail_param`)
 * supplies the real `llm_utils_chat` `config_name` — the only id the chat
 * endpoint actually accepts. A remote row is only callable when it maps to a
 * wire `config_name`, so a remote row with no wire match is DROPPED (it would
 * otherwise be sent as an invalid `config_name` and rejected with 4001
 * "param is invalid"). Verified 2026-08-30: the Remote directory advertises
 * `Doubao-Seed-Code` and `glm-5.3`, neither of which is a current `config_name`;
 * both fail every request, so they must not be exposed.
 *
 * Joining is two-tier, in priority order:
 *  1. `wire.id` (the `config_name`) equals the remote id — the model's display
 *     id is already its wire id (the common case: glm-5.2,
 *     DeepSeek-V4-Flash-Official, kimi-k3, …).
 *  2. `wire.name` (the `display_name`) equals the remote display name — for
 *     models whose display id differs from the wire id across Trae versions.
 * When the matched wire `config_name` differs from the remote id it is recorded
 * as `wireConfigName`; otherwise it is left undefined (id is already the wire id).
 */
declare function mergeTraeModelSources(remote: readonly TraeDiscoveredModel[], wire: readonly TraeWireModel[]): TraeModelInfo[];
/** Local DSH context budget per model; a value may only select an advertised window. */
type TraeContextBudget = number;
/**
 * Apply the saved local budget. Trae advertises two windows per model (dev and
 * Max), so the budget may only switch a model to its own advertised Max value —
 * never to a fabricated number. Everything else keeps the dev window.
 */
declare function applyContextBudgets(catalog: readonly TraeModelInfo[], budgets?: Readonly<Record<string, TraeContextBudget | undefined>>): TraeModelInfo[];
/** Convert Trae metadata into text-only model rows; image support is user-owned configuration. */
declare function discoveredCatalog(models: readonly TraeDiscoveredModel[]): TraeModelInfo[];
/**
 * Drop rows saved by older releases that generated `@1m` variant models, so a
 * stale configuration cannot resurrect a variant the runtime no longer builds.
 */
declare function sanitizeCatalog(catalog: readonly TraeModelInfo[]): TraeModelInfo[];
/**
 * Derive the runtime catalog from the last refreshed Trae directory plus the
 * user's explicit selection and context budgets. An empty selection falls back
 * to the whole directory: a plugin that has never been configured must still
 * serve models rather than nothing. This is the single source of truth for
 * what DSH actually exposes, so saving only the selection and budgets is
 * enough to rebuild it after a restart.
 */
declare function deriveCatalog(catalog: readonly TraeModelInfo[], enabled: ReadonlySet<string>, budgets?: Readonly<Record<string, TraeContextBudget | undefined>>): TraeModelInfo[];
declare class TraeCatalog {
  private models;
  /**
   * @param region Seeds the static fallback for this region; each region's
   * provider must never serve the other region's roster before its first live
   * refresh lands.
   */
  constructor(region?: TraeRegion);
  current(): readonly TraeModelInfo[];
  set(models: readonly TraeModelInfo[]): void;
}
//#endregion
//#region src/adapter.d.ts
/** Provider route this bundle owns for the domestic (CN) gateway. */
declare const TRAE_PROVIDER = "trae";
/**
 * Provider route this bundle owns for the international (trae.ai) gateway.
 * Named `-global` to match the plugin family's convention (`workbuddy-global`);
 * the internal region bucket stays `ai`, which is the gateway/protocol name.
 */
declare const TRAE_AI_PROVIDER = "trae-global";
/** The provider id each region registers as. */
declare const TRAE_PROVIDERS: Readonly<Record<TraeRegion, string>>;
/** Human-readable provider names, shown in the DSH model picker. */
declare const TRAE_PROVIDER_DISPLAY_NAMES: Readonly<Record<TraeRegion, string>>;
/** Region a provider route id belongs to. */
declare function regionOfTraeProvider(provider: string): TraeRegion | undefined;
declare const TRAE_STREAM_IDLE_TIMEOUT_MS = 300000;
interface TraeAdapterOptions {
  /**
   * The loopback shim's bound base URL (for example `http://127.0.0.1:51234`),
   * WITHOUT the trailing `/v1`.
   *
   * This is a plain string, not the shim object, on purpose: the adapter used
   * to re-query `shim.baseUrl()` on every catalog read, which made construction
   * depend on the shim's *timing* — building a provider one tick before the
   * listener bound threw `trae shim is not listening` out of the activation
   * path. Taking the resolved URL makes that dependency explicit and
   * type-visible: callers must await `shim.whenListening(...)` first, and the
   * adapter can no longer reintroduce the race.
   */
  baseUrl: string;
  /**
   * The shim's per-process bearer secret (`shim.token()`). Like
   * {@link TraeAdapterOptions.baseUrl}, this is a resolved value rather than
   * the live shim, so the adapter holds no reachable handle back into the
   * plugin's startup sequence.
   */
  apiKey: string;
  catalog: TraeCatalog;
  /** Provider route id this instance serves; defaults to the CN route. */
  provider?: string;
  /** pi-ai provider name and profile display name; defaults to the CN name. */
  displayName?: string;
  resolveAttachments?: () => AttachmentStore | undefined;
}
interface TraeAdapter {
  adapter: PiAiAdapter;
  invalidate(): void;
}
declare function createTraeAdapter(options: TraeAdapterOptions): TraeAdapter;
//#endregion
//#region src/auth.d.ts
interface TraeCredential {
  accessToken: string;
  refreshToken?: string;
  userId: string;
  accountName?: string;
  host: string;
  /**
   * Region claim from the decrypted storage document (`userRegion.region`,
   * 'CN' | 'SG', possibly lowercase). Drives the routing bucket together with
   * `host`; see `regionOfCredential`.
   */
  userRegion?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  edition: TraeEdition;
  source: 'desktop' | 'dsh' | 'cli';
}
interface TraeRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  host?: string;
}
interface TraeCredentialStoreOptions {
  storagePath?: string;
  edition?: TraeEdition | 'auto';
  accountId?: string;
  ownPath?: string;
  /**
   * Region this store serves. When set, only credentials whose own claim maps
   * to this region are discovered, selected, or refreshed — the two regions'
   * stores run side by side without seeing each other's accounts.
   */
  region?: TraeRegion;
  /** Legacy single-copy path read as a migration source; injectable for tests. */
  legacyOwnPath?: string;
  refresh: (credential: TraeCredential) => Promise<TraeRefreshOutcome>;
  refreshMarginMs?: number;
}
interface TraeAccountChoice {
  id: string;
  accountName: string;
  edition: TraeEdition;
  /** Routing bucket of this account (`cn` | `ai`), derived from its credential. */
  region: TraeRegion;
  source: 'desktop' | 'dsh' | 'cli';
  tokenExpiresAtMs: number;
  selected: boolean;
}
/**
 * Why one candidate path did not yield an account. These are safe to surface:
 * they carry paths and error text, never token material.
 */
interface TraeCandidateFailure {
  path: string;
  edition: TraeEdition;
  source: TraeCredentialSource;
  reason: 'missing' | 'unreadable' | 'invalid';
  message?: string;
}
/**
 * Plugin-owned copy path for one region. Each region's store refreshes into
 * its own file so two simultaneously signed-in regions never overwrite each
 * other's refreshed token.
 */
declare function traeOwnAuthPath(region: TraeRegion): string;
/**
 * Pre-dual-provider single-copy path. Still read as a migration source (a
 * legacy credential serves the region it belongs to until that region's own
 * first refresh writes the per-region file), and removed by `logout`.
 */
declare function legacyTraeOwnAuthPath(): string;
declare function normalizeTraeCredential(raw: unknown, edition: TraeEdition, source: TraeCredential['source']): TraeCredential | undefined;
declare class TraeCredentialStore {
  private storagePathOverride;
  private edition;
  private accountId;
  private readonly region;
  private readonly ownPathExplicit;
  private readonly legacyOwnPath;
  private readonly legacyOwnPathExplicit;
  private readonly refresh;
  private readonly refreshMarginMs;
  private inflight;
  constructor(options: TraeCredentialStoreOptions);
  /** Whether a credential's own claim belongs to this store's region. */
  private matchesRegion;
  /**
   * The path this store refreshes into: the per-region file for a
   * region-scoped store, the legacy single file otherwise, or an explicitly
   * injected path in tests.
   */
  ownAuthPath(): string;
  /**
   * Every plugin-owned copy to read, most preferred first. A region-scoped
   * store reads the legacy single copy as its migration source (readAll's
   * region filter drops it when it carries the other region's credential); an
   * unscoped store reads everything so diagnostics see both regions.
   *
   * With an explicitly injected own path the legacy source is read ONLY when
   * it was injected too — a test that pins one file must not accidentally see
   * the real machine's legacy copy.
   */
  private ownCandidates;
  setSource(storagePath: string | undefined, edition?: TraeEdition | 'auto', accountId?: string): void;
  selectAccount(accountId: string | undefined): void;
  candidates(): TraeStorageCandidate[];
  /**
   * Deterministic default when no account is explicitly selected: the first
   * discovered account. This is NOT credit-seeking — it never reorders accounts
   * to find one with general credits. The plugin bills exactly the account the
   * user selected, or the first account when nothing has been selected yet.
   */
  private preferred;
  accounts(): Promise<TraeAccountChoice[]>;
  current(): Promise<TraeCredential | undefined>;
  resolve(): Promise<TraeCredential>;
  status(): Promise<{
    state: 'signed-in' | 'signed-out';
    edition?: TraeEdition;
    expiresAtMs?: number;
    source?: TraeCredential['source'];
  }>;
  desktopFilePresent(): Promise<boolean>;
  /**
   * Remove every plugin-owned copy this store could read (per-region file,
   * legacy single file, and their lock siblings); the desktop storage files
   * are untouched. A region store's logout therefore also clears the legacy
   * migration source — deliberate: `logout` is the user's "forget what the
   * plugin stored" action, not a per-account toggle.
   */
  logout(): Promise<void>;
  /**
   * Every local credential of this store's region, deduplicated by account id.
   * A region-scoped store sees only its own region's credentials: the other
   * region's accounts are invisible to selection, refresh, and status alike,
   * which is what keeps the two regions' providers from cross-billing.
   */
  private readAll;
  /**
   * Which paths were tried and why each one failed. Read-only and token-free:
   * it exists so a signed-out card can explain itself instead of showing a bare
   * "not signed in", which is undiagnosable on a machine whose layout differs
   * from the ones the plugin was written against.
   */
  diagnose(): Promise<{
    tried: TraeStorageCandidate[];
    failures: TraeCandidateFailure[];
  }>;
  /** Parse one candidate file's text into a credential, or throw. */
  private credentialFrom;
  private readDesktopAll;
  /**
   * Every readable plugin-owned copy, in candidate order; absent or corrupt
   * files are skipped rather than propagated.
   */
  private readOwns;
  private refreshNow;
}
//#endregion
//#region src/decrypt.d.ts
declare function decryptTraeStorageValue(encoded: string): string;
declare function parseTraeAuthValue(value: string): unknown;
declare function parseTraeStorageDocument(text: string): unknown;
//#endregion
//#region src/identity.d.ts
interface TraeIdentity {
  edition: TraeEdition;
  machineId: string;
  deviceId: string;
  appVersion?: string;
  buildVersion?: string;
  deviceBrand?: string;
  deviceCpu?: string;
  osVersion?: string;
  platform: NodeJS.Platform;
}
interface TraeIdentityReadOptions {
  /** Platform override for testing; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Home-directory override for testing; defaults to homedir(). */
  home?: string;
  /** Environment override for testing; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}
/** Read stable identity from Trae-owned files without generating impersonated IDs. */
declare function readTraeIdentity(candidate: TraeStorageCandidate, options?: TraeIdentityReadOptions): Promise<TraeIdentity>;
/**
 * Try candidates in order and return the first that yields a valid identity;
 * fail hard only when none do. Mirrors the credential store's skip-missing
 * semantics so a machine with only SOLO (no CN install) resolves correctly
 * instead of pinning the first candidate and throwing on a missing file.
 * When every candidate is absent from disk the error names all tried paths;
 * a candidate that exists but fails to parse still surfaces its own error.
 */
declare function pickTraeStorageIdentity(candidates: readonly TraeStorageCandidate[], options?: TraeIdentityReadOptions): Promise<TraeIdentity>;
/**
 * Deterministic identity for a machine that only has the Trae CLI (`traecli`).
 *
 * A CLI-only machine has no desktop `storage.json`, so the desktop identity
 * reader has nothing to read — yet the request headers still need stable
 * machine/device ids. Everything here comes from identifiers the CLI itself
 * persists (never a per-request random value):
 *
 *   - `argv.json`'s `crash-reporter-id` — a stable per-install UUID the CLI
 *     writes on first run; used directly as the device id.
 *   - `builtin/ide_version.json`'s `version` — the CLI build, sent as
 *     `x-app-version` (the desktop reader gets this from `product.json`).
 *   - a SHA-256 over the device id, host name and user name for `machineId`,
 *     matching the 64-char hex shape the official clients send.
 *
 * When `crash-reporter-id` is absent the device id falls back to the same
 * hash (still deterministic). A machine with no CLI home at all keeps failing
 * loudly — a fabricated identity is worse than a visible "not signed in".
 */
declare function readTraeCliIdentity(edition: TraeEdition, options?: TraeIdentityReadOptions): Promise<TraeIdentity>;
/**
 * Resolve the request identity for one region: the desktop storage identity
 * when any desktop install exists, otherwise the CLI home's deterministic
 * identity (see {@link readTraeCliIdentity}).
 *
 * This is the seam the WSL2 / CLI-only case needs: `traecli` writes its token
 * to `~/.trae-cn/trae-jwt-token` and no `storage.json` exists anywhere, so
 * desktop-only resolution used to fail every directory refresh and chat
 * request even though the account itself was found.
 */
declare function resolveTraeIdentity(candidates: readonly TraeStorageCandidate[], edition: TraeEdition, options?: TraeIdentityReadOptions): Promise<TraeIdentity>;
/** Headers derived from actual persisted identity, never a new random identity per request. */
declare function identityHeaders(identity: TraeIdentity): Record<string, string>;
//#endregion
//#region src/model-config.d.ts
interface TraeObservedModelConfig {
  configName: string;
  modelName: string;
  promptSet?: string;
  abVersion?: string;
  rawChatFunction?: string;
}
/**
 * Parse a secret-free CustomModel debug line emitted by Trae. Optional values
 * remain absent when Trae prints None; we must not invent defaults for them.
 */
declare function parseObservedModelConfig(line: string): TraeObservedModelConfig | undefined;
//#endregion
//#region src/model-cache.d.ts
interface TraeCachedModelConfig {
  name: string;
  customConfig?: Record<string, unknown>;
  promptMaxTokens?: number;
  maxTokens?: number;
  maxTurn?: number;
  multimodal?: boolean;
  modelType?: string;
}
/** Parse a safe subset of one cached model entry; credentials and endpoints are intentionally omitted. */
declare function parseTraeCachedModel(value: unknown): TraeCachedModelConfig | undefined;
interface TraeCachedModelReadOptions {
  /** Platform override for testing; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Home-directory override for testing; defaults to homedir(). */
  home?: string;
  /** Environment override for testing; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}
/**
 * Read Trae's own current user's model map via sqlite3 without exposing
 * secrets. The sqlite3 command line is a macOS prerequisite; on Windows it is
 * typically absent, so the call fails and callers fall back gracefully.
 */
declare function readTraeCachedModel(functionName: string, modelName: string, userId: string, options?: TraeCachedModelReadOptions): Promise<TraeCachedModelConfig | undefined>;
//#endregion
//#region src/model-extra-config.d.ts
interface TraeRawChatBehaviorConfig {
  passBackReasoning?: boolean;
  nativeFunctionCall?: boolean;
  useV2Process?: boolean;
  maxModeEnabled?: boolean;
  maxToolcallChars?: number;
  streamThrottleEnabled?: boolean;
}
/** Parse only Raw Chat behavior switches observed in Trae's model_extra_config. */
declare function parseTraeRawChatBehaviorConfig(value: unknown): TraeRawChatBehaviorConfig;
/** Extract the JSON object from one native model_extra_config parse log line. */
declare function parseTraeModelExtraConfigLogLine(line: string): TraeRawChatBehaviorConfig | undefined;
//#endregion
//#region src/model-detail.d.ts
declare const TRAE_MODEL_DETAIL_PATH = "/api/ide/v1/batch_get_detail_param";
declare const TRAE_MODEL_DETAIL_FUNCTIONS: readonly ["ui_builder_v2", "solo_coder", "chat_v3", "solo_builder", "builder_v3", "builder", "chat", "inline_chat", "git_ai", "custom_agent_generation", "utils", "code_reviewer", "code_review_summary", "solo_agent", "solo_agent_remote", "solo_work_remote", "solo_agent_lite", "solo_work_lite", "solo_design_lite", "solo_design_remote", "multimodal", "system_diagnosis"];
interface TraeModelDetailRequest {
  functions: string[];
  agent_type: '' | 'solo_agent';
  current_config_info: {
    config_name: string;
    is_custom_model: boolean;
  };
  mode_type: 0;
  access_type: 0;
  ab_force_vids: '';
  ab_autotest_advanced_mode: 0;
}
/** Build the exact request shape observed in successful current Trae CN logs. */
declare function buildTraeModelDetailRequest(configName?: string, custom?: boolean): TraeModelDetailRequest;
//#endregion
//#region src/protocol.d.ts
declare const TRAE_CN_AGENT_TASK_PATH = "/api/agent/v3/create_agent_task";
declare const TRAE_CN_TITLE_PATH = "/api/agent/v3/llm_utils_chat";
interface OpenAITextMessage {
  role: 'assistant' | 'system' | 'user';
  content: string;
}
interface TraeAgentTaskBody {
  messages: {
    role: OpenAITextMessage['role'];
    content: {
      type: 'text';
      text: string;
    }[];
  }[];
  model: string;
  function: string;
  stream: true;
  request_id: string;
  session_id: string;
  max_tokens?: number;
}
/**
 * Evidence-bounded body draft. It is intentionally pure and offline; the
 * network client remains disabled until a controlled request validates it.
 */
declare function buildTraeAgentTaskBody(messages: readonly OpenAITextMessage[], model: string, options?: {
  maxTokens?: number;
  requestId?: string;
  sessionId?: string;
}): TraeAgentTaskBody;
type TraeHeaderProfile = 'agent-task' | 'model-detail' | 'raw-chat' | 'native-curl';
/**
 * Numeric version code sent when the persisted build version is not a plain
 * integer. The upstream binds `x-app-version-code` / `x-ide-version-code` as a
 * number: Trae stores `iCubeLastVersion` as a dotted build string (observed
 * `2.3.76922` on TRAE SOLO CN 0.1.56), which the server rejects with
 * `4001 ... expr_path=app_version_code, cause=parameter type does not match
 * binding data`. Verified 2026-08-29: with a numeric code the same request
 * returns HTTP 200 + `text/event-stream` on
 * `/api/agent/v3/llm_utils_chat` (`solo_work_lite`).
 *
 * Only the *format* of this field is normalised. Machine, device and app
 * version stay exactly as persisted — nothing here impersonates a device.
 */
declare const TRAE_VERSION_CODE_FALLBACK = "20260716";
/** Keep a purely numeric build version; fall back when it cannot bind. */
declare function normalizeTraeVersionCode(buildVersion: string | undefined): string;
/**
 * Headers shared by every Trae edition. The same shape is accepted by both
 * gateways (verified read-only on the international gateway 2026-09-15,
 * docs/INTL_SG_EVIDENCE.md §2.3: identical `x-app-id`, identity headers, and
 * `Cloud-IDE-JWT` auth), so there is no per-edition branch any more.
 */
declare function buildTraeHeaders(credential: TraeCredential, identity: TraeIdentity, options?: {
  appId?: string;
  requestId?: string;
  profile?: TraeHeaderProfile;
}): Record<string, string>;
/** Backwards-compatible alias; the headers are no longer CN-specific. */
declare const buildTraeCnHeaders: typeof buildTraeHeaders;
declare function traeEndpoint(baseUrl: string, path: string): string;
//#endregion
//#region src/raw-chat.d.ts
declare const TRAE_RAW_CHAT_V2_PATH = "/api/ide/v2/llm_raw_chat";
declare const TRAE_RAW_CHAT_V1_PATH = "/api/ide/v1/llm_raw_chat";
type RawChatRole = 'assistant' | 'system' | 'tool' | 'user';
interface RawChatTextContent {
  type: 'text';
  text: string;
}
interface RawChatImageContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
}
type RawChatContent = RawChatTextContent | RawChatImageContent;
interface RawChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
interface RawChatMessage {
  role: RawChatRole;
  content: string | RawChatContent[];
  tool_call_id?: string;
  tool_calls?: RawChatToolCall[];
}
interface RawChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}
interface TraeRawChatDraft {
  model: string;
  messages: RawChatMessage[];
  stream: true;
  tools?: RawChatTool[];
  max_tokens?: number;
  temperature?: number;
  reasoning_effort?: string;
  extra_info?: Record<string, unknown>;
}
/**
 * Evidence-bounded OpenAI-like draft inferred from Trae's LLMRaw* DTO symbols.
 * Pure/offline only: the upstream remains disabled until one controlled probe.
 */
declare function buildTraeRawChatDraft(input: {
  model: string;
  messages: readonly RawChatMessage[];
  tools?: readonly RawChatTool[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  extraInfo?: Record<string, unknown>;
}): TraeRawChatDraft;
type RawChatDelta = {
  type: 'text';
  text: string;
} | {
  type: 'reasoning';
  text: string;
} | {
  type: 'tool-call';
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
} | {
  type: 'usage';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | {
  type: 'done';
  finishReason: string;
} | {
  type: 'unknown';
  value: unknown;
};
/** Decode OpenAI-like raw-chat chunks while preserving unknown structures. */
declare function decodeRawChatChunk(value: unknown): RawChatDelta[];
//#endregion
//#region src/raw-envelope.d.ts
interface TraeFusionRawChatEnvelope {
  arg: TraeRawChatDraft;
  args_hash: string;
  config_json: string;
}
/** Stable JSON hash candidate used by the native DTO's arg/args_hash fields. */
declare function hashTraeRawChatArg(arg: TraeRawChatDraft): string;
/**
 * Evidence-bounded fusion envelope candidate. The native DTO exposes exactly
 * arg/args_hash/config_json, but the hash algorithm and config_json contents
 * remain candidates until a live response validates them.
 */
declare function buildTraeFusionRawChatEnvelope(arg: TraeRawChatDraft, config: Record<string, unknown>): TraeFusionRawChatEnvelope;
//#endregion
//#region src/raw-runtime-config.d.ts
interface TraeRawChatRuntimeConfig {
  configName: string;
  modelName: string;
  promptMaxTokens?: number;
  maxTokens?: number;
  maxTurn?: number;
  multimodal?: boolean;
  nativeFunctionCall?: boolean;
  passBackReasoning?: boolean;
  useV2Process?: boolean;
  maxModeEnabled?: boolean;
  maxToolcallChars?: number;
  streamThrottleEnabled?: boolean;
  customConfig?: Record<string, unknown>;
}
/** Merge safe current-cache facts with observed behavior flags; no network credentials enter this object. */
declare function traeRawChatExtraInfo(config: TraeRawChatRuntimeConfig): Record<string, unknown>;
declare function buildTraeRawChatRuntimeConfig(modelName: string, cached: TraeCachedModelConfig | undefined, behavior?: TraeRawChatBehaviorConfig): TraeRawChatRuntimeConfig;
//#endregion
//#region src/raw-resolver.d.ts
interface TraeRawResolverResult {
  identity: TraeIdentity;
  runtime: TraeRawChatRuntimeConfig;
}
/** Resolve current desktop identity and safe cached model config for capability probing. */
declare function resolveTraeRawRuntime(store: TraeCredentialStore, modelName: string): Promise<TraeRawResolverResult>;
//#endregion
//#region src/raw-fingerprint.d.ts
/** Stable non-secret fingerprint for capability-cache invalidation. */
declare function rawCapabilityFingerprint(input: {
  endpoint: string;
  edition: string;
  identity: Pick<TraeIdentity, 'appVersion' | 'buildVersion'>;
  runtime: TraeRawChatRuntimeConfig;
}): string;
//#endregion
//#region src/upstream.d.ts
type TraeUpstreamErrorKind = 'authentication' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client' | 'unconfigured';
type TraeChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: TraeUpstreamErrorKind;
  message: string;
};
interface TraeUpstreamClient {
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>;
}
/**
 * Safe first-stage upstream. Real Trae traffic stays disabled until one
 * edition-specific endpoint and wire codec are verified with fixtures.
 */
declare class UnconfiguredTraeUpstreamClient implements TraeUpstreamClient {
  chatStream(_bodyJson: string, _signal?: AbortSignal): Promise<TraeChatResult>;
}
//#endregion
//#region src/raw-capability.d.ts
type TraeRawChatCapability = {
  available: true;
  contentType: string | null;
} | {
  available: false;
  reason: 'authentication' | 'credit' | 'rate' | 'protocol' | 'transport' | 'server';
  status: number;
};
/** One short non-tool request decides whether Raw Chat may become primary. */
declare function probeTraeRawChatCapability(client: TraeUpstreamClient, signal?: AbortSignal): Promise<TraeRawChatCapability>;
//#endregion
//#region src/raw-diagnostic.d.ts
type TraeRawDiagnosticState = 'disabled' | 'unchecked' | 'available' | 'protocol-gated' | 'authentication' | 'credit' | 'rate' | 'transport' | 'server';
interface TraeRawDiagnostic {
  state: TraeRawDiagnosticState;
  checkedAtMs?: number;
  status?: number;
}
/** Project capability facts to a redacted, user-safe status. */
declare function rawCapabilityDiagnostic(enabled: boolean, capability?: TraeRawChatCapability, checkedAtMs?: number): TraeRawDiagnostic;
//#endregion
//#region src/raw-gateway.d.ts
interface TraeRawGatewayOptions {
  raw: TraeUpstreamClient;
  solo: TraeUpstreamClient;
  endpoint: string;
  edition: string;
  identity: Pick<TraeIdentity, 'appVersion' | 'buildVersion'>;
  runtime: TraeRawChatRuntimeConfig;
  enabled?: boolean;
}
interface TraeRawGateway {
  upstream: TraeUpstreamClient;
  probe(signal?: AbortSignal): ReturnType<typeof probeTraeRawChatCapability>;
  diagnostic(): TraeRawDiagnostic;
  invalidate(): void;
}
/** Assemble the opt-in capability state and safe Raw→SOLO routing. */
declare function createTraeRawGateway(options: TraeRawGatewayOptions): TraeRawGateway;
//#endregion
//#region src/raw-upstream.d.ts
interface TraeRawChatConfig {
  model: string;
  configName: string;
  promptSet?: string;
  abVersion?: string;
  passBackReasoning: boolean;
  extraInfo?: Record<string, unknown>;
  runtime?: TraeRawChatRuntimeConfig;
}
interface TraeRawChatClientOptions {
  credential: () => Promise<TraeCredential>;
  identity: () => Promise<TraeIdentity>;
  config: TraeRawChatConfig;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}
type TraeRawChatFailureReason = 'empty' | 'json' | 'schema' | 'permission' | 'model' | 'generic-http' | 'other';
declare function classifyTraeRawChatFailure(message: string): TraeRawChatFailureReason;
/**
 * Evidence-gated Raw Chat client. It is fully testable through injected fetch,
 * but production callers must not construct it without verified config values.
 */
declare class TraeRawChatUpstreamClient {
  private readonly options;
  private readonly fetchImpl;
  constructor(options: TraeRawChatClientOptions);
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>;
}
//#endregion
//#region src/raw-capability-state.d.ts
interface TraeRawCapabilitySnapshot {
  capability?: TraeRawChatCapability;
  checkedAtMs?: number;
  fingerprint?: string;
}
/** In-memory capability state; success/failure expires and config changes invalidate it. */
declare class TraeRawCapabilityState {
  private readonly ttlMs;
  private snapshot;
  constructor(ttlMs?: number);
  current(fingerprint: string, now?: number): TraeRawChatCapability | undefined;
  record(fingerprint: string, capability: TraeRawChatCapability, now?: number): void;
  inspect(): Readonly<TraeRawCapabilitySnapshot>;
  invalidate(): void;
}
//#endregion
//#region src/raw-capability-controller.d.ts
interface TraeRawCapabilityControllerOptions {
  client: TraeUpstreamClient;
  state?: TraeRawCapabilityState;
  enabled?: boolean;
}
/** Explicitly-triggered, single-flight Raw Chat capability checks. */
declare class TraeRawCapabilityController {
  private readonly options;
  private readonly state;
  private enabled;
  private inflight;
  constructor(options: TraeRawCapabilityControllerOptions);
  current(fingerprint: string): TraeRawChatCapability | undefined;
  setEnabled(enabled: boolean): void;
  inspect(): Readonly<TraeRawCapabilitySnapshot>;
  isEnabled(): boolean;
  invalidate(): void;
  probe(fingerprint: string, signal?: AbortSignal): Promise<TraeRawChatCapability>;
}
//#endregion
//#region src/fallback-upstream.d.ts
interface TraeFallbackUpstreamOptions {
  primary: TraeUpstreamClient;
  fallback: TraeUpstreamClient;
  onFallback?: (result: Extract<TraeChatResult, {
    ok: false;
  }>) => void;
}
/**
 * Optional primary route first, native SOLO tool-call route second. Fallback is intentionally narrow:
 * only definitive pre-stream schema/route incompatibilities may retry the same
 * user request. Authentication, credit, rate, cancellation, transport/server
 * failures, and every successful Response are never replayed.
 */
declare class TraeFallbackUpstreamClient implements TraeUpstreamClient {
  private readonly options;
  constructor(options: TraeFallbackUpstreamOptions);
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>;
  private canFallback;
}
//#endregion
//#region src/gated-upstream.d.ts
interface TraeGatedUpstreamOptions {
  raw: TraeUpstreamClient;
  solo: TraeUpstreamClient;
  capability(): TraeRawChatCapability | undefined;
  onFallback?: (failure: Extract<TraeChatResult, {
    ok: false;
  }>) => void;
}
/** Select Raw Chat only after a successful capability probe; SOLO is the safe default. */
declare class TraeGatedUpstreamClient implements TraeUpstreamClient {
  private readonly options;
  constructor(options: TraeGatedUpstreamOptions);
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>;
}
//#endregion
//#region src/refresh.d.ts
/** Stable device identity for the DeviceInfo body, sourced from the app's own storage. */
interface TraeRefreshDevice {
  deviceId: string;
  machineId: string;
}
/**
 * Exchange a refresh token for a fresh access token, following the calling
 * edition's verified contract. `device` is only used by editions whose
 * official client sends a DeviceInfo body; when it cannot be resolved the
 * field is omitted rather than sent empty.
 */
declare function refreshTraeCredential(credential: TraeCredential, signal?: AbortSignal, device?: TraeRefreshDevice): Promise<TraeRefreshOutcome>;
//#endregion
//#region src/sse.d.ts
interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}
/** Incremental SSE decoder supporting CRLF, chunk splits and multi-line data. */
declare class SseDecoder {
  private buffer;
  private event;
  private id;
  private retry;
  private data;
  push(chunk: string): SseEvent[];
  finish(): SseEvent[];
  private consumeLine;
  private dispatch;
}
type TraeStreamEvent = {
  type: 'queue';
  position?: number;
} | {
  type: 'progress';
  notice: unknown;
} | {
  type: 'delta';
  text: string;
  reasoning?: string;
  toolCalls?: unknown;
} | {
  type: 'usage';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
} | {
  type: 'done';
  finishReason: string;
} | {
  type: 'unknown';
  event?: string;
  data: unknown;
};
declare function decodeTraeEvent(event: SseEvent): TraeStreamEvent;
//#endregion
//#region src/solo.d.ts
declare const TRAE_SOLO_FUNCTION = "solo_work_lite";
declare const TRAE_SOLO_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
declare const TRAE_SOLO_MODELS_PATH = "/api/ide/v1/get_detail_param";
declare function prepareSoloBody(source: string, defaultModel?: string, functionName?: string): string;
interface TraeSoloModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: TraeReasoningCapability;
  /** The directory function that listed this config (replayed when calling it). */
  function?: string;
}
interface TraeSoloClientOptions {
  credential(): Promise<TraeCredential>;
  identity(): Promise<TraeIdentity>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string, detail?: unknown) => void;
}
declare class TraeSoloUpstreamClient {
  private readonly options;
  private readonly fetchImpl;
  constructor(options: TraeSoloClientOptions);
  /**
   * Read the callable roster for this credential's region.
   *
   * Every function in {@link TRAE_DIRECTORY_FUNCTIONS} is asked, in order, and
   * their answers are unioned: the first function to list a `config_name` owns
   * it. Trae splits its roster across SOLO modes, and a model is only callable
   * through the function that lists it (glm-5.3 exists solely under
   * `solo_work_remote` on the CN gateway). Asking one function therefore
   * silently hides models that the other one serves. The remote directory
   * remains the merge skeleton, so agent-internal entries (search_agent_*,
   * paygo variants) never surface even though they appear here.
   */
  fetchModels(signal?: AbortSignal): Promise<TraeSoloModel[]>;
  /** Merge one function's config list into the shared catalogue (first wins). */
  private collectModels;
  chatStream(bodyJson: string, signal?: AbortSignal, functionName?: string): Promise<TraeChatResult>;
}
//#endregion
//#region src/solo-bridge.d.ts
/** Convert Trae's named SSE events into OpenAI chat-completion SSE chunks. */
declare function bridgeTraeSoloStream(response: Response, model: string): Response;
/**
 * One resolved wire target: the `config_name` `llm_utils_chat` accepts, plus
 * the directory function that listed it. Trae's roster is split across several
 * SOLO-mode functions and a model is only callable through the one listing it
 * (glm-5.3 answers only under `solo_work_remote`), so the chat call replays it.
 */
interface TraeWireTarget {
  configName: string;
  function?: string;
}
/** Resolves a display model id to its wire target (config_name + function). */
type TraeWireResolver = (displayId: string) => TraeWireTarget | undefined;
/** Native SOLO client wrapper used by the loopback OpenAI adapter. */
declare class TraeSoloBridge implements TraeUpstreamClient {
  private readonly upstream;
  private readonly catalog?;
  private readonly wireResolver?;
  constructor(upstream: TraeUpstreamClient, catalog?: Pick<TraeCatalog, "current"> | undefined, wireResolver?: TraeWireResolver | undefined);
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>;
}
//#endregion
//#region src/solo-remote.d.ts
declare const TRAE_SOLO_REMOTE_BASE = "https://solo.trae.cn/api/remote/v1";
interface TraeSoloRemoteCatalogOptions {
  credential(): Promise<TraeCredential>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}
/**
 * Read-only model catalog client for the SOLO Web API.
 *
 * This deliberately has no chat/session method: the Remote session protocol
 * only exposes a final answer and cannot preserve DSH's structured tool loop.
 */
declare class TraeSoloRemoteCatalogClient {
  private readonly options;
  private readonly fetchImpl;
  private readonly baseUrl;
  constructor(options: TraeSoloRemoteCatalogOptions);
  private headers;
  fetchModels(signal?: AbortSignal): Promise<TraeDiscoveredModel[]>;
}
//#endregion
//#region src/delegating-upstream.d.ts
/** Stable shim dependency whose delegate can be replaced after async setup. */
declare class TraeDelegatingUpstreamClient implements TraeUpstreamClient {
  private delegate;
  constructor(delegate: TraeUpstreamClient);
  replace(delegate: TraeUpstreamClient): void;
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>;
}
//#endregion
//#region src/usage.d.ts
/**
 * Read-only Trae usage/credits client.
 *
 * CN sources the verified `api.trae.cn` pay/ug endpoints (see
 * `docs/USAGE_API_RESEARCH.md`); the international (ai) region is
 * subscription-based and reads `ide_user_pay_status` on its own gateway
 * (verified 2026-09-15, docs/INTL_SG_EVIDENCE.md §4). All queries are
 * read-only and do not consume Trae credits. The per-session consumption
 * detail table is deliberately not included: the endpoint returns no rows
 * for the current account, so we only expose what is actually retrievable.
 */
declare const TRAE_PAY_BASE = "https://api.trae.cn";
interface TraeUsageOptions {
  credential(): Promise<TraeCredential | undefined>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}
/**
 * Subscription/pay status of an international (ai) account, parsed from the
 * `ide_user_pay_status` answer. The international region has no Work-credit
 * packs, so this — not `snapshot` — is its usage surface.
 */
interface TraePayStatus {
  isDollarUsageBilling: boolean;
  hasPackage: boolean;
  isPayFreshman: boolean;
  inTrial: boolean;
  trialEndTimeMs: number;
  enableSoloLite: boolean;
  enableSoloBuilder: boolean;
  enableSoloCoder: boolean;
  enableSoloWeb: boolean;
  /** The fission (referral) program window and cap, when exposed. */
  fission?: {
    startTimeMs: number;
    expireTimeMs: number;
    maxUsage: number;
  };
}
interface TraeUsageSummary {
  totalAmount: number;
  consumedAmount: number;
  consumptionRatio: number;
}
interface TraeUsagePack {
  displayDesc: string;
  entitlementId: string;
  endTimeMs: number;
  currency: number;
  /** 0 = non-Work/general endpoint, 1 = Work endpoint. */
  availableEndpoint?: number;
  creditsLimit?: number;
  /** Credits consumed from this pack (`usage.credits_amount`). */
  consumedCredits?: number;
}
interface TraeUsageSnapshot {
  isCreditsBilling: boolean;
  isDollarUsageBilling: boolean;
  isPayFreshman: boolean;
  inTrial: boolean;
  trialEndTimeMs: number;
  summary: TraeUsageSummary;
  packs: TraeUsagePack[];
}
interface TraeCheckinStatus {
  checkedIn: boolean;
  credits: number;
  enabled: boolean;
}
interface TraeActivityRule {
  activityId: string;
  enabled: boolean;
  activityType: number;
  startTimeMs: number;
  endTimeMs: number;
  workExtra?: Record<string, unknown>;
}
interface TraeUsageView {
  snapshot: TraeUsageSnapshot;
  checkin: TraeCheckinStatus;
  activities: TraeActivityRule[];
}
/**
 * A read-only client for the verified Trae usage/credits endpoints.
 * All methods are safe to call from a plugin and never mutate account state.
 */
declare class TraeUsageClient {
  private readonly options;
  private readonly fetchImpl;
  private readonly baseUrl;
  private readonly timeoutMs;
  constructor(options: TraeUsageOptions);
  /** Region of the current credential; `cn` when unresolvable. */
  private currentRegion;
  /**
   * Pay base for the current credential's region. An explicit baseUrl (tests,
   * diagnostics) pins the endpoint; otherwise CN uses `api.trae.cn` and the
   * international region its own verified pay gateway.
   */
  private payBase;
  private authedHeaders;
  private post;
  /**
   * Subscription/pay status of an international (ai) account. The CN region
   * never calls this (its contract is unverified there); the ai region uses
   * this instead of the Work-credit `snapshot`.
   */
  payStatus(signal?: AbortSignal): Promise<TraePayStatus>;
  /**
   * The Work-credit endpoints are CN-only. The international region is
   * subscription-based and must read {@link payStatus} instead; guarding here
   * keeps the card's degraded `creditsError` message diagnosable rather than
   * letting an ai credential hit an unverified path on its pay gateway.
   */
  private requireCnRegion;
  /** Total entitlements / credits and per-pack breakdown. */
  snapshot(signal?: AbortSignal): Promise<TraeUsageSnapshot>;
  /** Daily check-in status. */
  checkinStatus(signal?: AbortSignal): Promise<TraeCheckinStatus>;
  /** Rewards / activity rules. */
  activities(signal?: AbortSignal): Promise<TraeActivityRule[]>;
  /** Convenience: snapshot + check-in + activities in one call (best-effort, non-fatal on missing). */
  view(signal?: AbortSignal): Promise<TraeUsageView>;
}
//#endregion
//#region src/status-paths.d.ts
/** Plugin-owned usage endpoint consumed by its browser half. */
declare const TRAE_USAGE_PATH = "/plugins/dsh-connect-trae/usage";
/** Query parameter naming the region a card request addresses. */
declare const TRAE_REGION_PARAM = "region";
/** Every region, in card tab order. */
declare const TRAE_REGIONS: readonly TraeRegion[];
/**
 * Address one region's status route. The two regions are separate provider
 * stacks; every card request carries the region whose tab the user is on.
 */
declare function withTraeRegion(path: string, region: TraeRegion): string;
/**
 * Read the region parameter off a status-route URL. Absent means the domestic
 * tab (`cn`); a present-but-unknown value returns undefined so the route can
 * answer 400 instead of guessing.
 */
declare function regionOfTraeStatusUrl(url: string): TraeRegion | undefined;
/** One credit pack and its remaining credit. */
interface TraeWebCreditAccount {
  displayDesc: string;
  remain: number;
  size: number;
}
/** Aggregated usage/credit answer rendered by the plugin card. */
interface TraeWebCredits {
  total: number;
  consumed: number;
  available: number;
  workAvailable: number;
  generalAvailable: number;
  accounts: readonly TraeWebCreditAccount[];
}
/** Editable Trae model row rendered by the plugin-owned settings card. */
interface TraeWebModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ('text' | 'image')[];
  creditMultiplier?: number;
  reasoningSupported?: boolean;
  reasoning?: {
    supported: string[];
    defaultEffort?: string;
  };
  maxContextWindow?: number;
}
/** Daily check-in status rendered by the card. */
interface TraeWebCheckin {
  checkedIn: boolean;
  credits: number;
}
/** One reward activity rule (name + work/general credits when present). */
interface TraeWebActivity {
  activityId: string;
  enabled: boolean;
  workCredits?: number;
  generalCredits?: number;
}
interface TraeWebAccount {
  id: string;
  accountName: string;
  edition: 'cn' | 'sg' | 'solo' | 'solo-sg';
  /** Routing bucket of this account, derived from its credential. */
  region: TraeRegion;
  source: 'desktop' | 'dsh' | 'cli';
  tokenExpiresAtMs: number;
  selected: boolean;
}
/** One probed candidate path and why it did not yield an account. */
interface TraeWebSearchPath {
  path: string;
  edition: 'cn' | 'sg' | 'solo' | 'solo-sg';
  source: 'desktop' | 'cli';
  reason: 'missing' | 'unreadable' | 'invalid';
  message?: string;
}
/** Subscription status of an international (ai) account, rendered instead of the CN credit packs. */
interface TraeWebPayStatus {
  isDollarUsageBilling: boolean;
  hasPackage: boolean;
  isPayFreshman: boolean;
  inTrial: boolean;
  trialEndTimeMs: number;
  enableSoloLite: boolean;
  enableSoloBuilder: boolean;
  enableSoloCoder: boolean;
  enableSoloWeb: boolean;
  fission?: {
    startTimeMs: number;
    expireTimeMs: number;
    maxUsage: number;
  };
}
/** The JSON document the plugin card renders. */
type TraeWebUsage = {
  status: 'signed-out';
  accounts: readonly TraeWebAccount[];
  message?: string;
  searched?: readonly TraeWebSearchPath[];
} | {
  status: 'signed-in';
  accountId: string;
  accountName: string;
  tokenExpiresAtMs: number;
  /** Which per-region model directory and selection this account owns. */
  region: TraeRegion;
  accounts: readonly TraeWebAccount[];
  models: readonly TraeWebModel[];
  enabledModelIds: readonly string[];
  rawChat?: {
    state: 'disabled' | 'unchecked' | 'available' | 'protocol-gated' | 'authentication' | 'credit' | 'rate' | 'transport' | 'server';
    checkedAtMs?: number;
    status?: number;
  };
  credits?: TraeWebCredits;
  creditsError?: string;
  /** Subscription status of an international account (region ai only). */
  payStatus?: TraeWebPayStatus;
  payStatusError?: string;
} | {
  status: 'error';
  message: string;
};
//#endregion
//#region src/web-status.d.ts
/**
 * Constructor dependencies. Everything region-specific is addressed by the
 * region the request names: the two regions are separate provider stacks, so
 * the card must be served the directory, selection, and credits of the tab the
 * user is on.
 */
interface TraeUsageRouteOptions {
  /** The region-scoped credential store backing each region's requests. */
  store(region: TraeRegion): TraeCredentialStore;
  /** The region-scoped usage client (CN work credits / international pay status). */
  client(region: TraeRegion): TraeUsageClient;
  /** The requested region's last-refreshed raw directory (one entry per upstream model). */
  displayModels(region: TraeRegion): readonly TraeModelInfo[];
  /** The user's model selection in the requested region, stored as model id (= Trae name). */
  enabledModelIds(region: TraeRegion): readonly string[];
  /** Re-read one region's live directory from the upstream. */
  discoverModels?(region: TraeRegion, signal?: AbortSignal): Promise<readonly TraeModelInfo[]>;
  /** Raw-Chat capability state of the requested region. */
  rawDiagnostic?(region: TraeRegion): TraeRawDiagnostic;
}
/**
 * Assemble one region's card document. `region` is the tab the card is on; the
 * region-scoped store already answers with only that region's accounts, so the
 * document's model slots and account list are that region's by construction.
 * Sign-in state is read-only; credit is a live billing answer whose failure
 * degrades to `creditsError` rather than failing the whole document.
 */
declare function traeWebUsage(deps: TraeUsageRouteOptions, region: TraeRegion): Promise<TraeWebUsage>;
/** Mount the GET usage route on an optional webServer context. */
declare function registerTraeUsageRoute(ctx: Context, deps: TraeUsageRouteOptions): void;
//#endregion
//#region src/shim.d.ts
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
interface TraeShim {
  /**
   * Settles when the loopback listener is bound, or rejects when the bind
   * itself failed. Never rejects on its own otherwise.
   */
  ready: Promise<void>;
  /**
   * True once the listener is bound and the port can no longer change. Read it
   * for a non-throwing readiness check; {@link TraeShim.baseUrl} remains the
   * throwing accessor.
   */
  readonly listening: boolean;
  /**
   * Wait for the listener, bounded by `timeoutMs`. Resolves `true` when the
   * shim is bound, `false` when the bind failed or the deadline passed — it
   * never throws, so a caller can treat "no port yet" as an ordinary
   * degradation instead of an exception on the startup path.
   */
  whenListening(timeoutMs: number): Promise<boolean>;
  /**
   * Why the bind failed, once {@link TraeShim.whenListening} has answered
   * `false`. `undefined` while the bind is still in flight or after it
   * succeeded — a caller reporting a degradation can name the real cause
   * instead of guessing.
   */
  reason(): unknown;
  baseUrl(): string;
  token(): string;
  close(): Promise<void>;
}
interface TraeShimOptions {
  catalog: TraeCatalog;
  client: TraeUpstreamClient;
  logger?: ShimLogger;
  /**
   * Loopback interface to bind. Defaults to `127.0.0.1`; a test that needs to
   * observe a *failed* bind can name an address the environment does not
   * provide (for example an unroutable one).
   */
  bindHost?: string;
  /**
   * Loopback port to bind. Defaults to `0` (an ephemeral port), which is what
   * every production caller wants. A test that needs a deterministic bind
   * failure passes a port it already holds — that is the only supported use.
   */
  port?: number;
}
declare function createTraeShim(options: TraeShimOptions): TraeShim;
//#endregion
//#region src/index.d.ts
declare const name = "dsh-connect-trae";
declare const inject: string[];
/**
 * Settings namespace, as a plain lowercase literal. DSH 0.1.2 removed the
 * `settingsNamespace` brand constructor from the npm package (the Desktop
 * host still ships it as a legacy shim), and every consumer of this constant —
 * `registerModelDiscovery`, `registerConfigurableProviders`,
 * `settings.installSection`, the settings test — takes it as a kebab string,
 * so no branding is needed for either host generation.
 */
declare const TRAE_SETTINGS_NS = "trae";
/** One region's saved model state: its own directory and the user's selection within it. */
interface TraeRegionState {
  /** The last-refreshed raw directory for this region; what the card displays. */
  lastCatalog?: TraeModelInfo[];
  /** The user's selection in this region, as model ids (= Trae name). */
  enabledModelIds?: string[];
  /** Models the user explicitly enabled for image input in this region. */
  imageModelIds?: string[];
  /** Local DSH context budget per model in this region. */
  contextBudgets?: Record<string, number>;
}
interface Config {
  authFile?: string;
  edition?: 'auto' | 'cn' | 'sg' | 'solo' | 'solo-sg';
  /**
   * @deprecated Legacy single-slot account selector from before the dual
   * provider split. It is attributed to whichever region the account actually
   * belongs to (resolved once at startup from the local account scan); new
   * writes go to {@link Config.accounts}.
   */
  accountId?: string;
  /**
   * Per-region account selections, keyed `cn` | `ai`. Each region's tab writes
   * its own slot; tokens remain outside settings.
   */
  accounts?: Partial<Record<TraeRegion, string>>;
  /**
   * Per-region model state, keyed `cn` | `ai`. The CN and international apps
   * expose different rosters, so each keeps its own directory and selection
   * and switching accounts never drops the other region's picks.
   */
  regions?: Partial<Record<TraeRegion, TraeRegionState>>;
  /**
   * @deprecated Legacy single-slot fields from before the region split. They
   * predate international support and are read as the CN region's state when
   * `regions.cn` is absent; new writes go to `regions`.
   */
  lastCatalog?: TraeModelInfo[];
  /** @deprecated See {@link Config.lastCatalog}. */
  enabledModelIds?: string[];
  /** @deprecated See {@link Config.lastCatalog}. */
  contextBudgets?: Record<string, number>;
  /** @deprecated See {@link Config.lastCatalog}. */
  imageModelIds?: string[];
  /** @deprecated Legacy generated runtime catalog; kept for backwards compatibility. */
  models?: TraeModelInfo[];
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
declare function regionStateOf(config: Config, region: TraeRegion): TraeRegionState;
declare const Config: z<Config>;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, FALLBACK_TRAE_MODELS, FALLBACK_TRAE_MODELS_AI, REGION_GATEWAYS, type RawChatDelta, type RawChatMessage, type RawChatTool, SseDecoder, type SseEvent, TRAE_AI_PROVIDER, TRAE_CN_AGENT_TASK_PATH, TRAE_CN_TITLE_PATH, TRAE_MODEL_DETAIL_FUNCTIONS, TRAE_MODEL_DETAIL_PATH, TRAE_PAY_BASE, TRAE_PROVIDER, TRAE_PROVIDERS, TRAE_PROVIDER_DISPLAY_NAMES, TRAE_RAW_CHAT_V1_PATH, TRAE_RAW_CHAT_V2_PATH, TRAE_REASONING_EFFORTS, TRAE_REGIONS, TRAE_REGION_PARAM, TRAE_SETTINGS_NS, TRAE_SOLO_CHAT_PATH, TRAE_SOLO_FUNCTION, TRAE_SOLO_MODELS_PATH, TRAE_SOLO_REMOTE_BASE, TRAE_STREAM_IDLE_TIMEOUT_MS, TRAE_USAGE_PATH, TRAE_VERSION_CODE_FALLBACK, type TraeActivityRule, type TraeAdapter, type TraeCachedModelConfig, TraeCatalog, type TraeChatResult, type TraeCheckinStatus, type TraeContextBudget, type TraeCredential, TraeCredentialStore, TraeDelegatingUpstreamClient, type TraeDiscoveredModel, type TraeDiscoveredReasoning, type TraeEdition, TraeFallbackUpstreamClient, type TraeFallbackUpstreamOptions, type TraeFusionRawChatEnvelope, TraeGatedUpstreamClient, type TraeGatedUpstreamOptions, type TraeIdentity, type TraeInputModality, type TraeModelDetailRequest, type TraeModelInfo, type TraeObservedModelConfig, TraeRawCapabilityController, type TraeRawCapabilityControllerOptions, type TraeRawCapabilitySnapshot, TraeRawCapabilityState, type TraeRawChatBehaviorConfig, type TraeRawChatCapability, type TraeRawChatClientOptions, type TraeRawChatConfig, type TraeRawChatFailureReason, type TraeRawChatRuntimeConfig, TraeRawChatUpstreamClient, type TraeRawDiagnostic, type TraeRawDiagnosticState, type TraeRawGateway, type TraeRawGatewayOptions, type TraeRawResolverResult, type TraeReasoningCapability, type TraeReasoningEffort, type TraeRefreshDevice, type TraeRegion, type TraeRegionGateways, TraeRegionState, type TraeShim, TraeSoloBridge, type TraeSoloClientOptions, TraeSoloRemoteCatalogClient, type TraeSoloRemoteCatalogOptions, TraeSoloUpstreamClient, type TraeStorageCandidate, type TraeStreamEvent, type TraeUpstreamClient, TraeUsageClient, type TraeUsageOptions, type TraeUsagePack, type TraeUsageRouteOptions, type TraeUsageSnapshot, type TraeUsageSummary, type TraeUsageView, type TraeWebActivity, type TraeWebCheckin, type TraeWebCredits, type TraeWebUsage, type TraeWireModel, UnconfiguredTraeUpstreamClient, apply, applyContextBudgets, applyImageSelection, applyReasoningEffort, bridgeTraeSoloStream, buildTraeAgentTaskBody, buildTraeCnHeaders, buildTraeFusionRawChatEnvelope, buildTraeModelDetailRequest, buildTraeRawChatDraft, buildTraeRawChatRuntimeConfig, classifyTraeRawChatFailure, createTraeAdapter, createTraeRawGateway, createTraeShim, decodeRawChatChunk, decodeTraeEvent, decryptTraeStorageValue, deriveCatalog, discoveredCatalog, fallbackModelsFor, hashTraeRawChatArg, identityHeaders, inject, legacyTraeOwnAuthPath, mergeTraeModelSources, name, normalizeTraeCredential, normalizeTraeVersionCode, parseObservedModelConfig, parseReasoningCapability, parseTraeAuthValue, parseTraeCachedModel, parseTraeModelExtraConfigLogLine, parseTraeRawChatBehaviorConfig, parseTraeRemoteModel, parseTraeStorageDocument, pickTraeStorageIdentity, prepareSoloBody, probeTraeRawChatCapability, rawCapabilityDiagnostic, rawCapabilityFingerprint, readTraeCachedModel, readTraeCliIdentity, readTraeIdentity, refreshTraeCredential, regionOfCredential, regionOfEdition, regionOfHost, regionOfTraeProvider, regionOfTraeStatusUrl, regionOfUserRegion, regionStateOf, registerTraeUsageRoute, resolveTraeIdentity, resolveTraeRawRuntime, sanitizeCatalog, traeEndpoint, traeInputModalities, traeModelDisplayName, traeOwnAuthPath, traeRawChatExtraInfo, traeStorageCandidates, traeWebUsage, withTraeRegion };