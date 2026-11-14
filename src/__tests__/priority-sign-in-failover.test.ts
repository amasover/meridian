/**
 * Pool routing when an account's sign-in is gone, through the HTTP layer with
 * a mocked SDK.
 *
 * Claude Code reports a sign-in it could not refresh as an error result
 * ("Failed to authenticate: OAuth session expired and could not be refreshed").
 * Meridian's own refresh cannot repair it either, so under `priority` and
 * `active+priority` the account is benched like a refused one and the request
 * goes on to the next account. A single-account pool and the `active` mode
 * keep handing the authentication error to the client.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, setSystemTime } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

const SIGNED_OUT = "Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed"

let capturedEnvs: string[] = []
let failingDirs = new Set<string>()
let failureMessage = SIGNED_OUT

installSdkMock(() => ({
  query: (params: { options?: { env?: Record<string, string | undefined> } }) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    capturedEnvs.push(dir)
    const sessionId = resolveMockSdkSessionId(params.options, "test-session")
    return (async function* () {
      if ([...failingDirs].some((f) => dir.includes(f))) throw new Error(failureMessage)
      yield { ...assistantMessage([{ type: "text", text: "ok from " + dir }]), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "priority-sign-in-failover.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { rateLimitStore } = await import("../proxy/rateLimitStore")

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-signin-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-signin-personal" },
]

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }

function createTestApp(profiles: Array<{ id: string; claudeConfigDir: string }> = PROFILES): TestApp {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles, defaultProfile: "work" })
  return app
}

async function post(app: TestApp, opts: { stream?: boolean } = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 16,
      stream: opts.stream === true,
      messages: [{ role: "user", content: "hello" }],
    }),
  }))
}

async function exhausted(app: TestApp) {
  const res = await app.fetch(new Request("http://localhost/profiles/health"))
  expect(res.status).toBe(200)
  const body = await res.json() as { exhausted: Array<{ id: string; until: number; reason: string }> }
  return body.exhausted
}

const savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  capturedEnvs = []
  failingDirs = new Set()
  failureMessage = SIGNED_OUT
  await clearSessionCache()
  resetActiveProfile()
  rateLimitStore.clear()
  // A bench fires the usage refinement for quota refusals only, but keep the
  // suite off the network regardless.
  __setFetchOAuthUsageOverride(async () => null)
  savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
  savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
  process.env.MERIDIAN_ROUTING = "active+priority"
  process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
})

afterEach(() => {
  setSystemTime()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __setFetchOAuthUsageOverride(null)
  rateLimitStore.clear()
  resetActiveProfile()
})

afterAll(() => setSystemTime())

describe("a signed-out account in a pool", () => {
  it("serves the request from the next account when the active one cannot refresh its sign-in", async () => {
    const app = createTestApp()
    failingDirs.add("signin-work")
    const res = await post(app)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ text: string }> }
    expect(body.content[0]?.text).toContain("signin-personal")
    expect(capturedEnvs[0]).toContain("signin-work")
    const marks = await exhausted(app)
    expect(marks.map(m => [m.id, m.reason])).toEqual([["work", "authentication_error"]])
  }, 20_000)

  it("fails over inside a stream too", async () => {
    const app = createTestApp()
    failingDirs.add("signin-work")
    const res = await post(app, { stream: true })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("ok from")
    expect(text).toContain("signin-personal")
    expect(text).not.toContain("authentication_error")
  }, 20_000)

  it("skips the benched account on the next request, then tries it again once the bench lapses", async () => {
    const app = createTestApp()
    failingDirs.add("signin-work")
    expect((await post(app)).status).toBe(200)

    capturedEnvs = []
    expect((await post(app)).status).toBe(200)
    expect(capturedEnvs.some(dir => dir.includes("signin-work"))).toBe(false)

    // Signed in again meanwhile; the bounded bench lets it be re-checked.
    failingDirs.delete("signin-work")
    const [mark] = await exhausted(app)
    setSystemTime(new Date(mark!.until + 1_000))
    capturedEnvs = []
    const res = await post(app)
    expect(res.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("signin-work")
  }, 30_000)

  it("fails over under plain priority routing as well", async () => {
    process.env.MERIDIAN_ROUTING = "priority"
    const app = createTestApp()
    failingDirs.add("signin-work")
    const res = await post(app)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ text: string }> }
    expect(body.content[0]?.text).toContain("signin-personal")
  }, 20_000)

  it("surfaces the authentication error when every account is signed out", async () => {
    const app = createTestApp()
    failingDirs.add("signin-work")
    failingDirs.add("signin-personal")
    const res = await post(app)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { type: string } }
    expect(body.error.type).toBe("authentication_error")
  }, 30_000)

  it("does not bench an account for an authentication error that is not a lost sign-in", async () => {
    // The generic auth branch matches loose words such as "credentials"; a
    // tool's stderr can carry them. Only a sign-in Meridian could not refresh
    // moves the request, so this one stays the client's answer.
    failureMessage = "Claude Code process exited with code 2\nSubprocess stderr: invalid auth header in MCP server credentials"
    const app = createTestApp()
    failingDirs.add("signin-work")
    const res = await post(app)
    expect(res.status).toBe(401)
    expect(capturedEnvs.some(dir => dir.includes("signin-personal"))).toBe(false)
    expect(await exhausted(app)).toEqual([])
  }, 20_000)
})

describe("where a signed-out account does not fail over", () => {
  it("returns the authentication error from a one-account pool", async () => {
    const app = createTestApp([PROFILES[0]!])
    process.env.MERIDIAN_PROFILE_ORDER = "work"
    failingDirs.add("signin-work")
    const res = await post(app)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { type: string } }
    expect(body.error.type).toBe("authentication_error")
  }, 20_000)

  it("returns the authentication error in active mode without trying another account", async () => {
    process.env.MERIDIAN_ROUTING = "active"
    const app = createTestApp()
    failingDirs.add("signin-work")
    const res = await post(app)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { type: string } }
    expect(body.error.type).toBe("authentication_error")
    expect(capturedEnvs.every(dir => dir.includes("signin-work"))).toBe(true)
  }, 20_000)
})
