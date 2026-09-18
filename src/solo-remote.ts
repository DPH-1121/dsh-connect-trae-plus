import type { TraeCredential } from './auth.ts'
import { parseTraeRemoteModel, type TraeDiscoveredModel } from './model-metadata.ts'
import { REGION_GATEWAYS, regionOfCredential, type TraeRegion } from './region.ts'

export const TRAE_SOLO_REMOTE_BASE = 'https://solo.trae.cn/api/remote/v1'

export interface TraeSoloRemoteCatalogOptions {
  credential(): Promise<TraeCredential>
  fetchImpl?: typeof fetch
  baseUrl?: string
}

/**
 * Region-scoped request dressing. The CN portal is `solo.trae.cn` with the
 * CN locale headers; the international directory lives on the shared
 * `coresg-normal.trae.ai` gateway and was verified (2026-09-15) with the
 * English/Singapore headers — both forms are accepted, each region keeps the
 * shape its own portal sends.
 */
function remoteDressing(region: TraeRegion): { referer: string; timezone: string; language: string } {
  return region === 'ai'
    ? { referer: 'https://coresg-normal.trae.ai/', timezone: 'Asia/Singapore', language: 'en' }
    : { referer: 'https://solo.trae.cn/', timezone: 'Asia/Shanghai', language: 'zh-cn' }
}

/**
 * Read-only model catalog client for the SOLO Web API.
 *
 * This deliberately has no chat/session method: the Remote session protocol
 * only exposes a final answer and cannot preserve DSH's structured tool loop.
 */
export class TraeSoloRemoteCatalogClient {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string | undefined

  constructor(private readonly options: TraeSoloRemoteCatalogOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl
  }

  private async headers(region: TraeRegion): Promise<Record<string, string>> {
    const credential = await this.options.credential()
    const dressing = remoteDressing(region)
    return {
      'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
      'Content-Type': 'application/json',
      'x-trae-client-type': 'web',
      'x-trae-user-timezone': dressing.timezone,
      'x-preferenced-language': dressing.language,
      'Referer': dressing.referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  }

  async fetchModels(signal?: AbortSignal): Promise<TraeDiscoveredModel[]> {
    // The directory gateway follows the credential's own region; an explicit
    // baseUrl (tests, diagnostics) still pins the endpoint.
    const credential = await this.options.credential()
    const region = regionOfCredential(credential)
    const base = this.baseUrl ?? REGION_GATEWAYS[region].remote
    const headers = await this.headers(region)
    const response = await this.fetchImpl(`${base}/models?functions=solo_agent_remote,solo_work_remote`, { headers, signal: signal ?? AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`SOLO remote models returned HTTP ${response.status}`)
    const json = await response.json() as { code?: number; data?: { list?: { function?: string; models?: unknown[] }[] } }
    const groups = json.data?.list ?? []
    const preferred = groups.find(group => group.function === 'solo_agent_remote') ?? groups[0]
    const seen = new Set<string>()
    const models: TraeDiscoveredModel[] = []
    for (const raw of preferred?.models ?? []) {
      const model = parseTraeRemoteModel(raw)
      if (model === undefined || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
    if (models.length === 0) throw new Error('SOLO remote models response contained no models')
    return models
  }
}
