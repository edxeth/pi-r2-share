# pi-share extension

Adds `/r2-share` to export the current pi session to a local temp file and upload/share it through Cloudflare R2 instead of GitHub Gist/pi.dev.

No R2 account/bucket/public URL details are hardcoded in the extension. Configure them with environment variables.

## Required env vars

```bash
export PI_SHARE_BUCKET=pi-share
export PI_SHARE_PUBLIC_URL=https://your-public-r2-dev-url.r2.dev
```

## Auth

Use Wrangler OAuth:

```bash
bun add -g wrangler
wrangler login
```

The extension runs roughly:

```bash
wrangler r2 object put "$PI_SHARE_BUCKET/<unique-id>" --file <exported-file> --content-type <type> --remote
```

## Optional env vars

```bash
export PI_SHARE_MODE=wrangler    # wrangler | auto | s3
export PI_SHARE_WRANGLER_BIN=wrangler
```

For direct S3-compatible uploads instead of Wrangler OAuth:

```bash
export PI_SHARE_MODE=s3
export CLOUDFLARE_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
```

## Usage

```text
/r2-share
```

Default output is HTML. For raw JSONL:

```text
/r2-share --jsonl
```

## Local file location

The extension uses the OS temp directory automatically:

```text
<os tmp dir>/pi-r2-share/<unique-id>.html
```

On Linux this is typically:

```text
/tmp/pi-r2-share/<unique-id>.html
```

On macOS this is typically under:

```text
/var/folders/.../T/pi-r2-share/<unique-id>.html
```

## URL shape

HTML shares use the unique ID directly as the R2 object key:

```text
$PI_SHARE_PUBLIC_URL/<unique-id>
```

JSONL shares keep an extension:

```text
$PI_SHARE_PUBLIC_URL/<unique-id>.jsonl
```

The unique ID is generated locally with `crypto.randomUUID()`, so the extension does not list or search local files or R2 objects and will not overwrite existing shares in practice.
