import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { TraeCatalog } from './catalog.ts'
import type { TraeUpstreamClient, TraeUpstreamErrorKind } from './upstream.ts'

export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface TraeShim {
  /**
   * Settles when the loopback listener is bound, or rejects when the bind
   * itself failed. Never rejects on its own otherwise.
   */
  ready: Promise<void>
  /**
   * True once the listener is bound and the port can no longer change. Read it
   * for a non-throwing readiness check; {@link TraeShim.baseUrl} remains the
   * throwing accessor.
   */
  readonly listening: boolean
  /**
   * Wait for the listener, bounded by `timeoutMs`. Resolves `true` when the
   * shim is bound, `false` when the bind failed or the deadline passed — it
   * never throws, so a caller can treat "no port yet" as an ordinary
   * degradation instead of an exception on the startup path.
   */
  whenListening(timeoutMs: number): Promise<boolean>
  /**
   * Why the bind failed, once {@link TraeShim.whenListening} has answered
   * `false`. `undefined` while the bind is still in flight or after it
   * succeeded — a caller reporting a degradation can name the real cause
   * instead of guessing.
   */
  reason(): unknown
  baseUrl(): string
  token(): string
  close(): Promise<void>
}

export interface TraeShimOptions {
  catalog: TraeCatalog
  client: TraeUpstreamClient
  logger?: ShimLogger
  /**
   * Loopback interface to bind. Defaults to `127.0.0.1`; a test that needs to
   * observe a *failed* bind can name an address the environment does not
   * provide (for example an unroutable one).
   */
  bindHost?: string
  /**
   * Loopback port to bind. Defaults to `0` (an ephemeral port), which is what
   * every production caller wants. A test that needs a deterministic bind
   * failure passes a port it already holds — that is the only supported use.
   */
  port?: number
}

const BODY_LIMIT = 64 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const STATUS_BY_KIND: Readonly<Record<TraeUpstreamErrorKind, number>> = {
  authentication: 401,
  hard_credit: 402,
  soft_rate: 429,
  not_found: 502,
  server: 502,
  client: 400,
  unconfigured: 503,
}

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

