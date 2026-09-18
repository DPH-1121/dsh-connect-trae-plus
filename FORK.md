# Fork notes — `dsh-connect-trae` (hardened)

This package is a **fork of [`dingminhua/dsh-connect-trae`](https://github.com/dingminhua/dsh-connect-trae)
`v2.0.4`** (upstream commit `9c7c113`).

**Source of this fork:** [`HaydenSmith1121/dsh-connect-trae-plus`](https://github.com/HaydenSmith1121/dsh-connect-trae-plus)
— this repository is the only place the plugin's code is changed. Distribution
happens through [`HaydenSmith1121/dsh-plugin-collection`](https://github.com/HaydenSmith1121/dsh-plugin-collection),
which hosts the built tarball; those bytes are frozen once published, so a change
here means a new version, not an edited artifact. See [`CONTRIBUTING.md`](./CONTRIBUTING.md)
for how a release moves through the three repositories.

Everything Trae-facing — protocol, credential handling, region split, catalogs,
the settings card — is upstream's work, unchanged. The fork changes **only how
the plugin behaves when its own loopback listener is not available**, and exists
because the upstream behaviour could take the whole Harness process down with it.

Version: `2.0.4-dsh.1` (prerelease of the next patch, so it sorts above upstream
`2.0.4` and below any future upstream `2.0.5`).

---

## 1. What went wrong

Each region's provider route is served through a loopback HTTP shim that the
plugin binds on an ephemeral port at activation. Provider registration ran inside
a single awaited chain:

```ts
void Promise.all(REGION_KEYS.map(region => stacks[region].shim.ready)).then(async () => {
  for (const region of REGION_KEYS) {
    const trae = createTraeAdapter({ shim: stack.shim, /* … */ })   // ← reads shim.baseUrl()
    /* … registerAdapter … */
  }
  /* … registerModelDiscovery, registerConfigurableProviders, ctx.effect(…) … */
}).catch(error => {
  ctx.logger.error('dsh-connect-trae: loopback shim failed; providers not registered', error)
})
```

Two independent properties of that shape turn a local problem into a global one:

1. **The adapter read the shim's live state while building its model list.**

   ```ts
   const buildModels = () => options.catalog.current()
     .map(info => toPiModel(info, `${options.shim.baseUrl()}/v1`, providerId))

   baseUrl() {
     const address = server.address()
     if (address === null || typeof address === 'string') throw new Error('trae shim is not listening')
     return `http://127.0.0.1:${address.port}`
   }
   ```

   `server.listen()` is asynchronous, so "the shim exists" and "the shim is
   listening" are different facts, and the adapter asks for the second one at a
   moment it does not control. Any path that constructs the adapter without
   having observed the bind throws `trae shim is not listening` **out of the
   activation chain**, and the trailing `.catch` then replaces the real cause
   with its own generic message — which is why the failure surfaces as "the shim
   is not listening" and nothing else.

2. **Registration is all-or-nothing, and the chain's failures are not
   observed.** Every step — both adapters, model discovery, the configurable
   provider directory, and the teardown registration — shares one `then` body
   and one trailing `catch`. Two distinct consequences follow:

   * **Measured consequence (reproduced against 2.0.1):** when a shim cannot
     bind, `shim.ready` rejects, the `.then` body never runs, and **both**
     provider routes silently disappear. The harness does still start — this is
     not a hard abort — but no Trae model is available anywhere in it, and the
     only trace is one generic `loopback shim failed; providers not registered`
     line that names neither the region nor the reason. From the user's seat
     that reads as "the plugin broke the harness", and the text next to it is
     the shim message a diagnosis latches onto.
   * **Latent consequence (the harder failure):** anything else that throws
     inside that chain — `ctx.effect` on a fiber that has already gone (an HMR
     reload, a dispose racing a slow `await`), a rejected route registration —
     leaves the `then` body half-done with an unobserved rejection. DSH installs
     a process-wide fail-loud handler on `unhandledRejection` that logs
     `fatal load failure` and exits `1`, so on those paths a third-party model
     provider really can stop the whole Harness from starting, including when
     the plugin is one entry among many in the profile.

The fix addresses both: it removes the timing dependency (1) and makes every
failure in the chain contained, attributed, and observed (2).

---

## 2. What this fork changes

Three files. No Trae behaviour, catalog, or protocol code is touched.

### `src/shim.ts` — readiness is observable, never exceptional

* The bind outcome is **recorded once** (`boundPort` / `bindFailure` /
  `bindSettled`) instead of being re-derived from `server.address()` on every
  read, so no accessor can race the listener again.
* Added to `TraeShim`:
  * `readonly listening: boolean` — non-throwing readiness check.
  * `whenListening(timeoutMs): Promise<boolean>` — bounded wait that resolves
    `false` on a failed bind or a missed deadline. **It never throws and never
    hangs**, so "this region has no port" is an ordinary value its caller can
    degrade on.
  * `reason(): unknown` — the bind error, so the degradation message can name
    the real cause (`EADDRINUSE`, …) instead of guessing.
* `baseUrl()` keeps throwing when the readiness gate was skipped — that is a
  programming error, and it now says so explicitly.
* `ready` gets an internal no-op `catch`, so a rejected bind can never surface as
  an unhandled rejection even for a caller that never awaits it.
* `close()` is idempotent and safe on a shim that never bound (`server.close()`
  reports "Server is not running" for a listener that never came up — a teardown
  concern, not a caller-visible failure). It awaits an in-flight bind so a port
  that binds *after* close was requested is still released.
* New `bindHost` / `port` options (defaults `127.0.0.1` / `0`, i.e. unchanged
  production behaviour) let a test produce a deterministic bind failure.

### `src/adapter.ts` — the readiness dependency is now type-visible

`createTraeAdapter` takes `baseUrl: string` and `apiKey: string` instead of the
live `TraeShim`. The adapter can no longer re-query a listener mid-flight, and
the requirement "observe the bind first" is expressed in the signature rather
than in a comment. It also stops re-deriving the URL on every catalog read.

### `src/index.ts` — activation is contained and per-region

* **Bind gate.** Each region is awaited through `shim.whenListening(5_000)`.
  Binding an ephemeral loopback port is an immediate syscall, so the deadline is
  never reached in a healthy environment; it exists so a listener that never
  settles costs one provider instead of stalling activation.
* **Per-region registration.** Each region builds and registers its provider
  inside its own `try`/`catch`, which reports *which* route is unavailable and
  what still works. One region failing — or both — no longer prevents the other
  from serving, and no longer aborts the chain.
* **Directory registration is separately contained.** Model discovery and
  `registerConfigurableProviders` have their own handler: the routes are already
  live by then, so a failure there must not take them away.
* **Teardown is registered synchronously in `apply`.** `ctx.effect` throws when
  it is called after the plugin's fiber is gone, which is reachable from any
  awaited startup step that resumes after a dispose or an HMR reload. Every
  registration now goes through a guarded helper that reports the failure and
  runs the release immediately instead of throwing into the boot chain.
* **The startup seed cannot reject.** Its fallback path and its own trailing
  handler both report instead of throwing.
* **A final `boot().catch(...)`** states plainly that the plugin is mounted, its
  providers may be unavailable, and the rest of the Harness is unaffected.

The net contract: **the plugin can fail; the Harness cannot be stopped by it.**

---

## 3. Tests

Upstream's suite is preserved in full. `pnpm test` runs **243 tests** (upstream
`v2.0.4`: 236; the 7 added are listed below) and `pnpm run typecheck` is clean.

| File | What it pins |
|---|---|
| `tests/shim.spec.ts` | Readiness is observable without throwing; a failed bind resolves `whenListening` to `false` with `EADDRINUSE` available on `reason()` and a `baseUrl()` that refuses to guess; the base URL is stable across catalog reads; an adapter built after the gate serves the catalog. |
| `tests/boot-rejection.spec.ts` | A full activation emits **no** `unhandledRejection` (the condition DSH's fail-loud handler turns into a process exit); a host missing the `llm` service is reported per region instead of rejected; a guaranteed-to-fail directory seed still yields the configured catalog with no escaping rejection. |

The sabotage test that matters most is the failed-bind one: it holds a real
loopback port and makes the shim bind it, which is exactly the "the listener is
not there" condition. Against the pre-fork `shim.ts` it cannot even be expressed
— there was no way to read readiness other than by catching an exception.

---

## 4. Reproducing

```bash
pnpm install
pnpm run typecheck   # tsc, both host and client configs
pnpm test            # 243 tests
pnpm run build       # tsdown → lib/index.js (+ lib/client.js, lib/index.d.ts)
```

`lib/` is the built artifact and is what the profile actually loads; `src/`,
`tests/` and the configs ship in this fork's tarball so the change can be audited
and the package maintained without a second checkout.

---

## 5. Upstreaming

The defect and the fix are upstream's to take:

* [`dingminhua/dsh-connect-trae`](https://github.com/dingminhua/dsh-connect-trae)
  — issues: <https://github.com/dingminhua/dsh-connect-trae/issues>
* The upstream fix for a *different* provider-level failure of the same family
  (`INVALID_MODEL_CONTEXT` taking a whole region offline) landed in upstream
  `v2.0.4` and is included here unchanged. This fork's change is the activation
  path around it.

Report a bug in **this fork** at
<https://github.com/HaydenSmith1121/dsh-connect-trae-plus/issues>; report a
problem with the plugin's Trae-facing behaviour (catalog, login, models) upstream.
If upstream adopts an equivalent fix, this fork should be retired in favour of
the upstream package.
