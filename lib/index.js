import z from "@deepseek-ai/schemastery";
import * as dshSettings from "@deepseek-ai/dsh-settings";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { readFile, rm, stat } from "node:fs/promises";
import { createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { cpus, homedir, hostname, release } from "node:os";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/catalog.ts
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
const FALLBACK_TRAE_MODELS = [
	{
		id: "DeepSeek-V4-Flash-Official",
		name: "DeepSeek-V4-Flash",
		contextWindow: 2e5
	},
	{
		id: "DeepSeek-V4-Pro-Official",
		name: "DeepSeek-V4-Pro",
		contextWindow: 2e5
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 2e5
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 2e5
	}
];
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
const FALLBACK_TRAE_MODELS_AI = [
	{
		id: "gemini-3.1-pro",
		name: "Gemini-3.1-Pro-Preview",
		contextWindow: 2e5
	},
	{
		id: "gemini-3-flash-solo",
		name: "Gemini-3-Flash-Preview",
		contextWindow: 2e5
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 2e5
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax-M2.7",
		contextWindow: 2e5
	},
	{
		id: "kimi-k2.5",
		name: "Kimi-K2.5",
		contextWindow: 2e5
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 272e3
	},
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		contextWindow: 272e3
	}
];
/**
* Static fallback directory for a region. Each region keeps its own model
* slot in settings; the fallback must match the region so an account never
* shows the other region's roster.
*/
function fallbackModelsFor(region) {
	return region === "ai" ? FALLBACK_TRAE_MODELS_AI : FALLBACK_TRAE_MODELS;
}
/** Exact DSH modalities for one catalog entry; absent metadata is text-only. */
function traeInputModalities(model) {
	return [...model.input ?? ["text"]];
}
/**
* Compose the DSH-facing model name: Trae's own model picker renders each
* entry as `Name · x<rate>`, so the credit multiplier is shown inside the
* name. `TraeModelInfo.name` keeps the pure Trae display name — every join
* (wire resolution, callable-key filtering) must keep matching the
* undecorated name; only the model rows handed to DSH (adapter catalog and
* model discovery) use this decorated name.
*/
function traeModelDisplayName(model) {
	return model.creditMultiplier === void 0 ? model.name : `${model.name} · x${model.creditMultiplier.toFixed(2)}`;
}
/** Apply the user's explicit image opt-ins; upstream and saved row hints are ignored. */
function applyImageSelection(models, selected) {
	return models.map((model) => ({
		...model,
		input: selected.has(model.id) ? ["text", "image"] : ["text"]
	}));
}
/** Normalise a display name for cross-source joining. */
function displayKey(name) {
	return name.trim().toLowerCase();
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
function mergeTraeModelSources(remote, wire) {
	const wireByName = /* @__PURE__ */ new Map();
	const wireById = /* @__PURE__ */ new Map();
	for (const model of wire) {
		wireByName.set(displayKey(model.name), model);
		wireById.set(displayKey(model.id), model);
	}
	const result = [];
	for (const model of remote) {
		const wireModel = wireById.get(displayKey(model.id)) ?? wireByName.get(displayKey(model.name));
		if (wireModel === void 0) continue;
		result.push({
			id: model.id,
			name: model.name,
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxContextWindow === void 0 ? {} : { maxContextWindow: model.maxContextWindow },
			...model.creditMultiplier === void 0 ? {} : { creditMultiplier: model.creditMultiplier },
			input: ["text"],
			reasoningSupported: model.reasoningSupported,
			...model.reasoning === void 0 ? {} : {
				reasoning: model.reasoning,
				reasoningEfforts: Object.fromEntries(model.reasoning.supported.map((effort) => [effort, effort === "low" ? "light" : effort === "xhigh" ? "extra_high" : "high"]))
			},
			...wireModel.id !== "" && wireModel.id !== model.id ? { wireConfigName: wireModel.id } : {},
			...wireModel.function === void 0 ? {} : { wireFunction: wireModel.function }
		});
	}
	return result;
}
/**
* Apply the saved local budget. Trae advertises two windows per model (dev and
* Max), so the budget may only switch a model to its own advertised Max value —
* never to a fabricated number. Everything else keeps the dev window.
*/
function applyContextBudgets(catalog, budgets = {}) {
	return catalog.map((model) => ({
		...model,
		...model.maxContextWindow !== void 0 && budgets[model.id] === model.maxContextWindow ? { contextWindow: model.maxContextWindow } : {}
	}));
}
/** Convert Trae metadata into text-only model rows; image support is user-owned configuration. */
function discoveredCatalog(models) {
	const result = [];
	for (const model of models) result.push({
		id: model.id,
		name: model.name,
		...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
		...model.maxContextWindow === void 0 ? {} : { maxContextWindow: model.maxContextWindow },
		input: ["text"],
		...model.creditMultiplier === void 0 ? {} : { creditMultiplier: model.creditMultiplier },
		reasoningSupported: model.reasoningSupported,
		...model.reasoning === void 0 ? {} : {
			reasoning: model.reasoning,
			reasoningEfforts: Object.fromEntries(model.reasoning.supported.map((effort) => [effort, effort === "low" ? "light" : effort === "xhigh" ? "extra_high" : "high"]))
		}
	});
	return result;
}
/**
* Drop rows saved by older releases that generated `@1m` variant models, so a
* stale configuration cannot resurrect a variant the runtime no longer builds.
*/
function sanitizeCatalog(catalog) {
	return catalog.filter((model) => {
		if (model.id.endsWith("@1m")) return false;
		const legacy = model;
		return legacy.baseModelId === void 0 && legacy.maxContext !== true;
	});
}
/**
* Derive the runtime catalog from the last refreshed Trae directory plus the
* user's explicit selection and context budgets. An empty selection falls back
* to the whole directory: a plugin that has never been configured must still
* serve models rather than nothing. This is the single source of truth for
* what DSH actually exposes, so saving only the selection and budgets is
* enough to rebuild it after a restart.
*/
function deriveCatalog(catalog, enabled, budgets = {}) {
	return applyContextBudgets(enabled.size === 0 ? catalog : catalog.filter((model) => enabled.has(model.id)), budgets);
}
var TraeCatalog = class {
	models;
	/**
	* @param region Seeds the static fallback for this region; each region's
	* provider must never serve the other region's roster before its first live
	* refresh lands.
	*/
	constructor(region = "cn") {
		this.models = fallbackModelsFor(region);
	}
	current() {
		return this.models;
	}
	set(models) {
		if (models.length === 0) throw new Error("trae model catalog cannot be empty");
		this.models = models.map((model) => ({
			...model,
			...model.input === void 0 ? {} : { input: [...model.input] }
		}));
	}
};
//#endregion
//#region src/adapter.ts
/** Provider route this bundle owns for the domestic (CN) gateway. */
const TRAE_PROVIDER = "trae";
/**
* Provider route this bundle owns for the international (trae.ai) gateway.
* Named `-global` to match the plugin family's convention (`workbuddy-global`);
* the internal region bucket stays `ai`, which is the gateway/protocol name.
*/
const TRAE_AI_PROVIDER = "trae-global";
/** The provider id each region registers as. */
const TRAE_PROVIDERS = {
	cn: TRAE_PROVIDER,
	ai: TRAE_AI_PROVIDER
};
/** Human-readable provider names, shown in the DSH model picker. */
const TRAE_PROVIDER_DISPLAY_NAMES = {
	cn: "Trae",
	ai: "Trae Global"
};
/** Region a provider route id belongs to. */
function regionOfTraeProvider(provider) {
	for (const [region, id] of Object.entries(TRAE_PROVIDERS)) if (id === provider) return region;
}
const TRAE_STREAM_IDLE_TIMEOUT_MS = 3e5;
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-trae has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Conservative context capacity used only when a served model row carries no
* window of its own. Every fallback row and every live Trae row is expected to
* state its real window; this is the backstop that keeps one unsized row from
* failing the entire provider route (`INVALID_MODEL_CONTEXT`).
*/
const FALLBACK_CONTEXT_WINDOW = 2e5;
function toPiModel(info, baseUrl, providerId) {
	return {
		id: info.id,
		name: traeModelDisplayName(info),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: traeInputModalities(info),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		reasoning: info.reasoningEfforts !== void 0,
		...info.reasoningEfforts === void 0 ? {} : { thinkingLevelMap: {
			off: null,
			minimal: null,
			low: info.reasoningEfforts.low ?? null,
			medium: null,
			high: info.reasoningEfforts.high ?? null,
			xhigh: info.reasoningEfforts.xhigh ?? null,
			max: null
		} },
		...info.contextWindow === void 0 ? {} : { contextWindow: info.contextWindow },
		...info.maxTokens === void 0 ? {} : { maxTokens: info.maxTokens },
		compat: { supportsReasoningEffort: info.reasoningEfforts !== void 0 }
	};
}
function createTraeAdapter(options) {
	const providerId = options.provider ?? "trae";
	const providerName = options.displayName ?? "Trae";
	const baseUrl = `${options.baseUrl}/v1`;
	const buildModels = () => options.catalog.current().map((info) => toPiModel(info, baseUrl, providerId));
	const provider = {
		...createProvider({
			id: providerId,
			name: providerName,
			auth: { apiKey: {
				name: "Trae loopback secret",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "Trae loopback"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName: providerName,
		streamIdleTimeoutMs: TRAE_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-trae retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		defaultContextWindow: FALLBACK_CONTEXT_WINDOW,
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => options.apiKey,
			...options.resolveAttachments === void 0 ? {} : { resolveAttachments: options.resolveAttachments }
		}),
		invalidate() {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
//#endregion
//#region src/decrypt.ts
const TRAE_AUTH_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
const SALT_A = Uint8Array.from([
	82,
	9,
	106,
	213,
	48,
	54,
	165,
	56,
	191,
	64,
	163,
	158,
	129,
	243,
	215,
	251,
	124,
	227,
	57,
	130,
	155,
	47,
	255,
	135,
	52,
	142,
	67,
	68,
	196,
	222,
	233,
	203,
	84,
	123,
	148,
	50,
	166,
	194,
	35,
	61,
	238,
	76,
	149,
	11,
	66,
	250,
	195,
	78,
	8,
	46,
	161,
	102,
	40,
	217,
	36,
	178,
	118,
	91,
	162,
	73,
	109,
	139,
	209,
	37
]);
const SALT_B = Uint8Array.from([
	31,
	221,
	168,
	51,
	136,
	7,
	199,
	49,
	177,
	18,
	16,
	89,
	39,
	128,
	236,
	95,
	96,
	81,
	127,
	169,
	25,
	181,
	74,
	13,
	45,
	229,
	122,
	159,
	147,
	201,
	156,
	239,
	160,
	224,
	59,
	77,
	174,
	42,
	245,
	176,
	200,
	235,
	187,
	60,
	131,
	83,
	153,
	97,
	23,
	43,
	4,
	126,
	186,
	119,
	214,
	38,
	225,
	105,
	20,
	99,
	85,
	33,
	12,
	125
]);
const SALT_C = Uint8Array.from([
	191,
	192,
	216,
	250,
	122,
	246,
	220,
	97,
	31,
	254,
	98,
	27,
	8,
	72,
	71,
	176,
	135,
	99,
	96,
	18,
	127,
	101,
	203,
	104,
	211,
	102,
	191,
	125,
	37,
	72,
	150,
	156,
	51,
	229,
	121,
	35,
	17,
	153,
	141,
	177,
	110,
	131,
	150,
	128,
	172,
	255,
	254,
	6,
	18,
	140,
	55,
	62,
	236,
	249,
	135,
	64,
	135,
	12,
	117,
	4,
	89,
	149,
	168,
	209
]);
const SALT_D = Uint8Array.from([
	246,
	204,
	26,
	232,
	232,
	70,
	129,
	109,
	223,
	146,
	169,
	242,
	23,
	241,
	105,
	145,
	50,
	196,
	165,
	42,
	254,
	120,
	3,
	54,
	244,
	207,
	209,
	85,
	53,
	6,
	138,
	106,
	175,
	148,
	31,
	204,
	186,
	186,
	165,
	182,
	87,
	142,
	49,
	10,
	39,
	110,
	26,
	154,
	86,
	56,
	173,
	125,
	18,
	64,
	198,
	225,
	99,
	99,
	83,
	82,
	191,
	134,
	76,
	170
]);
function xor(a, b) {
	return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)));
}
function encryptionType(header) {
	if (header.equals(Buffer.from([
		116,
		99,
		5,
		16,
		0,
		0
	]))) return "aes";
	if (header.equals(Buffer.from([
		18,
		57,
		32,
		32,
		2,
		3
	]))) return "aes-private";
	throw new Error("unsupported Trae auth encryption header");
}
function decryptTraeStorageValue(encoded) {
	const buffer = Buffer.from(encoded, "base64");
	if (buffer.length <= 102) throw new Error("Trae auth ciphertext is too short");
	const type = encryptionType(buffer.subarray(0, 6));
	const random = buffer.subarray(6, 38);
	const encrypted = buffer.subarray(38);
	const salt = type === "aes-private" ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B);
	const first = createHash("sha512").update(random).digest();
	const derived = createHash("sha512").update(Buffer.concat([first, salt])).digest();
	const decipher = createDecipheriv("aes-128-cbc", derived.subarray(0, 16), derived.subarray(16, 32));
	const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
	if (decrypted.length < 64) throw new Error("Trae auth plaintext is too short");
	const expected = decrypted.subarray(0, 64);
	const plaintext = decrypted.subarray(64);
	const actual = createHash("sha512").update(plaintext).digest();
	if (!expected.equals(actual)) throw new Error("Trae auth integrity check failed");
	return plaintext.toString("utf8");
}
function parseTraeAuthValue(value) {
	const trimmed = value.trim();
	if (trimmed === "") throw new Error("Trae auth value is empty");
	const plaintext = trimmed.startsWith("{") ? trimmed : decryptTraeStorageValue(trimmed);
	return JSON.parse(plaintext);
}
function parseTraeStorageDocument(text) {
	const parsed = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Trae storage document must be an object");
	const value = parsed[TRAE_AUTH_STORAGE_KEY];
	if (typeof value !== "string") throw new Error(`Trae storage document has no ${TRAE_AUTH_STORAGE_KEY}`);
	return parseTraeAuthValue(value);
}
function decodeBase64UrlJson(segment) {
	try {
		const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
		const decoded = Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(decoded);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/**
* Parse the CLI token file. Accepts either the bare JWT itself or a JSON
* envelope containing one, since the on-disk shape is only verified on macOS
* and a future CLI revision may wrap it.
*/
function parseTraeCliToken(text) {
	const trimmed = text.trim();
	if (trimmed === "") throw new Error("Trae CLI token file is empty");
	let token = trimmed;
	if (trimmed.startsWith("{")) {
		const envelope = JSON.parse(trimmed);
		const candidate = envelope["token"] ?? envelope["accessToken"] ?? envelope["jwt"];
		if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("Trae CLI token document has no token field");
		token = candidate.trim();
	}
	const segments = token.split(".");
	if (segments.length !== 3 || segments.some((segment) => segment === "")) throw new Error("Trae CLI token is not a three-part JWT");
	const payload = decodeBase64UrlJson(segments[1]);
	if (payload === void 0) throw new Error("Trae CLI token payload is not decodable JSON");
	const data = typeof payload["data"] === "object" && payload["data"] !== null && !Array.isArray(payload["data"]) ? payload["data"] : void 0;
	const userId = typeof data?.["user_id"] === "string" ? data["user_id"] : void 0;
	if (userId === void 0 || userId === "") throw new Error("Trae CLI token has no data.user_id claim");
	const exp = payload["exp"];
	const expiresAtMs = typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1e3 : void 0;
	return {
		accessToken: token,
		userId,
		...expiresAtMs === void 0 ? {} : { expiresAtMs }
	};
}
//#endregion
//#region src/paths.ts
const APP_NAMES = {
	cn: "Trae CN",
	sg: "Trae",
	solo: "TRAE SOLO CN",
	"solo-sg": "TRAE SOLO"
};
/**
* Directory names the Trae CLI uses for its own home. These are deliberately
* separate from the Electron app-support names above: the CLI keeps a dotfile
* home (observed on macOS as `~/.trae-cn`) rather than an `Application Support`
* entry, so a machine with only the CLI installed has no `storage.json` at all.
*/
const CLI_HOME_NAMES = [".trae-cn", ".trae"];
/** Basename of the CLI's persisted bare JWT. */
const TRAE_CLI_TOKEN_FILENAME = "trae-jwt-token";
/**
* Linux desktop config directory names. Electron apps on Linux normally use a
* lowercase, space-free name rather than the macOS `Trae CN` spelling, so both
* are probed: guessing only the macOS spelling would silently miss a real
* install, and guessing only the Linux spelling would break every existing
* user. The actual name is unverified on a real Linux host.
*/
const LINUX_APP_NAMES = {
	cn: [
		"trae-cn",
		"Trae CN",
		"trae",
		"Trae"
	],
	sg: ["trae", "Trae"],
	solo: ["trae-solo-cn", "TRAE SOLO CN"],
	"solo-sg": ["trae-solo", "TRAE SOLO"]
};
function traeStorageCandidates(platform = process.platform, home = homedir(), env = process.env) {
	const result = [];
	for (const edition of [
		"cn",
		"sg",
		"solo",
		"solo-sg"
	]) {
		const app = APP_NAMES[edition];
		let roots;
		let appNames;
		if (platform === "darwin") {
			roots = [join(home, "Library", "Application Support")];
			appNames = [app];
		} else if (platform === "win32") {
			roots = [env.APPDATA, join(home, "AppData", "Roaming")].filter((value, index, all) => typeof value === "string" && value !== "" && all.indexOf(value) === index);
			appNames = [app];
		} else if (platform === "linux") {
			roots = [env.XDG_CONFIG_HOME || join(home, ".config")];
			appNames = LINUX_APP_NAMES[edition];
		} else {
			roots = [];
			appNames = [app];
		}
		for (const root of roots) for (const appName of appNames) result.push({
			edition,
			path: join(root, appName, "User", "globalStorage", "storage.json"),
			source: "desktop"
		});
	}
	return [...result, ...traeCliCandidates(platform, home, env)];
}
/**
* Candidate CLI token paths. Only CN/SOLO editions are targeted here for the
* same reason the store ignores SG desktop installs, and `.trae-cn` is mapped
* to `cn` while `.trae` is the CLI's international home and is therefore
* skipped by the store's edition filter.
*
* The CLI home is a dotfile directory directly under `$HOME` on every platform
* observed so far, but this is only verified on macOS; the Windows and Linux
* spellings are probed speculatively and a miss is harmless because every
* candidate is tried in order.
*/
function traeCliCandidates(platform = process.platform, home = homedir(), env = process.env) {
	const roots = [];
	if (platform === "win32") {
		for (const value of [env.USERPROFILE, home]) if (typeof value === "string" && value !== "" && !roots.includes(value)) roots.push(value);
	} else roots.push(home);
	const result = [];
	for (const root of roots) for (const name of CLI_HOME_NAMES) {
		const edition = name === ".trae-cn" ? "cn" : "sg";
		result.push({
			edition,
			path: join(root, name, TRAE_CLI_TOKEN_FILENAME),
			source: "cli"
		});
	}
	return result;
}
//#endregion
//#region src/region.ts
/**
* Verified gateway bases per region (docs/INTL_SG_EVIDENCE.md §2).
* The AI gateway is shared by both international installs (Trae desktop and
* TRAE SOLO); its mchost shards (`api16/api22-normal-alisg.mchost.guru`)
* answer the same bytes but stay internal — `coresg-normal.trae.ai` is the
* single stable entry point.
*/
const REGION_GATEWAYS = {
	cn: {
		chat: "https://trae-api-cn.mchost.guru",
		remote: "https://solo.trae.cn/api/remote/v1",
		pay: "https://api.trae.cn"
	},
	ai: {
		chat: "https://coresg-normal.trae.ai",
		remote: "https://coresg-normal.trae.ai/api/remote/v1",
		pay: "https://growsg-normal.trae.ai"
	}
};
/** Region for an edition label: the international installs belong to `ai`. */
function regionOfEdition(edition) {
	return edition === "sg" || edition === "solo-sg" ? "ai" : "cn";
}
/**
* Region from the credential's `userRegion` claim. The desktop storage spells
* it as an object (`{"region":"CN","_aiRegion":"CN"}`); the app logs also
* spell the bare value lowercase (`"sg"`). Both are accepted, case-blind.
*/
function regionOfUserRegion(value) {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
	if (typeof raw !== "string") return void 0;
	const lowered = raw.trim().toLowerCase();
	if (lowered === "cn") return "cn";
	if (lowered === "sg" || lowered === "ai") return "ai";
}
/** Region from a credential host (`.trae.ai` → ai, `.trae.cn`/`.trae.com.cn` → cn). */
function regionOfHost(host) {
	if (host === void 0) return void 0;
	const trimmed = host.trim();
	if (trimmed === "") return void 0;
	let hostname;
	try {
		hostname = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`).hostname;
	} catch {
		return;
	}
	if (hostname === "trae.ai" || hostname.endsWith(".trae.ai")) return "ai";
	if (hostname === "trae.cn" || hostname.endsWith(".trae.cn") || hostname.endsWith(".trae.com.cn")) return "cn";
}
/**
* Region of a credential: the `userRegion` claim wins, the host suffix is the
* fallback, and the edition label is the last resort. Every level is derived
* from data the credential itself carries, so no user configuration is needed.
*/
function regionOfCredential(credential) {
	return regionOfUserRegion(credential.userRegion) ?? regionOfHost(credential.host) ?? regionOfEdition(credential.edition);
}
//#endregion
//#region src/auth.ts
/** Host used for CLI tokens, which carry no host claim of their own. */
const CLI_DEFAULT_HOST = "https://api.trae.cn";
const OWN_VERSION = 1;
const TRAE_AUTH_FILENAME = ".trae-auth.json";
/** Prefix of the plugin-owned per-region credential copies. */
const TRAE_OWN_PREFIX = ".trae-auth";
/**
* Plugin-owned copy path for one region. Each region's store refreshes into
* its own file so two simultaneously signed-in regions never overwrite each
* other's refreshed token.
*/
function traeOwnAuthPath(region) {
	return join(resolveDshHome(), `${TRAE_OWN_PREFIX}.${region}.json`);
}
/**
* Pre-dual-provider single-copy path. Still read as a migration source (a
* legacy credential serves the region it belongs to until that region's own
* first refresh writes the per-region file), and removed by `logout`.
*/
function legacyTraeOwnAuthPath() {
	return join(resolveDshHome(), TRAE_AUTH_FILENAME);
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function timeToMs(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 0xe8d4a51000 ? value : value * 1e3;
	if (typeof value !== "string" || value.trim() === "") return void 0;
	const numeric = Number(value);
	if (Number.isFinite(numeric) && numeric > 0) return numeric > 0xe8d4a51000 ? numeric : numeric * 1e3;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/** Extract the `userRegion.region` string from either on-disk shape. */
function userRegionOf(value) {
	const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : void 0;
}
function normalizeTraeCredential(raw, edition, source) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const value = raw;
	const accessToken = optionalString(value["token"]) ?? optionalString(value["accessToken"]);
	if (accessToken === void 0) return void 0;
	const expiresAtMs = timeToMs(value["expiredAt"] ?? value["expiresAt"]) ?? 0;
	const refreshExpiresAtMs = timeToMs(value["refreshExpiredAt"] ?? value["refreshExpiresAt"]);
	const refreshToken = optionalString(value["refreshToken"]);
	const userRegion = userRegionOf(value["userRegion"]);
	const accountName = optionalString((typeof value["account"] === "object" && value["account"] !== null && !Array.isArray(value["account"]) ? value["account"] : void 0)?.["username"]);
	return {
		accessToken,
		...refreshToken === void 0 ? {} : { refreshToken },
		userId: optionalString(value["userId"]) ?? "",
		...accountName === void 0 ? {} : { accountName },
		host: optionalString(value["host"]) ?? "",
		...userRegion === void 0 ? {} : { userRegion },
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		edition,
		source
	};
}
function traeAccountId(credential) {
	const stable = `${credential.edition}\0${credential.userId || credential.accountName || "unknown"}`;
	return createHash("sha256").update(stable).digest("hex").slice(0, 24);
}
function parseOwn(text) {
	try {
		const document = JSON.parse(text);
		if (document.version !== OWN_VERSION || typeof document.credential !== "object" || document.credential === null) return void 0;
		const stored = document.credential;
		const edition = stored["edition"];
		if (edition !== "cn" && edition !== "sg" && edition !== "solo" && edition !== "solo-sg") return void 0;
		return normalizeTraeCredential({
			token: stored["accessToken"],
			refreshToken: stored["refreshToken"],
			userId: stored["userId"],
			host: stored["host"],
			userRegion: stored["userRegion"],
			account: stored["accountName"] === void 0 ? void 0 : { username: stored["accountName"] },
			expiredAt: stored["expiresAtMs"],
			refreshExpiredAt: stored["refreshExpiresAtMs"]
		}, edition, "dsh");
	} catch {
		return;
	}
}
var TraeCredentialStore = class {
	storagePathOverride;
	edition;
	accountId;
	region;
	ownPathExplicit;
	legacyOwnPath;
	legacyOwnPathExplicit;
	refresh;
	refreshMarginMs;
	inflight;
	constructor(options) {
		this.storagePathOverride = options.storagePath;
		this.edition = options.edition ?? "auto";
		this.accountId = options.accountId;
		this.region = options.region;
		this.ownPathExplicit = options.ownPath;
		this.legacyOwnPath = options.legacyOwnPath ?? legacyTraeOwnAuthPath();
		this.legacyOwnPathExplicit = options.legacyOwnPath;
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
	}
	/** Whether a credential's own claim belongs to this store's region. */
	matchesRegion(credential) {
		return this.region === void 0 || regionOfCredential(credential) === this.region;
	}
	/**
	* The path this store refreshes into: the per-region file for a
	* region-scoped store, the legacy single file otherwise, or an explicitly
	* injected path in tests.
	*/
	ownAuthPath() {
		if (this.ownPathExplicit !== void 0) return this.ownPathExplicit;
		return this.region !== void 0 ? traeOwnAuthPath(this.region) : this.legacyOwnPath;
	}
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
	ownCandidates() {
		if (this.ownPathExplicit !== void 0) return this.legacyOwnPathExplicit !== void 0 ? [this.ownPathExplicit, this.legacyOwnPathExplicit] : [this.ownPathExplicit];
		if (this.region !== void 0) return [traeOwnAuthPath(this.region), this.legacyOwnPath];
		return [
			this.legacyOwnPath,
			traeOwnAuthPath("cn"),
			traeOwnAuthPath("ai")
		];
	}
	setSource(storagePath, edition = "auto", accountId) {
		this.storagePathOverride = storagePath;
		this.edition = edition;
		this.accountId = accountId;
		this.inflight = void 0;
	}
	selectAccount(accountId) {
		this.accountId = accountId;
		this.inflight = void 0;
	}
	candidates() {
		if (this.storagePathOverride !== void 0) {
			const edition = this.edition === "auto" ? "cn" : this.edition;
			return [{
				edition,
				path: this.storagePathOverride,
				source: "desktop"
			}, {
				edition,
				path: this.storagePathOverride,
				source: "cli"
			}];
		}
		const all = traeStorageCandidates();
		const cliEdition = "cn";
		return this.edition === "auto" ? all.filter((candidate) => candidate.source === "desktop" || candidate.edition === cliEdition) : all.filter((candidate) => candidate.edition === this.edition && (candidate.source === "desktop" || candidate.edition === cliEdition));
	}
	/**
	* Deterministic default when no account is explicitly selected: the first
	* discovered account. This is NOT credit-seeking — it never reorders accounts
	* to find one with general credits. The plugin bills exactly the account the
	* user selected, or the first account when nothing has been selected yet.
	*/
	preferred(credentials) {
		return credentials[0];
	}
	async accounts() {
		const credentials = await this.readAll();
		const selectedExists = this.accountId !== void 0 && credentials.some((credential) => traeAccountId(credential) === this.accountId);
		const defaultSelected = this.preferred(credentials);
		return credentials.map((credential) => ({
			id: traeAccountId(credential),
			accountName: credential.accountName ?? (credential.userId || `${credential.edition} account`),
			edition: credential.edition,
			region: regionOfCredential(credential),
			source: credential.source,
			tokenExpiresAtMs: credential.expiresAtMs,
			selected: selectedExists ? traeAccountId(credential) === this.accountId : credential === defaultSelected
		}));
	}
	async current() {
		const credentials = await this.readAll();
		if (this.accountId === void 0) return this.preferred(credentials);
		return credentials.find((credential) => traeAccountId(credential) === this.accountId);
	}
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) throw new Error(`trae: no signed-in account found (${this.candidates().map((item) => item.path).join(" or ")})`);
		if (credential.expiresAtMs > Date.now() + this.refreshMarginMs) return credential;
		this.inflight ??= this.refreshNow(credential).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	async status() {
		try {
			const value = await this.current();
			return value === void 0 ? { state: "signed-out" } : {
				state: "signed-in",
				edition: value.edition,
				expiresAtMs: value.expiresAtMs,
				source: value.source
			};
		} catch {
			return { state: "signed-out" };
		}
	}
	async desktopFilePresent() {
		for (const candidate of this.candidates()) try {
			if ((await stat(candidate.path)).isFile()) return true;
		} catch {}
		return false;
	}
	/**
	* Remove every plugin-owned copy this store could read (per-region file,
	* legacy single file, and their lock siblings); the desktop storage files
	* are untouched. A region store's logout therefore also clears the legacy
	* migration source — deliberate: `logout` is the user's "forget what the
	* plugin stored" action, not a per-account toggle.
	*/
	async logout() {
		for (const path of this.ownCandidates()) {
			await rm(path, { force: true });
			await rm(`${path}.lock`, { force: true });
		}
	}
	/**
	* Every local credential of this store's region, deduplicated by account id.
	* A region-scoped store sees only its own region's credentials: the other
	* region's accounts are invisible to selection, refresh, and status alike,
	* which is what keeps the two regions' providers from cross-billing.
	*/
	async readAll() {
		const { credentials: desktop } = await this.readDesktopAll();
		const credentials = [...desktop.filter((credential) => this.matchesRegion(credential))];
		for (const own of await this.readOwns()) {
			if (!this.matchesRegion(own)) continue;
			if (credentials.some((credential) => traeAccountId(credential) === traeAccountId(own))) continue;
			credentials.push(own);
		}
		return credentials;
	}
	/**
	* Which paths were tried and why each one failed. Read-only and token-free:
	* it exists so a signed-out card can explain itself instead of showing a bare
	* "not signed in", which is undiagnosable on a machine whose layout differs
	* from the ones the plugin was written against.
	*/
	async diagnose() {
		const tried = this.candidates();
		const failures = [];
		for (const candidate of tried) {
			const raw = await readFile(candidate.path, "utf8").then((text) => ({ text }), (error) => ({ error }));
			if ("error" in raw) {
				const code = typeof raw.error === "object" && raw.error !== null && "code" in raw.error ? raw.error.code : void 0;
				failures.push({
					path: candidate.path,
					edition: candidate.edition,
					source: candidate.source,
					reason: code === "ENOENT" ? "missing" : "unreadable",
					...code === "ENOENT" ? {} : { message: String(raw.error) }
				});
				continue;
			}
			try {
				this.credentialFrom(candidate, raw.text);
			} catch (error) {
				failures.push({
					path: candidate.path,
					edition: candidate.edition,
					source: candidate.source,
					reason: "invalid",
					message: error instanceof Error ? error.message : String(error)
				});
			}
		}
		return {
			tried,
			failures
		};
	}
	/** Parse one candidate file's text into a credential, or throw. */
	credentialFrom(candidate, text) {
		let credential;
		if (candidate.source === "cli") {
			if (regionOfEdition(candidate.edition) !== "cn") throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported yet`);
			const claims = parseTraeCliToken(text);
			credential = normalizeTraeCredential({
				token: claims.accessToken,
				userId: claims.userId,
				host: CLI_DEFAULT_HOST,
				expiredAt: claims.expiresAtMs
			}, candidate.edition, "cli");
		} else credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, "desktop");
		if (credential === void 0) throw new Error(`${candidate.source} candidate could not be normalized into a credential`);
		return credential;
	}
	async readDesktopAll() {
		const credentials = [];
		const failures = [];
		for (const candidate of this.candidates()) try {
			const credential = this.credentialFrom(candidate, await readFile(candidate.path, "utf8"));
			if (!credentials.some((existing) => traeAccountId(existing) === traeAccountId(credential))) credentials.push(credential);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
			failures.push({
				path: candidate.path,
				edition: candidate.edition,
				source: candidate.source,
				reason: code === "ENOENT" ? "missing" : code === void 0 ? "invalid" : "unreadable",
				...code === "ENOENT" || code === void 0 && !(error instanceof Error) ? {} : { message: error instanceof Error ? error.message : String(error) }
			});
			continue;
		}
		return {
			credentials,
			failures
		};
	}
	/**
	* Every readable plugin-owned copy, in candidate order; absent or corrupt
	* files are skipped rather than propagated.
	*/
	async readOwns() {
		const copies = [];
		for (const path of this.ownCandidates()) try {
			const parsed = parseOwn(await readFile(path, "utf8"));
			if (parsed !== void 0) copies.push(parsed);
		} catch {}
		return copies;
	}
	async refreshNow(credential) {
		if (credential.refreshToken === void 0 || credential.refreshExpiresAtMs !== void 0 && credential.refreshExpiresAtMs <= Date.now()) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error("trae: access token expired and no valid refresh token is available; sign in again in Trae");
		}
		try {
			const outcome = await this.refresh(credential);
			const refreshed = {
				...credential,
				accessToken: outcome.accessToken,
				...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
				expiresAtMs: outcome.expiresAtMs,
				...outcome.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: outcome.refreshExpiresAtMs },
				...outcome.host === void 0 ? {} : { host: outcome.host },
				source: "dsh"
			};
			const ownPath = this.ownAuthPath();
			await withFileLock(ownPath, async () => {
				await writeFileAtomic(ownPath, `${JSON.stringify({
					version: OWN_VERSION,
					credential: refreshed
				}, null, 2)}\n`, {
					mode: 384,
					dirMode: 448
				});
			});
			return refreshed;
		} catch (error) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`trae: token refresh failed and access token is expired (${String(error)}); sign in again in Trae`);
		}
	}
};
//#endregion
//#region src/refresh.ts
const REFRESH_CONTRACT = {
	cn: {
		path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
		clientId: "ono9krqynydwx5",
		deviceInfo: false
	},
	sg: {
		path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
		clientId: "ono9krqynydwx5",
		deviceInfo: false
	},
	solo: {
		path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
		clientId: "ono9krqynydwx5",
		deviceInfo: false
	},
	"solo-sg": {
		path: "/trae/api/v3/oauth/ExchangeToken",
		clientId: "en1oxy7wnw8j9n",
		deviceInfo: true
	}
};
function normalizeHost(host) {
	const value = host.trim();
	if (value === "") throw new Error("Trae refresh host is missing");
	return value.replace(/\/$/, "");
}
/**
* Exchange a refresh token for a fresh access token, following the calling
* edition's verified contract. `device` is only used by editions whose
* official client sends a DeviceInfo body; when it cannot be resolved the
* field is omitted rather than sent empty.
*/
async function refreshTraeCredential(credential, signal, device) {
	const contract = REFRESH_CONTRACT[credential.edition];
	if (contract === void 0) throw new Error(`Trae ${credential.edition} refresh contract is not verified`);
	if (credential.refreshToken === void 0) throw new Error("Trae refresh token is missing");
	const body = {
		ClientID: contract.clientId,
		ClientSecret: "-",
		RefreshToken: credential.refreshToken,
		UserID: credential.userId
	};
	if (contract.deviceInfo && device !== void 0) body["DeviceInfo"] = {
		DeviceID: device.deviceId,
		MachineID: device.machineId,
		PlatformCode: credential.edition === "solo-sg" ? "SOLO_PC" : "TRAE",
		DeviceType: "PC",
		DeviceName: hostname()
	};
	const response = await fetch(`${normalizeHost(credential.host)}${contract.path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: signal ?? AbortSignal.timeout(3e4)
	});
	if (!response.ok) throw new Error(`Trae token refresh failed (http ${response.status})`);
	const result = (await response.json()).Result;
	const accessToken = typeof result?.["Token"] === "string" ? result["Token"] : "";
	if (accessToken === "") throw new Error("Trae token refresh returned no token");
	const expiry = result?.["TokenExpireAt"];
	const expiresAtMs = typeof expiry === "number" ? expiry : typeof expiry === "string" ? Date.parse(expiry) : NaN;
	if (!Number.isFinite(expiresAtMs)) throw new Error("Trae token refresh returned an invalid expiry");
	const refreshToken = typeof result?.["RefreshToken"] === "string" && result["RefreshToken"] !== "" ? result["RefreshToken"] : void 0;
	return {
		accessToken,
		...refreshToken === void 0 ? {} : { refreshToken },
		expiresAtMs
	};
}
//#endregion
//#region src/identity.ts
function nonEmpty(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function deviceCenterId(storage) {
	const prefix = "iCubeAuthInfo://icube-dc:";
	const ids = Object.keys(storage).filter((key) => key.startsWith(prefix)).map((key) => key.slice(25)).filter(Boolean);
	return ids.length === 1 ? ids[0] : void 0;
}
/** Read stable identity from Trae-owned files without generating impersonated IDs. */
async function readTraeIdentity(candidate, options = {}) {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const storage = JSON.parse(await readFile(candidate.path, "utf8"));
	const appRoot = dirname(dirname(dirname(candidate.path)));
	const machineFile = nonEmpty(await readFile(join(appRoot, "machineid"), "utf8").catch(() => ""));
	const telemetryMachine = nonEmpty(storage["telemetry.machineId"]);
	const devDevice = nonEmpty(storage["telemetry.devDeviceId"]);
	const dcDevice = deviceCenterId(storage);
	const machineId = telemetryMachine ?? machineFile;
	if (machineId === void 0) throw new Error(`Trae ${candidate.edition} has no stable machine identity`);
	const deviceId = dcDevice ?? devDevice ?? createHash("sha256").update(machineId).digest("hex").slice(0, 32);
	const buildVersion = nonEmpty(storage["iCubeLastVersion"]);
	const appName = {
		cn: "Trae CN",
		sg: "Trae",
		solo: "TRAE SOLO CN",
		"solo-sg": "TRAE SOLO"
	}[candidate.edition];
	const productPaths = [];
	if (appName !== void 0 && (platform === "darwin" || platform === "win32")) {
		if (platform === "darwin") productPaths.push(join("/Applications", `${appName}.app`, "Contents", "Resources", "app", "product.json"));
		else {
			const localRoots = [env.LOCALAPPDATA, join(home, "AppData", "Local")].filter((value) => typeof value === "string" && value !== "").filter((value, index, all) => all.indexOf(value) === index);
			for (const root of localRoots) productPaths.push(join(root, "Programs", appName, "resources", "app", "product.json"));
		}
	}
	let product = {};
	for (const path of productPaths) try {
		product = JSON.parse(await readFile(path, "utf8"));
		break;
	} catch {}
	const appVersion = nonEmpty(product["appVersion"]);
	const deviceBrand = platform === "darwin" ? nonEmpty(env["TRAE_DEVICE_BRAND"]) : void 0;
	const deviceCpu = cpus()[0]?.model.split(" ")[0];
	const osVersion = `${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform} ${release()}`;
	return {
		edition: candidate.edition,
		machineId,
		deviceId,
		...appVersion === void 0 ? {} : { appVersion },
		...buildVersion === void 0 ? {} : { buildVersion },
		...deviceBrand === void 0 ? {} : { deviceBrand },
		...deviceCpu === void 0 ? {} : { deviceCpu },
		osVersion,
		platform
	};
}
/** Detect a missing storage file (as opposed to a parse/identity error). */
function isFileMissing(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
/** Prefix of the "no candidate exists on disk" error; see {@link resolveTraeIdentity}. */
const STORAGE_MISSING_PREFIX = "Trae storage was not found";
/**
* Try candidates in order and return the first that yields a valid identity;
* fail hard only when none do. Mirrors the credential store's skip-missing
* semantics so a machine with only SOLO (no CN install) resolves correctly
* instead of pinning the first candidate and throwing on a missing file.
* When every candidate is absent from disk the error names all tried paths;
* a candidate that exists but fails to parse still surfaces its own error.
*/
async function pickTraeStorageIdentity(candidates, options = {}) {
	let lastError;
	let anyPresent = false;
	for (const candidate of candidates) try {
		return await readTraeIdentity(candidate, options);
	} catch (error) {
		lastError = error;
		if (!isFileMissing(error)) anyPresent = true;
	}
	const tried = candidates.map((item) => item.path).join(" or ");
	if (!anyPresent) throw new Error(`${STORAGE_MISSING_PREFIX} (${tried})`);
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`Trae identity could not be resolved (${tried})`);
}
/** CLI dotfile home per edition; the CLI keeps its own home, not an Application Support entry. */
const CLI_HOME_BY_EDITION = {
	cn: ".trae-cn",
	solo: ".trae-cn",
	sg: ".trae",
	"solo-sg": ".trae"
};
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
async function readTraeCliIdentity(edition, options = {}) {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const cliHome = join(home, CLI_HOME_BY_EDITION[edition]);
	const argv = await readJsonFile(join(cliHome, "argv.json"));
	const version = await readJsonFile(join(cliHome, "builtin", "ide_version.json"));
	const crashReporterId = nonEmpty(argv?.["crash-reporter-id"]);
	const host = nonEmpty(env["HOSTNAME"]) ?? await readHostname() ?? "unknown-host";
	const user = nonEmpty(env["USER"]) ?? nonEmpty(env["USERNAME"]) ?? "unknown-user";
	const deviceId = crashReporterId ?? createHash("sha256").update(`trae-cli\0${host}\0${user}`).digest("hex").slice(0, 32);
	const machineId = createHash("sha256").update(`trae-cli-machine\0${deviceId}\0${host}`).digest("hex");
	const appVersion = nonEmpty(version?.["version"]);
	const deviceCpu = cpus()[0]?.model.split(" ")[0];
	const osVersion = `${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform} ${release()}`;
	return {
		edition,
		machineId,
		deviceId,
		...appVersion === void 0 ? {} : { appVersion },
		...deviceCpu === void 0 ? {} : { deviceCpu },
		osVersion,
		platform
	};
}
/** Read and parse a JSON file, tolerating absence and malformed content. */
async function readJsonFile(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/** OS host name, or undefined when unavailable. */
async function readHostname() {
	try {
		const { hostname } = await import("node:os");
		return nonEmpty(hostname());
	} catch {
		return;
	}
}
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
async function resolveTraeIdentity(candidates, edition, options = {}) {
	try {
		return await pickTraeStorageIdentity(candidates, options);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith(STORAGE_MISSING_PREFIX)) throw error;
		return readTraeCliIdentity(edition, options);
	}
}
/** Headers derived from actual persisted identity, never a new random identity per request. */
function identityHeaders(identity) {
	return {
		"x-machine-id": identity.machineId,
		"x-device-id": identity.deviceId,
		"x-device-type": identity.platform === "darwin" ? "mac" : identity.platform === "win32" ? "windows" : identity.platform,
		...identity.deviceBrand === void 0 ? {} : { "x-device-brand": identity.deviceBrand },
		...identity.deviceCpu === void 0 ? {} : { "x-device-cpu": identity.deviceCpu },
		...identity.osVersion === void 0 ? {} : { "x-os-version": identity.osVersion },
		...identity.appVersion === void 0 ? {} : {
			"x-app-version": identity.appVersion,
			"x-ide-version": identity.appVersion
		},
		...identity.buildVersion === void 0 ? {} : {
			"x-app-version-code": identity.buildVersion,
			"x-ide-version-code": identity.buildVersion
		},
		"x-ide-version-type": "stable"
	};
}
//#endregion
//#region src/shim.ts
const BODY_LIMIT = 67108864;
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
const STATUS_BY_KIND = {
	authentication: 401,
	hard_credit: 402,
	soft_rate: 429,
	not_found: 502,
	server: 502,
	client: 400,
	unconfigured: 503
};
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
function hostIsLoopback(host) {
	return host !== void 0 && host.trim() !== "" && LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const hostname = new URL(origin).hostname;
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
			} else chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
function createTraeShim(options) {
	const secret = randomBytes(32).toString("base64url");
	const sockets = /* @__PURE__ */ new Set();
	const server = createServer((req, res) => {
		handle(req, res);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	let boundPort;
	let bindFailure;
	let bindSettled = false;
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				bindFailure = /* @__PURE__ */ new Error("trae shim bound without a numeric port");
				bindSettled = true;
				reject(bindFailure);
				return;
			}
			boundPort = address.port;
			bindSettled = true;
			resolve();
		});
		server.once("error", (error) => {
			bindFailure = error;
			bindSettled = true;
			reject(error);
		});
	});
	ready.catch(() => {});
	try {
		server.listen(options.port ?? 0, options.bindHost ?? "127.0.0.1");
	} catch (error) {
		bindFailure = error;
		bindSettled = true;
	}
	/**
	* Wait for the bind, bounded by `timeoutMs`. Never throws and never hangs: a
	* failed bind resolves `false` immediately, and a bind that has not settled
	* by the deadline resolves `false` with the attempt still in flight. Returns
	* `true` only when {@link TraeShim.baseUrl} is safe to call.
	*/
	function whenListening(timeoutMs) {
		if (bindSettled) return Promise.resolve(boundPort !== void 0);
		return new Promise((resolve) => {
			const settle = (value) => {
				clearTimeout(timer);
				server.off("listening", onSettled);
				server.off("error", onSettled);
				resolve(value);
			};
			const onSettled = () => settle(boundPort !== void 0);
			const timer = setTimeout(() => settle(false), timeoutMs);
			if (typeof timer.unref === "function") timer.unref();
			server.once("listening", onSettled);
			server.once("error", onSettled);
		});
	}
	function bearerOk(req) {
		const match = typeof req.headers.authorization === "string" ? /^Bearer\s+(.+)$/i.exec(req.headers.authorization.trim()) : null;
		if (match === null) return false;
		const actual = Buffer.from(match[1] ?? "");
		const expected = Buffer.from(secret);
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) return writeError(res, 403, "host_not_allowed", "Host must be loopback");
			if (!originIsLoopback(req.headers.origin)) return writeError(res, 403, "origin_not_allowed", "Origin must be loopback");
			if (!bearerOk(req)) return writeError(res, 401, "unauthorized", "Missing or invalid bearer");
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) return writeJson(res, 200, { ok: true });
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) return writeJson(res, 200, {
				object: "list",
				data: options.catalog.current().map((model) => ({
					id: model.id,
					object: "model",
					created: 0,
					owned_by: "trae"
				}))
			});
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				if (typeof req.headers["content-type"] !== "string" || !req.headers["content-type"].toLowerCase().startsWith("application/json")) return writeError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
				const raw = (await readBody(req)).toString("utf8");
				try {
					JSON.parse(raw);
				} catch {
					return writeError(res, 400, "invalid_json", "Request body must be valid JSON");
				}
				const parsed = JSON.parse(raw);
				options.logger?.warn("dsh-connect-trae: chat request received", {
					model: parsed.model,
					messages: Array.isArray(parsed.messages) ? parsed.messages.map((message) => typeof message === "object" && message !== null ? message["role"] ?? "?" : "?") : "(none)",
					toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
					maxTokens: parsed.max_tokens,
					reasoningEffort: parsed.reasoning_effort,
					temperature: parsed.temperature,
					bodyBytes: raw.length
				});
				const controller = new AbortController();
				const abort = () => controller.abort();
				req.once("aborted", abort);
				req.socket.once("close", abort);
				const result = await options.client.chatStream(raw, controller.signal);
				if (!result.ok) return writeError(res, STATUS_BY_KIND[result.kind], result.kind, result.message);
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
					"X-Accel-Buffering": "no"
				});
				const body = Readable.fromWeb(result.response.body);
				body.on("error", (error) => {
					const record = error instanceof Error ? {
						name: error.name,
						message: error.message,
						cause: error.cause ? String(error.cause) : void 0
					} : String(error);
					options.logger?.warn("dsh-connect-trae: upstream stream failed", record);
					if (!res.writableEnded) res.end();
				});
				body.pipe(res);
				return;
			}
			writeError(res, 404, "not_found", `No such route: ${req.method} ${url}`);
		} catch (error) {
			options.logger?.error("dsh-connect-trae: shim request failed", error);
			if (!res.headersSent) writeError(res, 500, "internal", "Internal shim error");
			else if (!res.writableEnded) res.end();
		}
	}
	let closeRequested;
	function close() {
		closeRequested ??= (async () => {
			for (const socket of sockets) socket.destroy();
			if (!server.listening) {
				await ready.catch(() => {});
				return;
			}
			await new Promise((resolve, reject) => {
				server.close((error) => error === void 0 ? resolve() : reject(error));
			});
		})();
		return closeRequested;
	}
	return {
		ready,
		get listening() {
			return boundPort !== void 0;
		},
		whenListening,
		/**
		* The loopback base URL. Reads the port recorded at bind time rather than
		* the server's live state, so once {@link TraeShim.whenListening} has
		* answered `true` this can never throw.
		*
		* It still throws when the caller skipped the readiness gate — that is a
		* programming error, and it names itself as one instead of surfacing later
		* as an unexplained provider-registration failure.
		*/
		baseUrl() {
			if (boundPort === void 0) throw new Error("trae shim is not listening; await shim.whenListening(...) before building a provider from it");
			return `http://127.0.0.1:${boundPort}`;
		},
		reason: () => bindFailure,
		token: () => secret,
		close
	};
}
//#endregion
//#region src/protocol.ts
const TRAE_CN_AGENT_TASK_PATH = "/api/agent/v3/create_agent_task";
const TRAE_CN_TITLE_PATH = "/api/agent/v3/llm_utils_chat";
/**
* Evidence-bounded body draft. It is intentionally pure and offline; the
* network client remains disabled until a controlled request validates it.
*/
function buildTraeAgentTaskBody(messages, model, options = {}) {
	if (messages.length === 0) throw new Error("Trae agent task requires at least one message");
	const requestId = options.requestId ?? randomUUID();
	const sessionId = options.sessionId ?? requestId;
	return {
		messages: messages.map((message) => ({
			role: message.role,
			content: [{
				type: "text",
				text: message.content
			}]
		})),
		model,
		function: "inline_chat",
		stream: true,
		request_id: requestId,
		session_id: sessionId,
		...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens }
	};
}
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
const TRAE_VERSION_CODE_FALLBACK = "20260716";
/** Keep a purely numeric build version; fall back when it cannot bind. */
function normalizeTraeVersionCode(buildVersion) {
	if (buildVersion === void 0 || buildVersion.trim() === "") return TRAE_VERSION_CODE_FALLBACK;
	const trimmed = buildVersion.trim();
	return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK;
}
/**
* Headers shared by every Trae edition. The same shape is accepted by both
* gateways (verified read-only on the international gateway 2026-09-15,
* docs/INTL_SG_EVIDENCE.md §2.3: identical `x-app-id`, identity headers, and
* `Cloud-IDE-JWT` auth), so there is no per-edition branch any more.
*/
function buildTraeHeaders(credential, identity, options = {}) {
	const requestId = options.requestId ?? randomUUID();
	const traceId = requestId.replaceAll("-", "").slice(0, 32);
	const profile = options.profile ?? "agent-task";
	const common = {
		"Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
		"X-Ide-Token": credential.accessToken,
		"x-plugin-channel": "icube-ai",
		"User-Agent": `Trae/${identity.appVersion ?? identity.buildVersion ?? "unknown"}`,
		"x-app-id": options.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
		...identityHeaders(identity),
		"x-app-version-code": normalizeTraeVersionCode(identity.buildVersion),
		"x-ide-version-code": normalizeTraeVersionCode(identity.buildVersion),
		"x-custom-trace-id": traceId,
		"x-flow-traceparent": `04-${traceId}-${traceId.slice(0, 16)}-01`,
		"request-traffic-type": "prod",
		"Content-Type": "application/json"
	};
	if (profile === "native-curl") return {
		"Content-Type": "application/json",
		"request-traffic-type": "prod",
		"x-app-id": options.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
		...identityHeaders(identity),
		"x-custom-trace-id": traceId,
		"x-flow-traceparent": `04-${traceId}-${traceId.slice(0, 16)}-01`,
		"X-Ide-Token": credential.accessToken
	};
	if (profile === "model-detail") return {
		...common,
		"Accept": "application/json"
	};
	if (profile === "raw-chat") return {
		...common,
		"Accept": "text/event-stream"
	};
	return {
		...common,
		"X-Cloudide-Token": credential.accessToken,
		"x-uid": credential.userId,
		"x-request-id": requestId,
		"x-trae-request-id": requestId,
		"Accept": "text/event-stream"
	};
}
/** Backwards-compatible alias; the headers are no longer CN-specific. */
const buildTraeCnHeaders = buildTraeHeaders;
function traeEndpoint(baseUrl, path) {
	return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
//#endregion
//#region src/reasoning.ts
const TRAE_REASONING_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh"
];
function parseReasoningCapability(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const record = value;
	const supported = (Array.isArray(record["reasoning_effort_options"]) ? record["reasoning_effort_options"] : []).filter((item) => typeof item === "string" && TRAE_REASONING_EFFORTS.includes(item));
	const rawDefault = record["default_reasoning_effort"];
	const defaultEffort = typeof rawDefault === "string" && supported.includes(rawDefault) ? rawDefault : void 0;
	if (supported.length === 0 && defaultEffort === void 0) return void 0;
	return {
		supported,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
/** Add effort only when the selected model advertises that exact value. */
function applyReasoningEffort(body, effort, capability) {
	if (effort === void 0) return body;
	if (capability === void 0 || !capability.supported.includes(effort)) throw new Error(`Trae model does not advertise reasoning effort ${effort}`);
	return {
		...body,
		reasoning_effort: effort
	};
}
//#endregion
//#region src/solo.ts
const TRAE_SOLO_FUNCTION = "solo_work_lite";
/**
* Directory functions to union per region, in priority order.
*
* Trae spreads its callable roster across several SOLO-mode functions, and a
* model is only usable through the one that lists it: `glm-5.3` is absent from
* `solo_work_lite` but present in `solo_work_remote` (verified 2026-09-15 —
* calling it through the former answers `4001 param is invalid`, through the
* latter streams normally). Rather than betting on a single function, the
* directory unions them; the first function to provide a config wins, so the
* order below decides which wire name a model is called with.
*/
const TRAE_DIRECTORY_FUNCTIONS = {
	cn: ["solo_work_remote", TRAE_SOLO_FUNCTION],
	ai: [
		"solo_agent",
		"solo_work_remote",
		TRAE_SOLO_FUNCTION
	]
};
const TRAE_SOLO_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
const TRAE_SOLO_MODELS_PATH = "/api/ide/v1/get_detail_param";
function classify(status) {
	if (status === 401 || status === 403) return "authentication";
	if (status === 402) return "hard_credit";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
function finitePositive$1(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function prepareSoloBody(source, defaultModel = "glm-5.2", functionName) {
	const input = JSON.parse(source);
	const model = typeof input["model"] === "string" && input["model"].trim() !== "" ? input["model"].trim() : defaultModel;
	const body = {
		...Array.isArray(input["messages"]) ? { messages: input["messages"] } : {},
		model,
		config_name: model,
		function: typeof input["function"] === "string" && input["function"] !== "" ? input["function"] : functionName ?? "solo_work_lite",
		stream: true,
		...Array.isArray(input["tools"]) ? { tools: input["tools"] } : {},
		...typeof input["reasoning_effort"] === "string" ? { reasoning_effort: input["reasoning_effort"] } : {}
	};
	if (Array.isArray(body["messages"])) for (const raw of body["messages"]) {
		if (typeof raw !== "object" || raw === null) continue;
		const message = raw;
		if (message["role"] === "developer") message["role"] = "system";
		if (typeof message["content"] === "string") message["content"] = [{
			type: "text",
			text: message["content"]
		}];
		if (message["role"] === "assistant" && Array.isArray(message["tool_calls"])) for (const rawCall of message["tool_calls"]) {
			if (typeof rawCall !== "object" || rawCall === null) continue;
			const call = rawCall;
			if (typeof call["function"] === "object" && call["function"] !== null) {
				call["function_call"] = call["function"];
				delete call["function"];
			}
		}
		if (message["role"] === "tool") {
			message["role"] = "tool";
			if (typeof message["tool_call_id"] !== "string" || message["tool_call_id"] === "") throw new Error("Trae SOLO tool message requires tool_call_id");
		}
	}
	if (Array.isArray(body["tools"])) for (const raw of body["tools"]) {
		if (typeof raw !== "object" || raw === null) continue;
		const fn = raw["function"];
		if (typeof fn !== "object" || fn === null) continue;
		const record = fn;
		if (typeof record["parameters"] === "object" && record["parameters"] !== null) record["parameters"] = JSON.stringify(record["parameters"]);
	}
	return JSON.stringify(body);
}
var TraeSoloUpstreamClient = class {
	options;
	fetchImpl;
	constructor(options) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}
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
	async fetchModels(signal) {
		const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		const region = regionOfCredential(credential);
		const base = this.options.baseUrl ?? REGION_GATEWAYS[region].chat;
		const headers = {
			...buildTraeCnHeaders(credential, identity),
			Accept: "application/json"
		};
		const byId = /* @__PURE__ */ new Map();
		const failures = [];
		for (const directoryFunction of TRAE_DIRECTORY_FUNCTIONS[region]) {
			let list;
			try {
				const response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
					method: "POST",
					headers,
					body: JSON.stringify({
						function: directoryFunction,
						config_names: null,
						need_prompt: false,
						current_config_info: null,
						poly_prompt: true,
						mode_type: null,
						agent_type: null
					}),
					signal: signal ?? AbortSignal.timeout(3e4)
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const document = await response.json();
				list = Array.isArray(document["config_info_list"]) ? document["config_info_list"] : [];
			} catch (error) {
				failures.push(`${directoryFunction}: ${String(error).slice(0, 80)}`);
				continue;
			}
			this.collectModels(list, directoryFunction, byId);
		}
		const models = [...byId.values()];
		if (models.length === 0) throw new Error(`Trae SOLO models response contained no models (${failures.join("; ") || "empty directory"})`);
		return models;
	}
	/** Merge one function's config list into the shared catalogue (first wins). */
	collectModels(list, directoryFunction, byId) {
		for (const raw of list) {
			if (typeof raw !== "object" || raw === null) continue;
			const config = raw;
			const id = typeof config["config_name"] === "string" ? config["config_name"] : "";
			if (id === "") continue;
			const display = typeof config["display_config"] === "object" && config["display_config"] !== null ? config["display_config"] : {};
			const details = Array.isArray(config["model_detail_list"]) ? config["model_detail_list"] : [];
			const detail = typeof details[0] === "object" && details[0] !== null ? details[0] : {};
			const contextTokens = typeof config["context_window_tokens"] === "object" && config["context_window_tokens"] !== null ? config["context_window_tokens"] : {};
			const promptMaxTokens = finitePositive$1(detail["prompt_max_tokens"]);
			const devTokens = finitePositive$1(contextTokens["dev"]);
			const contextWindow = promptMaxTokens ?? devTokens;
			const maxTokens = finitePositive$1(detail["max_tokens"]);
			const reasoning = parseReasoningCapability({
				...config,
				...detail
			});
			if (byId.has(id)) continue;
			byId.set(id, {
				id,
				name: typeof display["display_name"] === "string" && display["display_name"] !== "" ? display["display_name"] : id,
				...contextWindow === void 0 ? {} : { contextWindow },
				...maxTokens === void 0 ? {} : { maxTokens },
				...reasoning === void 0 ? {} : { reasoning },
				function: directoryFunction
			});
		}
	}
	async chatStream(bodyJson, signal, functionName) {
		let prepared;
		try {
			prepared = prepareSoloBody(bodyJson, void 0, functionName);
		} catch {
			return {
				ok: false,
				status: 400,
				kind: "client",
				message: "invalid JSON request"
			};
		}
		const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		const headers = buildTraeCnHeaders(credential, identity);
		const base = this.options.baseUrl ?? REGION_GATEWAYS[regionOfCredential(credential)].chat;
		let response;
		try {
			response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_CHAT_PATH), {
				method: "POST",
				headers,
				body: prepared,
				signal: signal ?? AbortSignal.timeout(12e4)
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, 1024);
		this.options.log?.("dsh-connect-trae: llm_utils_chat rejected", {
			status: response.status,
			model: JSON.parse(prepared)["model"],
			configName: JSON.parse(prepared)["config_name"],
			reasoningEffort: JSON.parse(prepared)["reasoning_effort"],
			body: text
		});
		return {
			ok: false,
			status: response.status,
			kind: classify(response.status),
			message: text || `Trae SOLO returned HTTP ${response.status}`
		};
	}
};
//#endregion
//#region src/sse.ts
/** Incremental SSE decoder supporting CRLF, chunk splits and multi-line data. */
var SseDecoder = class {
	buffer = "";
	event;
	id;
	retry;
	data = [];
	push(chunk) {
		this.buffer += chunk;
		const events = [];
		while (true) {
			const match = /\r?\n/.exec(this.buffer);
			if (match === null || match.index === void 0) break;
			const line = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			const emitted = this.consumeLine(line);
			if (emitted !== void 0) events.push(emitted);
		}
		return events;
	}
	finish() {
		const events = [];
		if (this.buffer !== "") {
			const emitted = this.consumeLine(this.buffer);
			this.buffer = "";
			if (emitted !== void 0) events.push(emitted);
		}
		const final = this.dispatch();
		if (final !== void 0) events.push(final);
		return events;
	}
	consumeLine(line) {
		if (line === "") return this.dispatch();
		if (line.startsWith(":")) return void 0;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.event = value;
		else if (field === "data") this.data.push(value);
		else if (field === "id" && !value.includes("\0")) this.id = value;
		else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
	}
	dispatch() {
		if (this.data.length === 0) {
			this.event = void 0;
			this.retry = void 0;
			return;
		}
		const result = {
			...this.event === void 0 || this.event === "" ? {} : { event: this.event },
			data: this.data.join("\n"),
			...this.id === void 0 ? {} : { id: this.id },
			...this.retry === void 0 ? {} : { retry: this.retry }
		};
		this.event = void 0;
		this.retry = void 0;
		this.data = [];
		return result;
	}
};
function decodeTraeEvent(event) {
	if (event.data === "[DONE]") return {
		type: "done",
		finishReason: "stop"
	};
	let payload;
	try {
		payload = JSON.parse(event.data);
	} catch {
		return {
			type: "unknown",
			...event.event === void 0 ? {} : { event: event.event },
			data: event.data
		};
	}
	const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
	if (event.event === "request_wait_in_queue") return {
		type: "queue",
		...typeof record["position"] === "number" ? { position: record["position"] } : {}
	};
	if (event.event === "progress_notice") return {
		type: "progress",
		notice: payload
	};
	if (event.event === "token_usage") return {
		type: "usage",
		...typeof record["prompt_tokens"] === "number" ? { inputTokens: record["prompt_tokens"] } : {},
		...typeof record["completion_tokens"] === "number" ? { outputTokens: record["completion_tokens"] } : {},
		...typeof record["total_tokens"] === "number" ? { totalTokens: record["total_tokens"] } : {},
		...typeof record["reasoning_tokens"] === "number" ? { reasoningTokens: record["reasoning_tokens"] } : {}
	};
	if (event.event === "done" || typeof record["finish_reason"] === "string" && record["response"] === void 0) return {
		type: "done",
		finishReason: typeof record["finish_reason"] === "string" ? record["finish_reason"] : "stop"
	};
	if (event.event === "output" || record["response"] !== void 0 || record["reasoning_content"] !== void 0) return {
		type: "delta",
		text: typeof record["response"] === "string" ? record["response"] : "",
		...typeof record["reasoning_content"] === "string" ? { reasoning: record["reasoning_content"] } : {},
		...record["tool_calls"] === void 0 || record["tool_calls"] === null ? {} : { toolCalls: record["tool_calls"] }
	};
	return {
		type: "unknown",
		...event.event === void 0 ? {} : { event: event.event },
		data: payload
	};
}
//#endregion
//#region src/solo-bridge.ts
function normalizeToolCalls(value) {
	if (!Array.isArray(value)) return [];
	const calls = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const record = raw;
		const rawFunction = typeof record["function_call"] === "object" && record["function_call"] !== null ? record["function_call"] : typeof record["function"] === "object" && record["function"] !== null ? record["function"] : {};
		const fn = {
			...typeof rawFunction["name"] === "string" ? { name: rawFunction["name"] } : {},
			...typeof rawFunction["arguments"] === "string" ? { arguments: rawFunction["arguments"] } : {}
		};
		calls.push({
			index: typeof record["index"] === "number" ? record["index"] : calls.length,
			...typeof record["id"] === "string" ? { id: record["id"] } : {},
			...record["type"] === "function" ? { type: "function" } : {},
			...Object.keys(fn).length === 0 ? {} : { function: fn }
		});
	}
	return calls;
}
/** Convert Trae's named SSE events into OpenAI chat-completion SSE chunks. */
function bridgeTraeSoloStream(response, model) {
	const source = response.body;
	if (source === null) return new Response(null, { status: 502 });
	const id = `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
	const created = Math.floor(Date.now() / 1e3);
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const sse = new SseDecoder();
	let sawToolCalls = false;
	let emittedFinishReason = false;
	let upstreamEnded = false;
	let upstreamError;
	let usage;
	const chunk = (delta, finishReason = null) => encoder.encode(`data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{
			index: 0,
			delta,
			finish_reason: finishReason
		}],
		...usage === void 0 ? {} : { usage }
	})}\n\n`);
	const stream = new ReadableStream({
		async start(controller) {
			const reader = source.getReader();
			const consume = (event) => {
				const decoded = decodeTraeEvent(event);
				if (decoded.type === "unknown") {
					const payload = decoded.data;
					const code = typeof payload?.["code"] === "number" ? payload["code"] : void 0;
					if (decoded.event === "error" || code !== void 0 && code >= 4e3) upstreamError = new Error(typeof payload?.["message"] === "string" && payload["message"] !== "" ? payload["message"] : `Trae upstream error (code ${code ?? "?"})`);
					return;
				}
				if (decoded.type === "delta") {
					const delta = {};
					if (decoded.text !== "") delta["content"] = decoded.text;
					if (decoded.reasoning !== void 0 && decoded.reasoning !== "") delta["reasoning_content"] = decoded.reasoning;
					const toolCalls = normalizeToolCalls(decoded.toolCalls);
					if (toolCalls.length > 0) {
						sawToolCalls = true;
						delta["tool_calls"] = toolCalls;
					}
					if (Object.keys(delta).length > 0) controller.enqueue(chunk(delta));
				} else if (decoded.type === "usage") usage = {
					...decoded.inputTokens === void 0 ? {} : { prompt_tokens: decoded.inputTokens },
					...decoded.outputTokens === void 0 ? {} : { completion_tokens: decoded.outputTokens },
					...decoded.totalTokens === void 0 ? {} : { total_tokens: decoded.totalTokens }
				};
				else if (decoded.type === "done") {
					upstreamEnded = true;
					if (!emittedFinishReason) {
						emittedFinishReason = true;
						if (upstreamError !== void 0) {
							controller.error(upstreamError);
							return;
						}
						controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : decoded.finishReason || "stop"));
					}
				}
			};
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event);
				}
				for (const event of sse.finish()) consume(event);
				if (upstreamError !== void 0 && !upstreamEnded) {
					controller.error(upstreamError);
					return;
				}
				if (!emittedFinishReason) {
					emittedFinishReason = true;
					controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : "stop"));
				}
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			} catch (error) {
				controller.error(error);
			} finally {
				reader.releaseLock();
			}
		},
		cancel(reason) {
			return source.cancel(reason);
		}
	});
	return new Response(stream, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" }
	});
}
/** Native SOLO client wrapper used by the loopback OpenAI adapter. */
var TraeSoloBridge = class {
	upstream;
	catalog;
	wireResolver;
	constructor(upstream, catalog, wireResolver) {
		this.upstream = upstream;
		this.catalog = catalog;
		this.wireResolver = wireResolver;
	}
	async chatStream(bodyJson, signal) {
		let model = "glm-5.2";
		let prepared = bodyJson;
		try {
			const input = JSON.parse(bodyJson);
			if (typeof input["model"] === "string" && input["model"] !== "") model = input["model"];
			const entry = this.catalog?.current().find((item) => item.id === model);
			const fromCatalog = entry?.wireConfigName === void 0 ? void 0 : {
				configName: entry.wireConfigName,
				...entry.wireFunction === void 0 ? {} : { function: entry.wireFunction }
			};
			const fromResolver = this.wireResolver?.(model) ?? this.wireResolver?.(entry?.name ?? "");
			const target = fromCatalog ?? fromResolver;
			const wireModel = target?.configName ?? model;
			const wireFunction = target?.function ?? entry?.wireFunction;
			if (wireModel !== input["model"]) input["model"] = wireModel;
			if (wireFunction !== void 0 && input["function"] !== wireFunction) input["function"] = wireFunction;
			if (wireModel !== JSON.parse(bodyJson)["model"] || wireFunction !== void 0) prepared = JSON.stringify(input);
			if (typeof input["reasoning_effort"] === "string") {
				const efforts = entry?.reasoningEfforts;
				const requested = input["reasoning_effort"];
				const mapped = efforts?.[requested];
				const allowed = efforts === void 0 ? [] : Object.values(efforts).filter((value) => typeof value === "string");
				if (typeof mapped === "string") input["reasoning_effort"] = mapped;
				else if (!allowed.includes(requested)) delete input["reasoning_effort"];
				prepared = JSON.stringify(input);
			}
		} catch {
			return {
				ok: false,
				status: 400,
				kind: "client",
				message: "invalid JSON request"
			};
		}
		const result = await this.upstream.chatStream(prepared, signal);
		if (!result.ok) return result;
		return {
			ok: true,
			response: bridgeTraeSoloStream(result.response, model)
		};
	}
};
//#endregion
//#region src/model-metadata.ts
function finitePositive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function parseFeatures(value) {
	if (typeof value !== "string" || value === "") return void 0;
	try {
		return record(JSON.parse(value));
	} catch {
		return;
	}
}
const EFFORT_MAP = {
	light: "low",
	high: "high",
	extra_high: "xhigh"
};
/** Parse only capabilities explicitly advertised by Trae's remote model API. */
function parseTraeRemoteModel(value) {
	const raw = record(value);
	if (raw === void 0 || typeof raw.name !== "string" || raw.name === "") return void 0;
	const context = record(raw.context_window_tokens);
	const dev = finitePositive(context?.["dev"]);
	const max = raw.max_mode === true ? finitePositive(context?.["max"]) : void 0;
	const features = parseFeatures(raw.features);
	const consumption = record(features?.["consumption_rate"]);
	const consumptionData = record(consumption?.["data"]);
	const creditMultiplier = consumption?.["enable"] === true ? finitePositive(consumptionData?.["rate"]) : void 0;
	const reasoningSupported = record(features?.["reasoning"])?.["enable"] === true;
	const reasoningConfig = record(raw.reasoning_effort_config);
	const supported = (Array.isArray(reasoningConfig?.["options"]) ? reasoningConfig["options"] : []).flatMap((option) => {
		if (typeof option !== "string") return [];
		const effort = EFFORT_MAP[option];
		return effort === void 0 ? [] : [effort];
	});
	const rawDefault = reasoningConfig?.["default_level"];
	const mappedDefault = typeof rawDefault === "string" ? EFFORT_MAP[rawDefault] : void 0;
	const defaultEffort = mappedDefault !== void 0 && supported.includes(mappedDefault) ? mappedDefault : void 0;
	return {
		id: raw.name,
		name: typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : raw.name,
		multimodal: raw.multimodal === true,
		...dev === void 0 ? {} : { contextWindow: dev },
		...max === void 0 ? {} : { maxContextWindow: max },
		...creditMultiplier === void 0 ? {} : { creditMultiplier },
		reasoningSupported,
		...supported.length === 0 ? {} : { reasoning: {
			supported,
			...defaultEffort === void 0 ? {} : { defaultEffort }
		} }
	};
}
//#endregion
//#region src/solo-remote.ts
const TRAE_SOLO_REMOTE_BASE = "https://solo.trae.cn/api/remote/v1";
/**
* Region-scoped request dressing. The CN portal is `solo.trae.cn` with the
* CN locale headers; the international directory lives on the shared
* `coresg-normal.trae.ai` gateway and was verified (2026-09-15) with the
* English/Singapore headers — both forms are accepted, each region keeps the
* shape its own portal sends.
*/
function remoteDressing(region) {
	return region === "ai" ? {
		referer: "https://coresg-normal.trae.ai/",
		timezone: "Asia/Singapore",
		language: "en"
	} : {
		referer: "https://solo.trae.cn/",
		timezone: "Asia/Shanghai",
		language: "zh-cn"
	};
}
/**
* Read-only model catalog client for the SOLO Web API.
*
* This deliberately has no chat/session method: the Remote session protocol
* only exposes a final answer and cannot preserve DSH's structured tool loop.
*/
var TraeSoloRemoteCatalogClient = class {
	options;
	fetchImpl;
	baseUrl;
	constructor(options) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.baseUrl = options.baseUrl;
	}
	async headers(region) {
		const credential = await this.options.credential();
		const dressing = remoteDressing(region);
		return {
			"Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
			"Content-Type": "application/json",
			"x-trae-client-type": "web",
			"x-trae-user-timezone": dressing.timezone,
			"x-preferenced-language": dressing.language,
			"Referer": dressing.referer,
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
		};
	}
	async fetchModels(signal) {
		const region = regionOfCredential(await this.options.credential());
		const base = this.baseUrl ?? REGION_GATEWAYS[region].remote;
		const headers = await this.headers(region);
		const response = await this.fetchImpl(`${base}/models?functions=solo_agent_remote,solo_work_remote`, {
			headers,
			signal: signal ?? AbortSignal.timeout(3e4)
		});
		if (!response.ok) throw new Error(`SOLO remote models returned HTTP ${response.status}`);
		const groups = (await response.json()).data?.list ?? [];
		const preferred = groups.find((group) => group.function === "solo_agent_remote") ?? groups[0];
		const seen = /* @__PURE__ */ new Set();
		const models = [];
		for (const raw of preferred?.models ?? []) {
			const model = parseTraeRemoteModel(raw);
			if (model === void 0 || seen.has(model.id)) continue;
			seen.add(model.id);
			models.push(model);
		}
		if (models.length === 0) throw new Error("SOLO remote models response contained no models");
		return models;
	}
};
//#endregion
//#region src/raw-chat.ts
const TRAE_RAW_CHAT_V2_PATH = "/api/ide/v2/llm_raw_chat";
const TRAE_RAW_CHAT_V1_PATH = "/api/ide/v1/llm_raw_chat";
/**
* Evidence-bounded OpenAI-like draft inferred from Trae's LLMRaw* DTO symbols.
* Pure/offline only: the upstream remains disabled until one controlled probe.
*/
function buildTraeRawChatDraft(input) {
	if (input.model.trim() === "") throw new Error("Trae raw chat requires a model");
	if (input.messages.length === 0) throw new Error("Trae raw chat requires messages");
	return {
		model: input.model,
		messages: structuredClone([...input.messages]),
		stream: true,
		...input.tools === void 0 || input.tools.length === 0 ? {} : { tools: structuredClone([...input.tools]) },
		...input.maxTokens === void 0 ? {} : { max_tokens: input.maxTokens },
		...input.temperature === void 0 ? {} : { temperature: input.temperature },
		...input.reasoningEffort === void 0 ? {} : { reasoning_effort: input.reasoningEffort },
		...input.extraInfo === void 0 ? {} : { extra_info: structuredClone(input.extraInfo) }
	};
}
/** Decode OpenAI-like raw-chat chunks while preserving unknown structures. */
function decodeRawChatChunk(value) {
	if (value === "[DONE]") return [{
		type: "done",
		finishReason: "stop"
	}];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [{
		type: "unknown",
		value
	}];
	const record = value;
	const result = [];
	const choices = Array.isArray(record["choices"]) ? record["choices"] : [];
	for (const rawChoice of choices) {
		if (typeof rawChoice !== "object" || rawChoice === null) continue;
		const choice = rawChoice;
		const delta = typeof choice["delta"] === "object" && choice["delta"] !== null ? choice["delta"] : {};
		if (typeof delta["reasoning_content"] === "string" && delta["reasoning_content"] !== "") result.push({
			type: "reasoning",
			text: delta["reasoning_content"]
		});
		if (typeof delta["content"] === "string" && delta["content"] !== "") result.push({
			type: "text",
			text: delta["content"]
		});
		if (Array.isArray(delta["tool_calls"])) for (const rawTool of delta["tool_calls"]) {
			if (typeof rawTool !== "object" || rawTool === null) continue;
			const tool = rawTool;
			const fn = typeof tool["function"] === "object" && tool["function"] !== null ? tool["function"] : {};
			result.push({
				type: "tool-call",
				index: typeof tool["index"] === "number" ? tool["index"] : 0,
				...typeof tool["id"] === "string" ? { id: tool["id"] } : {},
				...typeof fn["name"] === "string" ? { name: fn["name"] } : {},
				...typeof fn["arguments"] === "string" ? { arguments: fn["arguments"] } : {}
			});
		}
		if (typeof choice["finish_reason"] === "string" && choice["finish_reason"] !== "") result.push({
			type: "done",
			finishReason: choice["finish_reason"]
		});
	}
	if (typeof record["usage"] === "object" && record["usage"] !== null) {
		const usage = record["usage"];
		result.push({
			type: "usage",
			...typeof usage["prompt_tokens"] === "number" ? { inputTokens: usage["prompt_tokens"] } : {},
			...typeof usage["completion_tokens"] === "number" ? { outputTokens: usage["completion_tokens"] } : {},
			...typeof usage["total_tokens"] === "number" ? { totalTokens: usage["total_tokens"] } : {}
		});
	}
	return result.length === 0 ? [{
		type: "unknown",
		value
	}] : result;
}
//#endregion
//#region src/raw-runtime-config.ts
/** Merge safe current-cache facts with observed behavior flags; no network credentials enter this object. */
function traeRawChatExtraInfo(config) {
	return {
		...config.nativeFunctionCall === void 0 ? {} : { native_function_call: config.nativeFunctionCall },
		...config.useV2Process === void 0 ? {} : { use_v2_process: config.useV2Process },
		...config.maxModeEnabled === void 0 ? {} : { v2_max_mode_enabled: config.maxModeEnabled },
		...config.maxToolcallChars === void 0 ? {} : { v3_max_toolcall_chars: config.maxToolcallChars },
		...config.streamThrottleEnabled === void 0 ? {} : { v3_stream_throttle_enabled: config.streamThrottleEnabled }
	};
}
function buildTraeRawChatRuntimeConfig(modelName, cached, behavior = {}) {
	return {
		configName: modelName,
		modelName,
		...cached?.promptMaxTokens === void 0 ? {} : { promptMaxTokens: cached.promptMaxTokens },
		...cached?.maxTokens === void 0 ? {} : { maxTokens: cached.maxTokens },
		...cached?.maxTurn === void 0 ? {} : { maxTurn: cached.maxTurn },
		...cached?.multimodal === void 0 ? {} : { multimodal: cached.multimodal },
		...cached?.customConfig === void 0 ? {} : { customConfig: structuredClone(cached.customConfig) },
		...behavior.nativeFunctionCall === void 0 ? {} : { nativeFunctionCall: behavior.nativeFunctionCall },
		...behavior.passBackReasoning === void 0 ? {} : { passBackReasoning: behavior.passBackReasoning },
		...behavior.useV2Process === void 0 ? {} : { useV2Process: behavior.useV2Process },
		...behavior.maxModeEnabled === void 0 ? {} : { maxModeEnabled: behavior.maxModeEnabled },
		...behavior.maxToolcallChars === void 0 ? {} : { maxToolcallChars: behavior.maxToolcallChars },
		...behavior.streamThrottleEnabled === void 0 ? {} : { streamThrottleEnabled: behavior.streamThrottleEnabled }
	};
}
//#endregion
//#region src/raw-upstream.ts
function classifyTraeRawChatFailure(message) {
	const text = message.trim();
	if (text === "") return "empty";
	if (text.startsWith("{") || text.startsWith("[")) return "json";
	if (/permission|forbidden|unauthorized|auth/i.test(text)) return "permission";
	if (/model|config_name|config name/i.test(text)) return "model";
	if (/schema|field|parameter|invalid|missing|required|parse/i.test(text)) return "schema";
	if (/^Trae Raw Chat returned HTTP \d{3}$/i.test(text)) return "generic-http";
	return "other";
}
function errorKind(status) {
	if (status === 401 || status === 403) return "authentication";
	if (status === 402) return "hard_credit";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
/**
* Evidence-gated Raw Chat client. It is fully testable through injected fetch,
* but production callers must not construct it without verified config values.
*/
var TraeRawChatUpstreamClient = class {
	options;
	fetchImpl;
	constructor(options) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
		if (options.config.configName.trim() === "") throw new Error("Trae Raw Chat configName must be evidence-backed and non-empty");
	}
	async chatStream(bodyJson, signal) {
		let input;
		try {
			input = JSON.parse(bodyJson);
		} catch {
			return {
				ok: false,
				status: 400,
				kind: "client",
				message: "invalid JSON request"
			};
		}
		if (!Array.isArray(input.messages) || input.messages.length === 0) return {
			ok: false,
			status: 400,
			kind: "client",
			message: "messages are required"
		};
		const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
		const requestId = crypto.randomUUID();
		const headers = buildTraeCnHeaders(credential, identity, {
			requestId,
			profile: "raw-chat"
		});
		const runtime = this.options.config.runtime;
		const runtimeExtra = runtime === void 0 ? {} : traeRawChatExtraInfo(runtime);
		const body = {
			...buildTraeRawChatDraft({
				model: this.options.config.model,
				messages: input.messages,
				...input.tools === void 0 ? {} : { tools: input.tools },
				...input.max_tokens === void 0 ? {} : { maxTokens: input.max_tokens },
				...input.temperature === void 0 ? {} : { temperature: input.temperature },
				...input.reasoning_effort === void 0 ? {} : { reasoningEffort: input.reasoning_effort },
				...Object.keys(runtimeExtra).length === 0 && this.options.config.extraInfo === void 0 ? {} : { extraInfo: {
					...runtimeExtra,
					...this.options.config.extraInfo
				} }
			}),
			config_name: this.options.config.configName,
			...this.options.config.promptSet === void 0 ? {} : { prompt_set: this.options.config.promptSet },
			...this.options.config.abVersion === void 0 ? {} : { ab_version: this.options.config.abVersion },
			pass_back_reasoning: runtime?.passBackReasoning ?? this.options.config.passBackReasoning
		};
		let response;
		try {
			response = await this.fetchImpl(traeEndpoint(this.options.baseUrl ?? REGION_GATEWAYS[regionOfCredential(credential)].chat, TRAE_RAW_CHAT_V2_PATH), {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: signal ?? AbortSignal.timeout(3e4)
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, 1024);
		return {
			ok: false,
			status: response.status,
			kind: errorKind(response.status),
			message: text || `Trae Raw Chat returned HTTP ${response.status}`
		};
	}
};
//#endregion
//#region src/raw-capability.ts
/** One short non-tool request decides whether Raw Chat may become primary. */
async function probeTraeRawChatCapability(client, signal) {
	const body = JSON.stringify({
		model: "qwen-3.7-plus",
		messages: [{
			role: "user",
			content: "Reply with exactly: OK"
		}],
		max_tokens: 8,
		temperature: 0
	});
	const result = await client.chatStream(body, signal);
	if (result.ok) {
		const contentType = result.response.headers.get("content-type");
		await result.response.body?.cancel().catch(() => {});
		return {
			available: true,
			contentType
		};
	}
	return {
		available: false,
		reason: result.kind === "authentication" ? "authentication" : result.kind === "hard_credit" ? "credit" : result.kind === "soft_rate" ? "rate" : result.status === 400 || result.status === 404 || result.status === 415 || result.kind === "unconfigured" ? "protocol" : result.kind === "server" && result.status === 0 ? "transport" : "server",
		status: result.status
	};
}
//#endregion
//#region src/raw-capability-state.ts
/** In-memory capability state; success/failure expires and config changes invalidate it. */
var TraeRawCapabilityState = class {
	ttlMs;
	snapshot = {};
	constructor(ttlMs = 18e5) {
		this.ttlMs = ttlMs;
	}
	current(fingerprint, now = Date.now()) {
		const value = this.snapshot;
		if (value.capability === void 0 || value.checkedAtMs === void 0 || value.fingerprint !== fingerprint) return void 0;
		return now - value.checkedAtMs <= this.ttlMs ? value.capability : void 0;
	}
	record(fingerprint, capability, now = Date.now()) {
		this.snapshot = {
			fingerprint,
			capability,
			checkedAtMs: now
		};
	}
	inspect() {
		return { ...this.snapshot };
	}
	invalidate() {
		this.snapshot = {};
	}
};
//#endregion
//#region src/raw-capability-controller.ts
/** Explicitly-triggered, single-flight Raw Chat capability checks. */
var TraeRawCapabilityController = class {
	options;
	state;
	enabled;
	inflight;
	constructor(options) {
		this.options = options;
		this.state = options.state ?? new TraeRawCapabilityState();
		this.enabled = options.enabled ?? false;
	}
	current(fingerprint) {
		return this.enabled ? this.state.current(fingerprint) : void 0;
	}
	setEnabled(enabled) {
		if (this.enabled !== enabled) this.state.invalidate();
		this.enabled = enabled;
	}
	inspect() {
		return this.state.inspect();
	}
	isEnabled() {
		return this.enabled;
	}
	invalidate() {
		this.state.invalidate();
	}
	probe(fingerprint, signal) {
		if (!this.enabled) return Promise.resolve({
			available: false,
			reason: "protocol",
			status: 0
		});
		const cached = this.state.current(fingerprint);
		if (cached !== void 0) return Promise.resolve(cached);
		this.inflight ??= probeTraeRawChatCapability(this.options.client, signal).then((result) => {
			this.state.record(fingerprint, result);
			return result;
		}).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
};
//#endregion
//#region src/raw-fingerprint.ts
/** Stable non-secret fingerprint for capability-cache invalidation. */
function rawCapabilityFingerprint(input) {
	const stable = JSON.stringify({
		endpoint: input.endpoint,
		edition: input.edition,
		appVersion: input.identity.appVersion ?? "",
		buildVersion: input.identity.buildVersion ?? "",
		runtime: input.runtime
	});
	return createHash("sha256").update(stable).digest("hex");
}
//#endregion
//#region src/raw-diagnostic.ts
/** Project capability facts to a redacted, user-safe status. */
function rawCapabilityDiagnostic(enabled, capability, checkedAtMs) {
	if (!enabled) return { state: "disabled" };
	if (capability === void 0) return { state: "unchecked" };
	if (capability.available) return {
		state: "available",
		...checkedAtMs === void 0 ? {} : { checkedAtMs }
	};
	return {
		state: capability.reason === "protocol" ? "protocol-gated" : capability.reason,
		status: capability.status,
		...checkedAtMs === void 0 ? {} : { checkedAtMs }
	};
}
//#endregion
//#region src/fallback-upstream.ts
/**
* Optional primary route first, native SOLO tool-call route second. Fallback is intentionally narrow:
* only definitive pre-stream schema/route incompatibilities may retry the same
* user request. Authentication, credit, rate, cancellation, transport/server
* failures, and every successful Response are never replayed.
*/
var TraeFallbackUpstreamClient = class {
	options;
	constructor(options) {
		this.options = options;
	}
	async chatStream(bodyJson, signal) {
		const primary = await this.options.primary.chatStream(bodyJson, signal);
		if (primary.ok) return primary;
		if (!this.canFallback(primary, signal)) return primary;
		this.options.onFallback?.(primary);
		return this.options.fallback.chatStream(bodyJson, signal);
	}
	canFallback(result, signal) {
		if (signal?.aborted === true) return false;
		if (result.kind === "authentication" || result.kind === "hard_credit" || result.kind === "soft_rate") return false;
		return result.status === 400 || result.status === 404 || result.status === 415 || result.kind === "unconfigured";
	}
};
//#endregion
//#region src/gated-upstream.ts
/** Select Raw Chat only after a successful capability probe; SOLO is the safe default. */
var TraeGatedUpstreamClient = class {
	options;
	constructor(options) {
		this.options = options;
	}
	chatStream(bodyJson, signal) {
		if (this.options.capability()?.available !== true) return this.options.solo.chatStream(bodyJson, signal);
		return new TraeFallbackUpstreamClient({
			primary: this.options.raw,
			fallback: this.options.solo,
			...this.options.onFallback === void 0 ? {} : { onFallback: this.options.onFallback }
		}).chatStream(bodyJson, signal);
	}
};
//#endregion
//#region src/raw-gateway.ts
/** Assemble the opt-in capability state and safe Raw→SOLO routing. */
function createTraeRawGateway(options) {
	const fingerprint = () => rawCapabilityFingerprint(options);
	const controller = new TraeRawCapabilityController({
		client: options.raw,
		enabled: options.enabled ?? false
	});
	return {
		upstream: new TraeGatedUpstreamClient({
			raw: options.raw,
			solo: options.solo,
			capability: () => controller.current(fingerprint())
		}),
		probe: (signal) => controller.probe(fingerprint(), signal),
		diagnostic: () => {
			const snapshot = controller.inspect();
			return rawCapabilityDiagnostic(controller.isEnabled(), snapshot.capability, snapshot.checkedAtMs);
		},
		invalidate: () => controller.invalidate()
	};
}
//#endregion
//#region src/model-cache.ts
const execFileAsync = promisify(execFile);
function positive$1(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/** Parse a safe subset of one cached model entry; credentials and endpoints are intentionally omitted. */
function parseTraeCachedModel(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const raw = value;
	if (typeof raw["name"] !== "string" || raw["name"] === "") return void 0;
	let customConfig;
	if (typeof raw["custom_config"] === "string" && raw["custom_config"] !== "") try {
		const parsed = JSON.parse(raw["custom_config"]);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) customConfig = parsed;
	} catch {}
	const promptMaxTokens = positive$1(raw["prompt_max_tokens"]);
	const maxTokens = positive$1(raw["max_tokens"]);
	const maxTurn = positive$1(raw["max_turn"]);
	return {
		name: raw["name"],
		...customConfig === void 0 ? {} : { customConfig },
		...promptMaxTokens === void 0 ? {} : { promptMaxTokens },
		...maxTokens === void 0 ? {} : { maxTokens },
		...maxTurn === void 0 ? {} : { maxTurn },
		...typeof raw["multimodal"] === "boolean" ? { multimodal: raw["multimodal"] } : {},
		...typeof raw["model_type"] === "string" ? { modelType: raw["model_type"] } : {}
	};
}
/**
* Read Trae's own current user's model map via sqlite3 without exposing
* secrets. The sqlite3 command line is a macOS prerequisite; on Windows it is
* typically absent, so the call fails and callers fall back gracefully.
*/
async function readTraeCachedModel(functionName, modelName, userId, options = {}) {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const database = platform === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Trae CN", "User", "globalStorage", "state.vscdb") : join(home, "Library", "Application Support", "Trae CN", "User", "globalStorage", "state.vscdb");
	const key = `${userId}_AI.agent.model.model_list_map`;
	const sql = `select value from ItemTable where key=${JSON.stringify(key)} limit 1;`;
	const { stdout } = await execFileAsync("sqlite3", [database, sql], { maxBuffer: 8388608 });
	const document = JSON.parse(stdout);
	return parseTraeCachedModel((Array.isArray(document[functionName]) ? document[functionName] : []).find((item) => typeof item === "object" && item !== null && item.name === modelName));
}
//#endregion
//#region src/raw-resolver.ts
/** Resolve current desktop identity and safe cached model config for capability probing. */
async function resolveTraeRawRuntime(store, modelName) {
	const credential = await store.resolve();
	const candidate = store.candidates().find((item) => item.edition === credential.edition);
	if (candidate === void 0) throw new Error(`no Trae ${credential.edition} storage candidate for Raw Chat identity`);
	const identity = await readTraeIdentity(candidate);
	const cached = credential.edition === "cn" ? await readTraeCachedModel("solo_agent", modelName, credential.userId).catch(() => void 0) : void 0;
	return {
		identity,
		runtime: buildTraeRawChatRuntimeConfig(modelName, cached, {
			passBackReasoning: true,
			nativeFunctionCall: cached?.customConfig?.["native_function_call"] === true,
			useV2Process: cached?.customConfig?.["use_v2_process"] === true
		})
	};
}
//#endregion
//#region src/delegating-upstream.ts
/** Stable shim dependency whose delegate can be replaced after async setup. */
var TraeDelegatingUpstreamClient = class {
	delegate;
	constructor(delegate) {
		this.delegate = delegate;
	}
	replace(delegate) {
		this.delegate = delegate;
	}
	chatStream(bodyJson, signal) {
		return this.delegate.chatStream(bodyJson, signal);
	}
};
//#endregion
//#region src/usage.ts
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
const TRAE_PAY_BASE = "https://api.trae.cn";
function asNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function parseUsageSnapshot(payload) {
	const summaryRaw = payload["usage_summary"];
	const summary = {
		totalAmount: asNumber(summaryRaw?.["total_amount"]) ?? 0,
		consumedAmount: asNumber(summaryRaw?.["consumed_amount"]) ?? 0,
		consumptionRatio: asNumber(summaryRaw?.["consumption_ratio"]) ?? 0
	};
	const trial = payload["trial_status"];
	const packs = [];
	const rawPacks = Array.isArray(payload["user_entitlement_pack_list"]) ? payload["user_entitlement_pack_list"] : [];
	for (const raw of rawPacks) {
		if (typeof raw !== "object" || raw === null) continue;
		const pack = raw;
		const base = pack["entitlement_base_info"];
		const quota = base?.["quota"];
		const usage = pack["usage"];
		const packageQuota = ((base?.["product_extra"])?.["package_extra"])?.["quota"];
		const creditsLimit = asNumber(packageQuota?.["credits_limit"]) ?? asNumber(quota?.["credits_limit"]);
		const consumedCredits = asNumber(usage?.["credits_amount"]);
		const availableEndpoint = asNumber(base?.["available_endpoint"]);
		packs.push({
			displayDesc: typeof pack["display_desc"] === "string" ? pack["display_desc"] : "",
			entitlementId: typeof base?.["entitlement_id"] === "string" ? base["entitlement_id"] : "",
			endTimeMs: asNumber(base?.["end_time"]) ?? 0,
			currency: asNumber(base?.["currency"]) ?? 0,
			...availableEndpoint === void 0 ? {} : { availableEndpoint },
			...creditsLimit === void 0 ? {} : { creditsLimit },
			...consumedCredits === void 0 ? {} : { consumedCredits }
		});
	}
	return {
		isCreditsBilling: payload["is_credits_billing"] === true,
		isDollarUsageBilling: payload["is_dollar_usage_billing"] === true,
		isPayFreshman: payload["is_pay_freshman"] === true,
		inTrial: trial?.["is_in_trial"] === true,
		trialEndTimeMs: asNumber(trial?.["trial_end_time"]) ?? 0,
		summary,
		packs
	};
}
/**
* A read-only client for the verified Trae usage/credits endpoints.
* All methods are safe to call from a plugin and never mutate account state.
*/
var TraeUsageClient = class {
	options;
	fetchImpl;
	baseUrl;
	timeoutMs;
	constructor(options) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.baseUrl = options.baseUrl;
		this.timeoutMs = options.timeoutMs ?? 3e4;
	}
	/** Region of the current credential; `cn` when unresolvable. */
	async currentRegion() {
		const credential = await this.options.credential();
		return credential === void 0 ? "cn" : regionOfCredential(credential);
	}
	/**
	* Pay base for the current credential's region. An explicit baseUrl (tests,
	* diagnostics) pins the endpoint; otherwise CN uses `api.trae.cn` and the
	* international region its own verified pay gateway.
	*/
	async payBase() {
		return this.baseUrl ?? REGION_GATEWAYS[await this.currentRegion()].pay;
	}
	async authedHeaders() {
		const credential = await this.options.credential();
		if (credential === void 0 || credential.accessToken === "") throw new Error("Trae credential is not available; cannot query usage");
		const origin = await this.currentRegion() === "ai" ? "https://www.trae.ai" : "https://www.trae.cn";
		return {
			"Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": "Mozilla/5.0",
			"Origin": origin,
			"Referer": `${origin}/`
		};
	}
	async post(path, data, signal) {
		const headers = await this.authedHeaders();
		const response = await this.fetchImpl(`${await this.payBase()}${path}`, {
			method: "POST",
			headers,
			body: JSON.stringify(data),
			signal: signal ?? AbortSignal.timeout(this.timeoutMs)
		});
		if (!response.ok) throw new Error(`Trae usage endpoint ${path} returned HTTP ${response.status}`);
		return await response.json();
	}
	/**
	* Subscription/pay status of an international (ai) account. The CN region
	* never calls this (its contract is unverified there); the ai region uses
	* this instead of the Work-credit `snapshot`.
	*/
	async payStatus(signal) {
		if (await this.currentRegion() !== "ai") throw new Error("Trae pay status is only available for the international (ai) region");
		const payload = await this.post("/trae/api/v1/pay/ide_user_pay_status", {}, signal);
		const flag = (key) => payload[key] === true;
		const trial = typeof payload["trial_status"] === "object" && payload["trial_status"] !== null ? payload["trial_status"] : {};
		const fissionStart = asNumber(payload["solo_fission_start_time"]);
		const fissionExpire = asNumber(payload["solo_fission_expire_time"]);
		const fissionMax = asNumber(payload["solo_fission_max_usage"]);
		return {
			isDollarUsageBilling: flag("is_dollar_usage_billing"),
			hasPackage: flag("has_package"),
			isPayFreshman: flag("is_pay_freshman") || flag("is_pay_freshman_v2"),
			inTrial: trial["is_in_trial"] === true,
			trialEndTimeMs: asNumber(trial["trial_end_time"]) ?? 0,
			enableSoloLite: flag("enable_solo_lite"),
			enableSoloBuilder: flag("enable_solo_builder"),
			enableSoloCoder: flag("enable_solo_coder"),
			enableSoloWeb: flag("enable_solo_web"),
			...fissionStart === void 0 || fissionExpire === void 0 || fissionMax === void 0 ? {} : { fission: {
				startTimeMs: fissionStart,
				expireTimeMs: fissionExpire,
				maxUsage: fissionMax
			} }
		};
	}
	/**
	* The Work-credit endpoints are CN-only. The international region is
	* subscription-based and must read {@link payStatus} instead; guarding here
	* keeps the card's degraded `creditsError` message diagnosable rather than
	* letting an ai credential hit an unverified path on its pay gateway.
	*/
	async requireCnRegion(method) {
		if (await this.currentRegion() !== "cn") throw new Error(`Trae ${method} is only available for the CN region; the international (ai) region uses payStatus`);
	}
	/** Total entitlements / credits and per-pack breakdown. */
	async snapshot(signal) {
		await this.requireCnRegion("usage snapshot");
		return parseUsageSnapshot(await this.post("/trae/api/v2/pay/web_user_ent_usage", { require_usage: true }, signal));
	}
	/** Daily check-in status. */
	async checkinStatus(signal) {
		await this.requireCnRegion("check-in status");
		const payload = await this.post("/trae/api/v2/ug/checkin_credits/status", {}, signal);
		return {
			checkedIn: payload["checked_in"] === true,
			credits: asNumber(payload["credits"]) ?? 0,
			enabled: payload["enable"] !== false
		};
	}
	/** Rewards / activity rules. */
	async activities(signal) {
		await this.requireCnRegion("activities");
		const payload = await this.post("/trae/api/v2/ug/activity/info", {}, signal);
		const rawActivities = Array.isArray(payload["commercial_activities"]) ? payload["commercial_activities"] : [];
		const activities = [];
		for (const raw of rawActivities) {
			if (typeof raw !== "object" || raw === null) continue;
			const rule = raw;
			activities.push({
				activityId: typeof rule["activity_id"] === "string" ? rule["activity_id"] : "",
				enabled: rule["Enabled"] === true,
				activityType: asNumber(rule["activity_type"]) ?? 0,
				startTimeMs: asNumber(rule["start_time_ms"]) ?? 0,
				endTimeMs: asNumber(rule["end_time_ms"]) ?? 0,
				...rule["work_extra"] === void 0 ? {} : { workExtra: rule["work_extra"] }
			});
		}
		return activities;
	}
	/** Convenience: snapshot + check-in + activities in one call (best-effort, non-fatal on missing). */
	async view(signal) {
		const [snapshot, checkin, activities] = await Promise.all([
			this.snapshot(signal),
			this.checkinStatus(signal),
			this.activities(signal)
		]);
		return {
			snapshot,
			checkin,
			activities
		};
	}
};
//#endregion
//#region src/status-paths.ts
/** Plugin-owned usage endpoint consumed by its browser half. */
const TRAE_USAGE_PATH = "/plugins/dsh-connect-trae/usage";
/** Plugin-owned live model refresh endpoint. */
const TRAE_MODELS_REFRESH_PATH = "/plugins/dsh-connect-trae/models/refresh";
/** Plugin-owned local account rescan endpoint. */
const TRAE_ACCOUNTS_REFRESH_PATH = "/plugins/dsh-connect-trae/accounts/refresh";
/** Query parameter naming the region a card request addresses. */
const TRAE_REGION_PARAM = "region";
/** Every region, in card tab order. */
const TRAE_REGIONS = ["cn", "ai"];
/**
* Address one region's status route. The two regions are separate provider
* stacks; every card request carries the region whose tab the user is on.
*/
function withTraeRegion(path, region) {
	return `${path}?${TRAE_REGION_PARAM}=${region}`;
}
/**
* Read the region parameter off a status-route URL. Absent means the domestic
* tab (`cn`); a present-but-unknown value returns undefined so the route can
* answer 400 instead of guessing.
*/
function regionOfTraeStatusUrl(url) {
	const at = url.indexOf("?");
	const value = at === -1 ? null : new URLSearchParams(url.slice(at + 1)).get(TRAE_REGION_PARAM);
	if (value === null || value === "") return "cn";
	return TRAE_REGIONS.includes(value) ? value : void 0;
}
//#endregion
//#region src/web-status.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Loopback browser origins only; other devices are refused until trusted origins exist. */
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}
/** Map the credit snapshot to the card's compact credit document. */
function toCredits(snapshot) {
	const { totalAmount, consumedAmount } = snapshot.summary;
	const credit = (value) => Math.round(value * 1e4) / 1e4;
	const accounts = snapshot.packs.map((pack) => ({
		displayDesc: pack.displayDesc,
		remain: credit(Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumedCredits ?? 0))),
		size: pack.creditsLimit ?? 0
	}));
	const remaining = (endpoint) => snapshot.packs.filter((pack) => pack.availableEndpoint === endpoint).reduce((sum, pack) => credit(sum + Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumedCredits ?? 0))), 0);
	return {
		total: totalAmount,
		consumed: consumedAmount,
		available: totalAmount - consumedAmount,
		workAvailable: remaining(1),
		generalAvailable: remaining(0),
		accounts
	};
}
/**
* Assemble one region's card document. `region` is the tab the card is on; the
* region-scoped store already answers with only that region's accounts, so the
* document's model slots and account list are that region's by construction.
* Sign-in state is read-only; credit is a live billing answer whose failure
* degrades to `creditsError` rather than failing the whole document.
*/
async function traeWebUsage(deps, region) {
	const store = deps.store(region);
	const accounts = await store.accounts();
	if ((await store.status()).state !== "signed-in") {
		const { failures } = await store.diagnose();
		return {
			status: "signed-out",
			accounts,
			searched: failures.map((failure) => ({
				path: failure.path,
				edition: failure.edition,
				source: failure.source,
				reason: failure.reason,
				...failure.message === void 0 ? {} : { message: safeMessage(failure.message) }
			}))
		};
	}
	let credential;
	try {
		credential = await store.resolve();
	} catch (error) {
		return {
			status: "signed-out",
			accounts,
			message: safeMessage(error)
		};
	}
	const account = {
		accountId: accounts.find((item) => item.selected)?.id ?? "",
		accountName: credential.accountName ?? credential.userId,
		tokenExpiresAtMs: credential.expiresAtMs,
		region,
		accounts,
		models: deps.displayModels(region).map((model) => ({
			...model,
			...model.input === void 0 ? {} : { input: [...model.input] }
		})),
		enabledModelIds: [...deps.enabledModelIds(region)],
		...deps.rawDiagnostic === void 0 ? {} : { rawChat: deps.rawDiagnostic(region) }
	};
	const client = deps.client(region);
	if (region === "ai") try {
		const payStatus = await client.payStatus();
		return {
			status: "signed-in",
			...account,
			payStatus
		};
	} catch (error) {
		return {
			status: "signed-in",
			...account,
			payStatusError: safeMessage(error)
		};
	}
	try {
		const snapshot = await client.snapshot();
		return {
			status: "signed-in",
			...account,
			credits: toCredits(snapshot)
		};
	} catch (error) {
		return {
			status: "signed-in",
			...account,
			creditsError: safeMessage(error)
		};
	}
}
/**
* The region a request addresses, or a 400 answer. Absent parameter means the
* domestic tab; an unknown value is refused rather than guessed.
*/
function requestRegion(req, res) {
	const region = regionOfTraeStatusUrl(req.url ?? "/");
	if (region === void 0) {
		json(res, 400, { error: "unknown region" });
		return;
	}
	return region;
}
/** Mount the GET usage route on an optional webServer context. */
function registerTraeUsageRoute(ctx, deps) {
	ctx.effect(() => {
		const disposeUsage = ctx.webServer.register({
			kind: "exact",
			path: TRAE_USAGE_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				if (!loopbackOrigin(req)) {
					json(res, 403, { error: "origin-not-trusted" });
					return;
				}
				const region = requestRegion(req, res);
				if (region === void 0) return;
				try {
					json(res, 200, await traeWebUsage(deps, region));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeAccounts = ctx.webServer.register({
			kind: "exact",
			path: TRAE_ACCOUNTS_REFRESH_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				const region = requestRegion(req, res);
				if (region === void 0) return;
				try {
					json(res, 200, { accounts: await deps.store(region).accounts() });
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeRefresh = ctx.webServer.register({
			kind: "exact",
			path: TRAE_MODELS_REFRESH_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.discoverModels === void 0) return json(res, 503, { error: "model refresh unavailable" });
				const region = requestRegion(req, res);
				if (region === void 0) return;
				try {
					json(res, 200, { models: await deps.discoverModels(region) });
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		return () => {
			disposeRefresh();
			disposeAccounts();
			disposeUsage();
		};
	}, "dsh-connect-trae: Web usage route");
}
//#endregion
//#region src/model-config.ts
/**
* Parse a secret-free CustomModel debug line emitted by Trae. Optional values
* remain absent when Trae prints None; we must not invent defaults for them.
*/
function parseObservedModelConfig(line) {
	const match = /model_info: CustomModel \{([\s\S]*?)\}\s*(?:trace_id|$)/.exec(line);
	if (match === null) return void 0;
	const body = match[1] ?? "";
	const stringField = (name) => new RegExp(`${name}: "([^"]+)"`).exec(body)?.[1];
	const optionalField = (name) => new RegExp(`${name}: Some\\("([^"]+)"\\)`).exec(body)?.[1];
	const configName = stringField("config_name");
	const modelName = stringField("model_name");
	if (configName === void 0 || modelName === void 0) return void 0;
	const promptSet = optionalField("prompt_set");
	const rawChatFunction = optionalField("raw_chat_function");
	const abVersion = optionalField("ab_versions");
	return {
		configName,
		modelName,
		...promptSet === void 0 ? {} : { promptSet },
		...rawChatFunction === void 0 ? {} : { rawChatFunction },
		...abVersion === void 0 ? {} : { abVersion }
	};
}
//#endregion
//#region src/model-extra-config.ts
function positive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/** Parse only Raw Chat behavior switches observed in Trae's model_extra_config. */
function parseTraeRawChatBehaviorConfig(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const raw = value;
	const maxToolcallChars = positive(raw["v3_max_toolcall_chars"]);
	return {
		...typeof raw["pass_back_reasoning"] === "boolean" ? { passBackReasoning: raw["pass_back_reasoning"] } : {},
		...typeof raw["native_function_call"] === "boolean" ? { nativeFunctionCall: raw["native_function_call"] } : {},
		...typeof raw["use_v2_process"] === "boolean" ? { useV2Process: raw["use_v2_process"] } : {},
		...typeof raw["v2_max_mode_enabled"] === "boolean" ? { maxModeEnabled: raw["v2_max_mode_enabled"] } : {},
		...maxToolcallChars === void 0 ? {} : { maxToolcallChars },
		...typeof raw["v3_stream_throttle_enabled"] === "boolean" ? { streamThrottleEnabled: raw["v3_stream_throttle_enabled"] } : {}
	};
}
/** Extract the JSON object from one native model_extra_config parse log line. */
function parseTraeModelExtraConfigLogLine(line) {
	const at = line.indexOf(", raw: ");
	if (at === -1) return void 0;
	const candidate = line.slice(at + 7).trim();
	try {
		return parseTraeRawChatBehaviorConfig(JSON.parse(candidate));
	} catch {
		return;
	}
}
//#endregion
//#region src/model-detail.ts
const TRAE_MODEL_DETAIL_PATH = "/api/ide/v1/batch_get_detail_param";
const TRAE_MODEL_DETAIL_FUNCTIONS = [
	"ui_builder_v2",
	"solo_coder",
	"chat_v3",
	"solo_builder",
	"builder_v3",
	"builder",
	"chat",
	"inline_chat",
	"git_ai",
	"custom_agent_generation",
	"utils",
	"code_reviewer",
	"code_review_summary",
	"solo_agent",
	"solo_agent_remote",
	"solo_work_remote",
	"solo_agent_lite",
	"solo_work_lite",
	"solo_design_lite",
	"solo_design_remote",
	"multimodal",
	"system_diagnosis"
];
/** Build the exact request shape observed in successful current Trae CN logs. */
function buildTraeModelDetailRequest(configName = "", custom = false) {
	return {
		functions: [...TRAE_MODEL_DETAIL_FUNCTIONS],
		agent_type: configName === "" ? "" : "solo_agent",
		current_config_info: {
			config_name: configName,
			is_custom_model: custom
		},
		mode_type: 0,
		access_type: 0,
		ab_force_vids: "",
		ab_autotest_advanced_mode: 0
	};
}
//#endregion
//#region src/raw-envelope.ts
/** Stable JSON hash candidate used by the native DTO's arg/args_hash fields. */
function hashTraeRawChatArg(arg) {
	return createHash("sha256").update(JSON.stringify(arg)).digest("hex");
}
/**
* Evidence-bounded fusion envelope candidate. The native DTO exposes exactly
* arg/args_hash/config_json, but the hash algorithm and config_json contents
* remain candidates until a live response validates them.
*/
function buildTraeFusionRawChatEnvelope(arg, config) {
	return {
		arg: structuredClone(arg),
		args_hash: hashTraeRawChatArg(arg),
		config_json: JSON.stringify(config)
	};
}
//#endregion
//#region src/upstream.ts
/**
* Safe first-stage upstream. Real Trae traffic stays disabled until one
* edition-specific endpoint and wire codec are verified with fixtures.
*/
var UnconfiguredTraeUpstreamClient = class {
	async chatStream(_bodyJson, _signal) {
		return {
			ok: false,
			status: 503,
			kind: "unconfigured",
			message: "Trae upstream protocol is not configured; complete offline protocol verification first"
		};
	}
};
//#endregion
//#region src/index.ts
const name = "dsh-connect-trae";
const inject = ["llm"];
/**
* Settings namespace, as a plain lowercase literal. DSH 0.1.2 removed the
* `settingsNamespace` brand constructor from the npm package (the Desktop
* host still ships it as a legacy shim), and every consumer of this constant —
* `registerModelDiscovery`, `registerConfigurableProviders`,
* `settings.installSection`, the settings test — takes it as a kebab string,
* so no branding is needed for either host generation.
*/
const TRAE_SETTINGS_NS = "trae";
/**
* One region's saved state. A config written before the region split has only
* the flat fields: those were always captured from the CN endpoint (the
* plugin had no international support), so they are read as the CN state and
* only when no explicit CN slot exists. The ai region never inherits them —
* that inheritance is exactly the bug where a stale CN directory would be
* intersected with the international catalog and silently drop the user's
* picks (the same failure workbuddy fixed with its region split).
*/
function regionStateOf(config, region) {
	const stored = config.regions?.[region];
	if (stored !== void 0) return stored;
	if (region !== "cn") return {};
	return {
		...config.lastCatalog === void 0 ? {} : { lastCatalog: config.lastCatalog },
		...config.enabledModelIds === void 0 ? {} : { enabledModelIds: config.enabledModelIds },
		...config.imageModelIds === void 0 ? {} : { imageModelIds: config.imageModelIds },
		...config.contextBudgets === void 0 ? {} : { contextBudgets: config.contextBudgets }
	};
}
const modelConfig = z.object({
	id: z.string().required(),
	name: z.string().required(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	input: z.array(z.union(["text", "image"])),
	creditMultiplier: z.number(),
	wireFunction: z.string()
});
const regionStateConfig = z.object({
	lastCatalog: z.array(modelConfig).default([]),
	enabledModelIds: z.array(z.string()).default([]),
	imageModelIds: z.array(z.string()).default([]),
	contextBudgets: z.dict(z.number().step(1).min(1)).default({})
});
const accountSelectionConfig = z.object({
	cn: z.string().description("Selected domestic (CN) account id (never a token)"),
	ai: z.string().description("Selected international account id (never a token)")
});
const Config = z.object({
	authFile: z.string().description("Optional Trae storage.json path override"),
	edition: z.union([
		"auto",
		"cn",
		"sg",
		"solo",
		"solo-sg"
	]).default("auto").description("Trae edition hint"),
	accountId: z.string().description("Deprecated: pre-split account selector, attributed to its own region"),
	accounts: accountSelectionConfig.description("Per-region account selections, keyed cn | ai"),
	regions: z.dict(regionStateConfig).default({}).description("Per-region model directory and selection, keyed cn | ai"),
	lastCatalog: z.array(modelConfig).description("Deprecated: pre-region-split CN model directory"),
	enabledModelIds: z.array(z.string()).default([]).description("Deprecated: pre-region-split CN selection"),
	contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description("Deprecated: pre-region-split CN context budgets"),
	imageModelIds: z.array(z.string()).default([]).description("Deprecated: pre-region-split CN image opt-in"),
	models: z.array(modelConfig).description("Legacy generated Trae model list")
});
/** Every region, in card tab order. */
const REGION_KEYS = ["cn", "ai"];
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
const SHIM_BIND_TIMEOUT_MS = 5e3;
function apply(ctx, config) {
	let current = () => config;
	/**
	* Render an unknown thrown value as one readable line. Plugin degradation
	* messages must carry the real cause — a swallowed reason is what turns a
	* five-second diagnosis into an afternoon of guessing.
	*/
	const reasonText = (error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
	const registerEffect = (effect, label, fallback) => {
		try {
			ctx.effect(effect, label);
		} catch (error) {
			ctx.logger.warn(`dsh-connect-trae: could not register the "${label}" cleanup; running it immediately`, reasonText(error));
			fallback?.();
		}
	};
	const enabledSet = (value, region) => new Set(regionStateOf(value, region).enabledModelIds ?? []);
	const imageSet = (value, region) => new Set(regionStateOf(value, region).imageModelIds ?? []);
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
	const wireState = {};
	for (const region of REGION_KEYS) wireState[region] = {
		callableKeys: /* @__PURE__ */ new Set(),
		resolved: false,
		byId: /* @__PURE__ */ new Map(),
		byName: /* @__PURE__ */ new Map()
	};
	const dropDeadModels = (rows, region) => {
		const wire = wireState[region];
		if (!wire.resolved) return rows;
		return rows.filter((model) => wire.callableKeys.has(model.id.trim().toLowerCase()) || wire.callableKeys.has(model.name.trim().toLowerCase()));
	};
	const fallbackModels = (value, region) => applyImageSelection(fallbackModelsFor(region), imageSet(value, region));
	const derive = (value, raw, region) => {
		const selectedImages = imageSet(value, region);
		const derived = deriveCatalog(applyImageSelection(sanitizeCatalog(dropDeadModels(raw, region)), selectedImages), enabledSet(value, region), regionStateOf(value, region).contextBudgets ?? {});
		return derived.length > 0 ? derived : fallbackModels(value, region);
	};
	const configuredModels = (value, region) => {
		const state = regionStateOf(value, region);
		return state.lastCatalog?.length ? derive(value, state.lastCatalog, region) : region === "cn" && value.models?.length ? derive(value, value.models, region) : fallbackModels(value, region);
	};
	const displayModels = (value, region) => {
		const state = regionStateOf(value, region);
		return state.lastCatalog?.length ? dropDeadModels(sanitizeCatalog(state.lastCatalog), region) : region === "cn" && value.models?.length ? dropDeadModels(sanitizeCatalog(value.models), region) : fallbackModelsFor(region);
	};
	/**
	* Legacy migration for the pre-split single `accountId`: its region is
	* resolved once from the local account scan and the selection is then
	* attributed to that region ONLY — the other region keeps its documented
	* default (first discovered account of that region) instead of silently
	* inheriting a selection that belongs to the other side of the split.
	*/
	let legacyAccountRegion;
	const effectiveAccountFor = (region, value) => {
		const explicit = value.accounts?.[region];
		if (explicit !== void 0) return explicit;
		return legacyAccountRegion === region ? value.accountId : void 0;
	};
	/**
	* Retry a directory read once. The gateways answer an intermittent 401 for a
	* credential that works moments later (observed 2026-09-15), and a failed
	* skeleton read would otherwise drop the runtime catalog back to the saved
	* snapshot — hiding every model added since that save (issue #7's glm-5.3
	* among them).
	*/
	async function withDirectoryRetry(read) {
		try {
			return await read();
		} catch (first) {
			await new Promise((resolve) => setTimeout(resolve, 800));
			try {
				return await read();
			} catch {
				throw first;
			}
		}
	}
	const stacks = {};
	for (const region of REGION_KEYS) {
		const catalog = new TraeCatalog(region);
		const wire = wireState[region];
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
			let preferred;
			try {
				preferred = (await store.current())?.edition;
			} catch {}
			const hint = (config.edition !== void 0 && config.edition !== "auto" ? config.edition : void 0) ?? preferred;
			return resolveTraeIdentity(config.authFile === void 0 ? traeStorageCandidates().filter((item) => item.source === "desktop" && (hint !== void 0 ? item.edition === hint : regionOfEdition(item.edition) === region)) : [{
				edition: hint ?? (region === "ai" ? "sg" : "solo"),
				path: config.authFile,
				source: "desktop"
			}], hint ?? (region === "ai" ? "solo-sg" : "cn"));
		};
		/**
		* Resolution failures degrade to omitting DeviceInfo (its being required
		* is unverified, docs/INTL_SG_EVIDENCE.md §5) rather than failing the
		* refresh.
		*/
		const refreshDeviceSafe = async () => {
			try {
				const value = await identity();
				return {
					deviceId: value.deviceId,
					machineId: value.machineId
				};
			} catch {
				return;
			}
		};
		const store = new TraeCredentialStore({
			region,
			...config.authFile === void 0 ? {} : { storagePath: config.authFile },
			edition: config.edition ?? "auto",
			refresh: async (credential) => refreshTraeCredential(credential, void 0, await refreshDeviceSafe())
		});
		const solo = new TraeSoloUpstreamClient({
			credential: () => store.resolve(),
			identity,
			log: (message, detail) => ctx.logger.warn(message, detail)
		});
		const remoteCatalog = new TraeSoloRemoteCatalogClient({ credential: () => store.resolve() });
		const wireResolver = (displayId) => wire.byId.get(displayId) ?? wire.byName.get(displayId.trim().toLowerCase());
		const upstream = new TraeSoloBridge(solo, catalog, wireResolver);
		const delegating = new TraeDelegatingUpstreamClient(upstream);
		const shim = createTraeShim({
			catalog,
			client: delegating,
			logger: ctx.logger
		});
		let rawDiagnostic = () => ({ state: "disabled" });
		if (region === "cn") (async () => {
			try {
				const resolved = await resolveTraeRawRuntime(store, "qwen-3.7-plus");
				const gateway = createTraeRawGateway({
					raw: new TraeRawChatUpstreamClient({
						credential: () => store.resolve(),
						identity: async () => resolved.identity,
						config: {
							model: resolved.runtime.modelName,
							configName: resolved.runtime.configName,
							passBackReasoning: true,
							runtime: resolved.runtime
						}
					}),
					solo: upstream,
					endpoint: `${REGION_GATEWAYS.cn.chat}/api/ide/v2/llm_raw_chat`,
					edition: resolved.identity.edition,
					identity: {
						appVersion: resolved.identity.appVersion ?? "",
						buildVersion: resolved.identity.buildVersion ?? ""
					},
					runtime: resolved.runtime,
					enabled: false
				});
				delegating.replace(gateway.upstream);
				rawDiagnostic = () => gateway.diagnostic();
				registerEffect(() => () => gateway.invalidate(), "dsh-connect-trae: Raw capability invalidation");
			} catch (error) {
				ctx.logger.warn("dsh-connect-trae: Raw gateway unavailable; continuing with native SOLO tool-call channel", error);
			}
		})();
		stacks[region] = {
			region,
			store,
			catalog,
			shim,
			delegating,
			usageClient: new TraeUsageClient({ credential: () => store.resolve() }),
			discoverModels: async (signal) => {
				const merged = mergeTraeModelSources(await withDirectoryRetry(() => remoteCatalog.fetchModels(signal)), await solo.fetchModels(signal));
				wire.callableKeys.clear();
				for (const model of merged) {
					wire.callableKeys.add(model.id.trim().toLowerCase());
					wire.callableKeys.add(model.name.trim().toLowerCase());
				}
				wire.resolved = merged.length > 0;
				wire.byId.clear();
				wire.byName.clear();
				for (const model of merged) if (model.wireConfigName !== void 0) {
					const target = {
						configName: model.wireConfigName,
						...model.wireFunction === void 0 ? {} : { function: model.wireFunction }
					};
					wire.byId.set(model.id, target);
					wire.byName.set(model.name.trim().toLowerCase(), target);
				}
				return merged;
			},
			invalidateAdapter: () => {},
			rawDiagnostic: () => rawDiagnostic()
		};
	}
	ctx.inject(["webServer"], (webCtx) => registerTraeUsageRoute(webCtx, {
		store: (region) => stacks[region].store,
		client: (region) => stacks[region].usageClient,
		displayModels: (region) => displayModels(current(), region),
		enabledModelIds: (region) => regionStateOf(current(), region).enabledModelIds ?? [],
		discoverModels: (region, signal) => stacks[region].discoverModels(signal),
		rawDiagnostic: (region) => stacks[region].rawDiagnostic()
	}));
	/** Push the current config into every region's store selection and catalog. */
	const applySelection = (value) => {
		for (const region of REGION_KEYS) {
			const stack = stacks[region];
			stack.store.setSource(value.authFile, value.edition ?? "auto", effectiveAccountFor(region, value));
			stack.catalog.set(configuredModels(value, region));
			stack.invalidateAdapter();
		}
	};
	const sectionHooks = {
		setSource(source) {
			current = source;
		},
		onChange() {
			applySelection(current());
		}
	};
	applySelection(config);
	(async () => {
		const id = current().accountId;
		if (id === void 0) return;
		try {
			for (const region of REGION_KEYS) if ((await stacks[region].store.accounts()).some((account) => account.id === id)) {
				legacyAccountRegion = region;
				applySelection(current());
				return;
			}
		} catch {}
	})();
	const legacyInstallSettingsSection = dshSettings.installSettingsSection;
	if (typeof legacyInstallSettingsSection === "function") legacyInstallSettingsSection(ctx, TRAE_SETTINGS_NS, Config, config, sectionHooks);
	else ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, TRAE_SETTINGS_NS, Config, config, sectionHooks);
	});
	let stopped = false;
	registerEffect(() => () => {
		stopped = true;
		for (const region of REGION_KEYS) stacks[region].shim.close();
	}, "dsh-connect-trae: loopback shim shutdown");
	/**
	* Wait until one region's loopback shim is actually bound, or give up after
	* `timeoutMs` with a warning.
	*
	* This is the gate the adapter's `baseUrl` precondition depends on: it is the
	* only place that may conclude "this region has a port". A failure is
	* reported and mapped to `false`, never thrown — a listener that will not
	* bind must degrade its own region, not the boot.
	*/
	const shimListening = async (region) => {
		const shim = stacks[region].shim;
		const listening = await shim.whenListening(SHIM_BIND_TIMEOUT_MS);
		if (!listening) ctx.logger.warn(`dsh-connect-trae: the ${region} loopback shim did not bind within ${SHIM_BIND_TIMEOUT_MS}ms; the ${TRAE_PROVIDERS[region]} provider stays unregistered (other providers are unaffected)`, shim.reason());
		return listening;
	};
	/**
	* Build and register one region's provider route.
	*
	* Scoped per region on purpose: the two stacks are independent, and a failure
	* on one side (no credentials, an image-less catalog, a rejected route) must
	* not take the other side down with it. Returns the release handle, or
	* `undefined` after reporting why this region is unavailable.
	*/
	const registerRegionProvider = (region) => {
		const stack = stacks[region];
		try {
			const trae = createTraeAdapter({
				baseUrl: stack.shim.baseUrl(),
				apiKey: stack.shim.token(),
				catalog: stack.catalog,
				provider: TRAE_PROVIDERS[region],
				displayName: TRAE_PROVIDER_DISPLAY_NAMES[region],
				resolveAttachments: () => ctx.get("attachments")
			});
			const release = ctx.llm.registerAdapter([TRAE_PROVIDERS[region]], trae.adapter);
			stack.invalidateAdapter = () => {
				trae.invalidate();
			};
			return release;
		} catch (error) {
			ctx.logger.warn(`dsh-connect-trae: the ${TRAE_PROVIDERS[region]} provider could not be registered; its models stay unavailable while every other provider keeps working`, reasonText(error));
			return;
		}
	};
	/**
	* One activation pass: bind gate, provider routes, directory metadata, then
	* the background seed.
	*
	* Every failure mode below is contained and reported. Nothing in this
	* function may reject: the caller has no way to recover, and a rejection here
	* is exactly what used to become an unhandled rejection and abort the entire
	* harness process.
	*/
	const boot = async () => {
		await Promise.all(REGION_KEYS.map(shimListening));
		if (stopped) return;
		const releases = [];
		for (const region of REGION_KEYS) {
			const release = registerRegionProvider(region);
			if (release !== void 0) releases.push(release);
		}
		const releaseAll = () => {
			releases.splice(0).forEach((release) => {
				release();
			});
		};
		registerEffect(() => releaseAll, "dsh-connect-trae: provider route registration", releaseAll);
		try {
			ctx.llm.registerModelDiscovery(TRAE_SETTINGS_NS, async (request, signal) => {
				const region = regionOfTraeProvider(request.provider ?? "");
				if (region === void 0) return [];
				const cancellation = signal ?? request.signal;
				return applyImageSelection(await stacks[region].discoverModels(cancellation), imageSet(current(), region)).map((model) => ({
					id: model.id,
					name: traeModelDisplayName(model),
					...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
					...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
					inputModalities: traeInputModalities(model)
				}));
			});
			const releaseDirectory = ctx.llm.registerConfigurableProviders(REGION_KEYS.map((region) => ({
				provider: TRAE_PROVIDERS[region],
				displayName: TRAE_PROVIDER_DISPLAY_NAMES[region],
				settingsNs: TRAE_SETTINGS_NS,
				settingsPath: [],
				declared: false
			})));
			releases.push(releaseDirectory);
		} catch (error) {
			ctx.logger.warn("dsh-connect-trae: the provider directory could not be registered; the routes keep serving while the model picker may show them as unconfigured", reasonText(error));
		}
		for (const region of REGION_KEYS) (async () => {
			const stack = stacks[region];
			try {
				const models = await stack.discoverModels();
				if (stopped) return;
				stack.catalog.set(derive(current(), models, region));
			} catch (error) {
				if (stopped) return;
				ctx.logger.warn(`dsh-connect-trae: live ${region} model directory unavailable; serving the configured catalog`, reasonText(error));
				stack.catalog.set(configuredModels(current(), region));
			}
			stack.invalidateAdapter();
		})().catch((error) => {
			ctx.logger.warn(`dsh-connect-trae: the ${region} startup catalog seed failed`, reasonText(error));
		});
	};
	boot().catch((error) => {
		ctx.logger.warn("dsh-connect-trae: startup did not complete; the plugin is mounted but its providers may be unavailable (the rest of the harness is unaffected)", reasonText(error));
	});
}
//#endregion
export { Config, FALLBACK_TRAE_MODELS, FALLBACK_TRAE_MODELS_AI, REGION_GATEWAYS, SseDecoder, TRAE_AI_PROVIDER, TRAE_CN_AGENT_TASK_PATH, TRAE_CN_TITLE_PATH, TRAE_MODEL_DETAIL_FUNCTIONS, TRAE_MODEL_DETAIL_PATH, TRAE_PAY_BASE, TRAE_PROVIDER, TRAE_PROVIDERS, TRAE_PROVIDER_DISPLAY_NAMES, TRAE_RAW_CHAT_V1_PATH, TRAE_RAW_CHAT_V2_PATH, TRAE_REASONING_EFFORTS, TRAE_REGIONS, TRAE_REGION_PARAM, TRAE_SETTINGS_NS, TRAE_SOLO_CHAT_PATH, TRAE_SOLO_FUNCTION, TRAE_SOLO_MODELS_PATH, TRAE_SOLO_REMOTE_BASE, TRAE_STREAM_IDLE_TIMEOUT_MS, TRAE_USAGE_PATH, TRAE_VERSION_CODE_FALLBACK, TraeCatalog, TraeCredentialStore, TraeDelegatingUpstreamClient, TraeFallbackUpstreamClient, TraeGatedUpstreamClient, TraeRawCapabilityController, TraeRawCapabilityState, TraeRawChatUpstreamClient, TraeSoloBridge, TraeSoloRemoteCatalogClient, TraeSoloUpstreamClient, TraeUsageClient, UnconfiguredTraeUpstreamClient, apply, applyContextBudgets, applyImageSelection, applyReasoningEffort, bridgeTraeSoloStream, buildTraeAgentTaskBody, buildTraeCnHeaders, buildTraeFusionRawChatEnvelope, buildTraeModelDetailRequest, buildTraeRawChatDraft, buildTraeRawChatRuntimeConfig, classifyTraeRawChatFailure, createTraeAdapter, createTraeRawGateway, createTraeShim, decodeRawChatChunk, decodeTraeEvent, decryptTraeStorageValue, deriveCatalog, discoveredCatalog, fallbackModelsFor, hashTraeRawChatArg, identityHeaders, inject, legacyTraeOwnAuthPath, mergeTraeModelSources, name, normalizeTraeCredential, normalizeTraeVersionCode, parseObservedModelConfig, parseReasoningCapability, parseTraeAuthValue, parseTraeCachedModel, parseTraeModelExtraConfigLogLine, parseTraeRawChatBehaviorConfig, parseTraeRemoteModel, parseTraeStorageDocument, pickTraeStorageIdentity, prepareSoloBody, probeTraeRawChatCapability, rawCapabilityDiagnostic, rawCapabilityFingerprint, readTraeCachedModel, readTraeCliIdentity, readTraeIdentity, refreshTraeCredential, regionOfCredential, regionOfEdition, regionOfHost, regionOfTraeProvider, regionOfTraeStatusUrl, regionOfUserRegion, regionStateOf, registerTraeUsageRoute, resolveTraeIdentity, resolveTraeRawRuntime, sanitizeCatalog, traeEndpoint, traeInputModalities, traeModelDisplayName, traeOwnAuthPath, traeRawChatExtraInfo, traeStorageCandidates, traeWebUsage, withTraeRegion };
