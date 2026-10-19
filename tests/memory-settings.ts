import { Service, type Context, type Fiber } from '@deepseek-ai/cordis'

interface Registration<C> {
  ns: string
  base: C
  section: Record<string, unknown>
  hooks: {
    setSource(source: () => C): void
    onChange(): void
  }
}

function merge(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch)
  const out = base !== null && typeof base === 'object' && !Array.isArray(base)
    ? structuredClone(base) as Record<string, unknown>
    : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? merge(out[key], value) : structuredClone(value)
  }
  return out
}

/** Minimal in-memory SettingsProvider-compatible seam for pre-0.2 tests. */
export class MemorySettings extends Service {
  private readonly registrations = new Map<string, Registration<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  installSection<C>(_owner: Context | Fiber, ns: string, _schema: unknown, entry: C, hooks: Registration<C>['hooks']): void {
    const registration: Registration<C> = { ns, base: structuredClone(entry), section: {}, hooks }
    this.registrations.set(ns, registration as Registration<unknown>)
    hooks.setSource(() => this.get(ns) as C)
    hooks.onChange()
  }

  get<C>(ns: string): C | undefined {
    const registration = this.registrations.get(ns)
    if (registration === undefined) return undefined
    return merge(registration.base, registration.section) as C
  }

  describe(): Array<{ ns: string }> {
    return [...this.registrations.keys()].map(ns => ({ ns }))
  }

  async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    const registration = this.registrations.get(ns)
    if (registration === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
    registration.section = merge(registration.section, patch) as Record<string, unknown>
    registration.hooks.onChange()
  }
}