function hostIsLoopback(host: string | undefined): boolean {
  return host !== undefined && host.trim() !== '' && LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const hostname = new URL(origin).hostname
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createTraeShim(options: TraeShimOptions): TraeShim {
  const secret = randomBytes(32).toString('base64url')
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((req, res) => { void handle(req, res) })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  // Bound once, read many times. `binding` records the outcome of the single
  // bind this shim will ever perform; every readiness accessor below reads that
  // record instead of the server's live state, so none of them can turn a
  // startup race into an exception on the activation path.
  let boundPort: number | undefined
  let bindFailure: unknown
  let bindSettled = false
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        bindFailure = new Error('trae shim bound without a numeric port')
        bindSettled = true
        reject(bindFailure)
        return
      }
      boundPort = address.port
      bindSettled = true
      resolve()
    })
    server.once('error', (error: unknown) => {
      bindFailure = error
      bindSettled = true
      reject(error)
    })
  })
  // A rejected `ready` is meant to be observed (the boot path awaits it through
  // `whenListening`, which absorbs it), but a consumer that never looks would
  // otherwise surface it as an unhandled rejection — and DSH's fail-loud
  // handler turns exactly that into a dead process. Attaching a no-op catch to
  // a derived promise keeps `ready` itself intact for real awaiting while
  // guaranteeing the bare promise can never be the terminal event.
  void ready.catch(() => {})
  try {
    server.listen(options.port ?? 0, options.bindHost ?? '127.0.0.1')
  } catch (error: unknown) {
    // Invalid listen arguments throw synchronously; keep that a recorded bind
    // failure like any other so callers still only ever see a rejected `ready`.
    bindFailure = error
    bindSettled = true
  }

  /**
   * Wait for the bind, bounded by `timeoutMs`. Never throws and never hangs: a
   * failed bind resolves `false` immediately, and a bind that has not settled
   * by the deadline resolves `false` with the attempt still in flight. Returns
   * `true` only when {@link TraeShim.baseUrl} is safe to call.
   */
  function whenListening(timeoutMs: number): Promise<boolean> {
    if (bindSettled) return Promise.resolve(boundPort !== undefined)
    return new Promise<boolean>(resolve => {
      const settle = (value: boolean): void => {
        clearTimeout(timer)
        server.off('listening', onSettled)
        server.off('error', onSettled)
        resolve(value)
      }
      const onSettled = (): void => settle(boundPort !== undefined)
      const timer = setTimeout(() => settle(false), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      server.once('listening', onSettled)
      server.once('error', onSettled)
    })
  }

  function bearerOk(req: IncomingMessage): boolean {
    const match = typeof req.headers.authorization === 'string'
      ? /^Bearer\s+(.+)$/i.exec(req.headers.authorization.trim())
      : null
    if (match === null) return false
    const actual = Buffer.from(match[1] ?? '')
    const expected = Buffer.from(secret)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) return writeError(res, 403, 'host_not_allowed', 'Host must be loopback')
      if (!originIsLoopback(req.headers.origin)) return writeError(res, 403, 'origin_not_allowed', 'Origin must be loopback')
      if (!bearerOk(req)) return writeError(res, 401, 'unauthorized', 'Missing or invalid bearer')
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) return writeJson(res, 200, { ok: true })
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        return writeJson(res, 200, {
          object: 'list',
          data: options.catalog.current().map(model => ({ id: model.id, object: 'model', created: 0, owned_by: 'trae' })),
        })
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        if (typeof req.headers['content-type'] !== 'string' || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
          return writeError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
        }
        const raw = (await readBody(req)).toString('utf8')
        try { JSON.parse(raw) } catch { return writeError(res, 400, 'invalid_json', 'Request body must be valid JSON') }
        const parsed = JSON.parse(raw) as { model?: unknown; messages?: unknown[]; tools?: unknown[]; temperature?: unknown; reasoning_effort?: unknown; max_tokens?: unknown }
        options.logger?.warn('dsh-connect-trae: chat request received', {
          model: parsed.model,
          messages: Array.isArray(parsed.messages) ? parsed.messages.map(message => (typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['role'] ?? '?' : '?')) : '(none)',
          toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
          maxTokens: parsed.max_tokens,
          reasoningEffort: parsed.reasoning_effort,
          temperature: parsed.temperature,
          bodyBytes: raw.length,
        })
        const controller = new AbortController()
        const abort = (): void => controller.abort()
        req.once('aborted', abort)
        req.socket.once('close', abort)
        const result = await options.client.chatStream(raw, controller.signal)
        if (!result.ok) return writeError(res, STATUS_BY_KIND[result.kind], result.kind, result.message)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
        body.on('error', (error: unknown) => {
          const record = error instanceof Error
            ? { name: error.name, message: error.message, cause: error.cause ? String(error.cause) : undefined }
            : String(error)
          options.logger?.warn('dsh-connect-trae: upstream stream failed', record)
          if (!res.writableEnded) res.end()
        })
        body.pipe(res)
        return
      }
      writeError(res, 404, 'not_found', `No such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      options.logger?.error('dsh-connect-trae: shim request failed', error)
      if (!res.headersSent) writeError(res, 500, 'internal', 'Internal shim error')
      else if (!res.writableEnded) res.end()
    }
  }

  // Close idempotently. Disposal runs on a path that may interleave with a
  // bind that failed or is still in flight, and `server.close()` reports
  // "Server is not running" for a listener that never came up — a teardown
  // concern, not a caller-visible failure. The in-flight attempt is awaited so
  // a port that binds *after* close was requested is still released.
  let closeRequested: Promise<void> | undefined
  function close(): Promise<void> {
    closeRequested ??= (async () => {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) {
        await ready.catch(() => {})
        return
      }
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    })()
    return closeRequested
  }

  return {
    ready,
    get listening() { return boundPort !== undefined },
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
      if (boundPort === undefined) {
        throw new Error('trae shim is not listening; await shim.whenListening(...) before building a provider from it')
      }
      return `http://127.0.0.1:${boundPort}`
    },
    reason: () => bindFailure,
    token: () => secret,
    close,
  }
}
