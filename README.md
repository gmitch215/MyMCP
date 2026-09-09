# MyMCP

Turns any OpenAPI description into an MCP server. Point it at a description URL and every operation
becomes a tool an AI client can call, with no server to write and nothing to deploy.

Hosted at [mymcp.gmitch215.xyz](https://mymcp.gmitch215.xyz). Runs on Cloudflare Workers, so you can
also deploy your own.

```text
https://mymcp.gmitch215.xyz/{server}/mcp
```

`{server}` is either a preconfigured alias or a URL-encoded link to an OpenAPI description.

```bash
# preconfigured alias
https://mymcp.gmitch215.xyz/petstore/mcp

# a hostname, which is checked for a description
https://mymcp.gmitch215.xyz/api.tabroom.com/mcp

# a full description URL, percent-encoded
https://mymcp.gmitch215.xyz/https%3A%2F%2Fapi.example.com%2Fopenapi.json/mcp
```

## How It Works

MyMCP fetches the description, resolves its schemas, and builds one MCP tool per operation. Path,
query, header and cookie parameters keep the names the API gives them; a binding table records where
each one belongs on the wire, so nothing has to be inferred from an argument name at call time.

When the URL does not serve a description directly, MyMCP looks for one. It reads
`Link: rel="service-desc"` headers, then the configuration embedded by Scalar, Swagger UI, Redoc,
Stoplight Elements and RapiDoc, then a list of well-known paths. Pointing at `api.tabroom.com`
finds the description at `/v1` without being told where it is.

OpenAPI 3.0, 3.1 and Swagger 2.0 are supported, in JSON or YAML.

## Preconfigured Servers

| Alias          | API                  | Tools |
| -------------- | -------------------- | ----- |
| `tabroom`      | Tabroom IndexCards   | 66    |
| `petstore`     | Swagger Petstore 3.0 | 19    |
| `petstore31`   | Swagger Petstore 3.1 | 3     |
| `earth-app`    | Earth App            | 391   |
| `twilio`       | Twilio               | 197   |
| `box`          | Box Platform         | 297   |
| `digitalocean` | DigitalOcean         | 659   |
| `slack`        | Slack Web API        | 174   |
| `openai`       | OpenAI               | 289   |
| `asana`        | Asana                | 249   |
| `stripe`       | Stripe               | 594   |

Add more in [`src/servers.json`](src/servers.json). `bun run servers:check` validates every entry,
and runs weekly in CI.

## Filters

Large APIs produce hundreds of tools, which most clients handle poorly. Narrow the set with query
parameters on the connection URL:

| Parameter      | Effect                                                                               |
| -------------- | ------------------------------------------------------------------------------------ |
| `tags`         | keep operations carrying any of these tags                                           |
| `methods`      | keep these HTTP methods                                                              |
| `include`      | keep operations matching these glob patterns                                         |
| `exclude`      | drop operations matching these glob patterns                                         |
| `max`          | cap the number of tools                                                              |
| `server`       | index into the description's `servers` list                                          |
| `confirm`      | require confirmation before calling: `write`, `destructive`, `all`, or a method list |
| `outputSchema` | set to `0` to omit generated output schemas                                          |

```text
https://mymcp.gmitch215.xyz/stripe/mcp?tags=Customers&methods=get&max=40
```

Filters are part of the cache key, so two differently filtered connections do not share a tool list.

## Authentication

Credentials for the upstream API travel in their own headers, never in `Authorization`:

| Header                           | Use                                                  |
| -------------------------------- | ---------------------------------------------------- |
| `X-Mcp-Upstream-Authorization`   | bearer or basic credentials, and OAuth access tokens |
| `X-Mcp-Upstream-<Header>`        | an API key sent as a named header                    |
| `X-Mcp-Upstream-Query-<name>`    | an API key sent as a query parameter                 |
| `X-Mcp-Upstream-Cookie-<name>`   | an API key sent as a cookie                          |
| `X-Mcp-Upstream-Scheme-<scheme>` | a credential targeted at one named security scheme   |

MyMCP reads the description's `securitySchemes` and applies the credential where each operation
expects it, covering `http bearer`, `http basic`, and `apiKey` in a header, query string or cookie.
Any `X-Mcp-Upstream-<Header>` value that matches no scheme is forwarded as-is, which covers APIs
that need headers their own description does not declare.

**Credentials go only to hosts the description declares** in its `servers` list, plus anything in
`ALLOWED_HOSTS`. They are dropped on any redirect that leaves those hosts. A description fetched
from an arbitrary URL therefore cannot route a credential somewhere of its own choosing.

The MCP specification forbids an MCP server from reusing the client's own credentials against a
third-party API. Keeping upstream credentials in a separate header family means the caller is
handing MyMCP a key for a named API rather than having an MCP token forwarded on their behalf, and
leaves `Authorization` free for MCP's own authorization. For the flow the specification prefers,
where MyMCP holds the upstream tokens itself, see [Authorization](#authorization).

## Client Setup

### Claude Code

```bash
claude mcp add --transport http petstore https://mymcp.gmitch215.xyz/petstore/mcp

# with a credential for the upstream API
claude mcp add --transport http tabroom https://mymcp.gmitch215.xyz/tabroom/mcp \
  --header "X-Mcp-Upstream-Authorization: Bearer $TABROOM_TOKEN"
```

Or in `.mcp.json`, which supports `${VAR}` expansion:

```json
{
	"mcpServers": {
		"stripe": {
			"type": "http",
			"url": "https://mymcp.gmitch215.xyz/stripe/mcp?tags=Customers",
			"headers": {
				"X-Mcp-Upstream-Authorization": "Bearer ${STRIPE_SECRET_KEY}"
			}
		}
	}
}
```

Use `--scope project` to commit the entry for a team, or `--scope user` to make it global. For
credentials that rotate, `headersHelper` runs a script that prints headers as JSON.

### Codex CLI

```bash
codex mcp add petstore --url https://mymcp.gmitch215.xyz/petstore/mcp
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.stripe]
url = "https://mymcp.gmitch215.xyz/stripe/mcp?tags=Customers"
bearer_token_env_var = "MYMCP_TOKEN"
http_headers = { "X-Mcp-Upstream-Authorization" = "Bearer sk_test_..." }
startup_timeout_sec = 20
tool_timeout_sec = 120
```

`bearer_token_env_var` sets `Authorization`, which MyMCP uses for its own authorization. Upstream
credentials belong in `http_headers`.

### Gemini CLI

```bash
gemini mcp add --transport http petstore https://mymcp.gmitch215.xyz/petstore/mcp
```

Or in `~/.gemini/settings.json`:

```json
{
	"mcpServers": {
		"petstore": {
			"httpUrl": "https://mymcp.gmitch215.xyz/petstore/mcp",
			"headers": {
				"X-Mcp-Upstream-Authorization": "Bearer ${API_TOKEN}"
			}
		}
	}
}
```

Gemini CLI uses `httpUrl` for Streamable HTTP and `url` for the older SSE transport.

### Cursor, VS Code and Claude Desktop

All three take the same shape in their MCP configuration file:

```json
{
	"mcpServers": {
		"petstore": {
			"type": "http",
			"url": "https://mymcp.gmitch215.xyz/petstore/mcp",
			"headers": {
				"X-Mcp-Upstream-Authorization": "Bearer ..."
			}
		}
	}
}
```

### Claude Code Plugin

The repository is a plugin marketplace, which installs a set of servers in one step:

```text
/plugin marketplace add gmitch215/MyMCP
/plugin install mymcp@mymcp
```

The bundled servers read their credentials from `TABROOM_TOKEN`, `DIGITALOCEAN_TOKEN` and
`STRIPE_SECRET_KEY`. See [`plugin/.mcp.json`](plugin/.mcp.json).

## Endpoints

| Path                                        | Purpose                                               |
| ------------------------------------------- | ----------------------------------------------------- |
| `POST /{server}/mcp`                        | Streamable HTTP, the current transport                |
| `GET /{server}/sse`                         | HTTP+SSE from protocol version 2024-11-05, deprecated |
| `POST /{server}/messages`                   | message channel for the SSE transport                 |
| `GET /.well-known/oauth-protected-resource` | resource metadata, when authorization is enabled      |

`POST /{server}/sse` is treated as Streamable HTTP so existing configurations keep working.

The SSE transport needs the two halves of a session to share state, which a stateless Worker cannot
do alone. Bind the `MCP_SSE` Durable Object to enable it; without that binding, `GET /{server}/sse`
returns 405 and points at `/{server}/mcp`.

## Protocol Support

| Version      | Notes                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| `2026-07-28` | stateless, `server/discover`, per-request `_meta`, required request headers |
| `2025-11-25` | handshake era                                                               |
| `2025-06-18` | handshake era                                                               |
| `2025-03-26` | handshake era, assumed when no version header is sent                       |
| `2024-11-05` | HTTP+SSE transport                                                          |

Methods: `server/discover`, `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`,
`prompts/get`, `resources/list`, `resources/read`, `resources/templates/list`,
`completion/complete`, `subscriptions/listen`, and `tasks/get`, `tasks/update`, `tasks/cancel`.

On `2026-07-28`, `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` are required and validated
against the request body; a mismatch returns 400 with error `-32020`. Set `MCP_STRICT_HEADERS=0` to
accept requests that omit them.

### Elicitation

When a client supports elicitation, MyMCP asks instead of failing:

- A call missing required arguments returns a form requesting them.
- With `?confirm=write`, a write operation asks for confirmation before it runs.
- When an operation needs credentials and none were supplied, a URL-mode elicitation starts the
  upstream sign-in flow.

The state carried between rounds is AEAD-sealed and bound to the caller, the originating request and
a short expiry, so it cannot be replayed onto another call.

### Tasks

With KV bound, MyMCP implements the `io.modelcontextprotocol/tasks` extension. An upstream that
answers `202 Accepted` with a `Location` header becomes a task; the client polls `tasks/get`, and
MyMCP advances the upstream job on each read. Without KV the extension is not advertised, because a
task handle has to outlive the request that created it.

## Authorization

MyMCP is open by default. Setting `AUTH_PROVIDER` turns it into an OAuth 2.1 resource server: it
serves RFC 9728 resource metadata, answers unauthenticated requests with `401` and a
`WWW-Authenticate` challenge, and validates that a token's audience is this server.

Three identity providers are supported:

| `AUTH_PROVIDER` | Configuration                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `selfhosted`    | an OAuth 2.1 server inside the Worker: PKCE, Client ID Metadata Documents, KV-backed tokens, and `SELFHOST_PASSWORD` for the operator |
| `access`        | Cloudflare Access, verified against the team JWKS via `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`                                           |
| `oidc`          | any OpenID Connect or RFC 8414 server, via `AUTH_ISSUER`                                                                              |

With a provider and KV configured, `/connect` starts an OAuth flow against the upstream API using
the `oauth2` scheme its description declares. MyMCP stores the resulting token against the verified
user and uses it on their behalf, so upstream credentials never reach the MCP client. The callback
checks that the browser user is the same principal that began the flow.

## Self-Hosting

```bash
git clone https://github.com/gmitch215/MyMCP.git
cd MyMCP
bun install
bun run dev
```

Deploy with `bun run deploy`. Everything below is optional; with none of it set, MyMCP runs as a
stateless public gateway.

| Binding or variable       | Effect                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `MYMCP_KV`                | KV namespace enabling tasks, stored upstream tokens and the self-hosted auth server |
| `MCP_SSE`                 | Durable Object enabling the deprecated HTTP+SSE transport                           |
| `STATE_SECRET`            | key for sealing elicitation state; without it, state does not survive a restart     |
| `ALLOWED_HOSTS`           | extra hosts permitted to receive credentials                                        |
| `ALLOWLIST_ONLY`          | `1` to serve only the aliases in `servers.json`                                     |
| `INSECURE_UPSTREAM_HOSTS` | `host:port` entries exempt from the network policy                                  |
| `MAX_SPEC_BYTES`          | description size cap, default 12 MB                                                 |
| `MAX_RESPONSE_BYTES`      | upstream response cap, default 2 MB                                                 |
| `FETCH_TIMEOUT_MS`        | upstream timeout, default 20s                                                       |
| `MCP_STRICT_HEADERS`      | `0` to stop requiring `Mcp-Method` and `Mcp-Name`                                   |

### Network Policy

MyMCP fetches URLs a caller supplies, so it refuses anything that is not publicly routable: plain
HTTP, loopback, RFC1918, carrier-grade NAT, link-local including `169.254.169.254`, multicast, and
the IPv6 equivalents including IPv4-mapped forms. The check runs on the description URL, every
discovery candidate and each redirect hop.

`INSECURE_UPSTREAM_HOSTS` exempts specific `host:port` entries, for an instance deployed alongside a
private API. Every entry is a host callers can then reach through the service.

Descriptions and their derived tool tables are cached, and concurrent requests for the same
uncached description share one build.

### Prompt Injection

Tool names and descriptions come from a third-party document and reach model context verbatim.
MyMCP strips control characters, ANSI escapes and zero-width and bidi overrides from that text, caps
its length, and states in the server instructions that the descriptions are data rather than
instructions.

## Development

```bash
bun run typecheck
bun run test                # unit tests, hermetic
bun run test:coverage
bun run servers:check       # validate every alias in servers.json
bun run evals               # tool-selection evals via local Claude Code
```

Integration tests run against real containers:

```bash
docker compose -f docker/compose.yml up -d --wait
bun run test:e2e
docker compose -f docker/compose.yml down -v
```

The fixtures are an echo server that reflects the request it receives, which makes the generated
HTTP request directly assertable, and a static server holding the descriptions under `docker/specs`.

Conformance is checked with the official MCP Inspector against a running worker:

```bash
bun run dev
bunx @modelcontextprotocol/inspector@2 --cli \
  --transport http --server-url http://127.0.0.1:8787/petstore/mcp \
  --method tools/list --strict
```

### Layout

| Path              | Contents                                                                       |
| ----------------- | ------------------------------------------------------------------------------ |
| `src/openapi/`    | schema resolution, tool generation, parameter serialization, request execution |
| `src/mcp/`        | method dispatch, the transports, elicitation, tasks                            |
| `src/auth/`       | upstream credentials, resource server, identity providers                      |
| `src/resolve.ts`  | alias resolution, description loading, caching                                 |
| `src/discover.ts` | finding a description behind a documentation page                              |
| `src/net.ts`      | network policy and capped fetching                                             |

## Out of Scope

Sampling, roots and logging are deprecated in the current specification with removal scheduled, so
MyMCP does not implement them.

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
