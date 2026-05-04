# pi-r2-share

Session sharing for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) through your own Cloudflare R2 bucket — **with built-in secret redaction and TruffleHog scanning before anything leaves your machine.**

Pi's built-in `/share` uploads to `pi.dev/session` behind GitHub-proxied infrastructure. When it works, it works. When the proxy rate-limits you — mid-demo, mid-handoff, mid-debug — there's no fallback. You get a failure and a dead end. Nothing gets redacted either — every API key, email, and credential in your session ships to a third party as-is. The exported HTML also dumps the entire available-tools list as an uncollapsed wall of text — no way to fold it away.

`pi-r2-share` replaces that with two commands backed by a bucket you own:

- **`/r2-share`** — exports the current session, injects system prompt and tool manifest, **redacts secrets and PII**, scans with TruffleHog, uploads to R2, copies the URL.
- **`/r2-sessions`** — inline TUI overlay to browse, copy URLs, and delete uploaded sessions.

No proxy, no rate limits, no third-party dependency. **No secrets leave your machine.**

## Install

```bash
pi install git:github.com/<you>/pi-r2-share
```

Install [TruffleHog](https://github.com/trufflesecurity/trufflehog) for redaction (optional).

## Setup

Create an R2 bucket and point the extension at it:

```bash
bun add -g wrangler
wrangler login
wrangler r2 bucket create pi-r2-share
```

**Heads up:** the Wrangler OAuth flow doesn't always request R2 permissions. If uploads fail with 401, check `wrangler whoami` — if R2 isn't in the scopes, run `wrangler logout && wrangler login` and make sure the browser auth page includes R2 access.

```bash
export PI_SHARE_BUCKET=pi-r2-share
export PI_SHARE_PUBLIC_URL=https://your-public-r2-dev-url.r2.dev
```

Done. Run `/r2-share` inside Pi to upload the current session.

## Commands

### `/r2-share`

```text
/r2-share                # HTML (default) — redacted, scanned, then uploaded
/r2-share --jsonl        # raw JSONL — redacted, scanned, then uploaded
/r2-share --unsafe       # skip redaction and TruffleHog scan
```

You'll be asked to confirm redaction before it runs. Choose Yes (default) to redact + scan, or No to share raw. `--unsafe` skips the prompt entirely.

Pipeline: export via Pi's built-in exporter → inject system prompt + tool manifest → patch collapsible-tools UI → **redact secrets/PII** → **TruffleHog residual scan** → upload to R2 → record in local registry → print URL.

The redaction layer sanitizes secrets (API keys, tokens, private keys, JWTs, credentials), PII (email, phone, SSN, credit card numbers), and strips absolute path prefixes before anything leaves your machine. TruffleHog runs as a second-pass check on the redacted file — if it finds residual secrets the built-in patterns missed, the upload is aborted.

**TruffleHog is required.** If it's not installed, `/r2-share` will abort with install instructions. Use `--unsafe` to bypass (not recommended).

Empty or brand-new sessions that Pi hasn't persisted yet get a header-only JSONL generated on the fly.

### `/r2-sessions`

```text
/r2-sessions             # current project
/r2-sessions --all       # everything
```

Inline overlay that lists objects directly from your R2 bucket, enriched with cached local metadata.

| Key | Action |
| :--- | :--- |
| `↑` / `↓` | Navigate |
| `Enter` | Copy share URL to clipboard |
| `Tab` | Toggle current-project / all-sessions |
| `i` | Toggle R2 object ID |
| `d` | Delete selected (with confirmation) |
| `D` | Delete all visible (with confirmation) |
| `Esc` | Close |

## Data flow

The original session file is never modified. Redaction runs on a copy in a temp directory, and the whole redaction + scan pipeline executes in a worker thread so the TUI stays responsive.

```text
YOU TYPE /r2-share
        |
        v
+----------------------------------+
|  Pi session (.jsonl)             |
|  pi-r2-share never touches this  |
+----------------------------------+
        |
        v
+----------------------------------+
|  pi --export → HTML or JSONL     |
|  inject system prompt + tools    |
|  patch collapsible-tools UI      |
+----------------------------------+
        |
        v
+----------------------------------+
|  Worker thread                   |
|                                  |
|  sanitizeHtmlSession /           |
|  sanitizeJsonl                   |
|  stripAbsolutePathPrefix         |
|           |                      |
|           v                      |
|  TruffleHog filesystem scan      |
|  on the redacted temp file       |
|                                  |
|  findings > 0? → abort           |
|  findings = 0? → proceed         |
+----------------------------------+
        |
        v
+------------------+---------------+
|  R2 upload       |  Local cache  |
|  (wrangler/S3)   |               |
|                  |  ~/.pi/cache/  |
|  $PUBLIC_URL/    |  r2-shares    |
|  <uuid>          |  .json        |
+------------------+---------------+
```

What gets redacted:

| Category | Examples |
| :--- | :--- |
| Secret patterns | OpenAI keys, GitHub tokens, AWS access keys, Anthropic keys, Bearer tokens, JWTs, Stripe keys, SendGrid keys, Docker PATs, Slack webhooks |
| Sensitive object keys | Any field named `password`, `api_key`, `secret`, `token`, `credential`, `private_key`, `authorization`, etc. |
| Assignment patterns | `API_KEY=value`, `PASSWORD=value` — any sensitive-keyed env-style assignment |
| PII | Email addresses, phone numbers, SSNs, credit card numbers (Luhn-validated) |
| Path prefixes | `$HOME`, cwd, session file path → replaced with `[PATH_ROOT]` |
| Blobs | Long base64, hex, data URLs → replaced with char-count placeholder |
| Env var secrets | Any env var with a sensitive-sounding name — its value is redacted everywhere |
| Configured literals | `PI_SHARE_ADDITIONAL_SECRETS` — comma-separated, redacted on sight |

Redaction is forward-only. It doesn't rewrite old shares — only new uploads.

## Upload backends

| Mode | `PI_SHARE_MODE` | Auth |
| :--- | :--- | :--- |
| Auto (default) | unset | S3 keys if present, else Wrangler OAuth |
| Wrangler | `wrangler` | `wrangler login` |
| S3 | `s3` | `CLOUDFLARE_ACCOUNT_ID` + `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` |

S3 mode uses AWS Signature v4 over the R2 S3-compatible API (`<account>.r2.cloudflarestorage.com`). No SDK, no extra dependencies. This is not generic S3 — it's R2 only.

## Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PI_SHARE_BUCKET` | — | R2 bucket name. **Required.** |
| `PI_SHARE_PUBLIC_URL` | — | Public base URL for shared links. **Required.** |
| `PI_SHARE_MODE` | `auto` | `auto`, `wrangler`, or `s3`. |
| `PI_SHARE_WRANGLER_BIN` | `wrangler` | Path to Wrangler binary. |
| `PI_SHARE_REGISTRY` | `~/.pi/cache/r2-shares.json` | Local upload registry. |
| `PI_SHARE_ADDITIONAL_SECRETS` | — | Comma-separated extra secrets to redact. |
| `PI_SHARE_TRUFFLEHOG_TIMEOUT_MS` | `120000` | Timeout for TruffleHog scan. |
| `CLOUDFLARE_ACCOUNT_ID` | — | Account ID. Required for S3 mode and remote listing. |
| `CLOUDFLARE_API_TOKEN` | — | API token for listing objects. Falls back to Wrangler OAuth token. |
| `R2_ACCESS_KEY_ID` | — | R2 access key. Falls back to `AWS_ACCESS_KEY_ID`. |
| `R2_SECRET_ACCESS_KEY` | — | R2 secret key. Falls back to `AWS_SECRET_ACCESS_KEY`. |

## License

MIT
