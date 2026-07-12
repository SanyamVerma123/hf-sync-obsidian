# HF Bucket Sync (for Obsidian)

Syncs your vault to a private Hugging Face repo ("bucket") over plain HTTPS,
so you can open the same notes on another device (desktop or mobile) by
entering the same bucket name and token.

## Important context

Hugging Face's brand-new "Storage Buckets" feature (`hf://buckets/...`) is
currently only reachable via their CLI, Python SDK, or a filesystem-mount
tool — HF's own docs say plain HTTP access "is on the roadmap" but not live
yet. None of that works inside an Obsidian plugin, especially on mobile.

So this plugin uses a **private Hugging Face dataset repo** as the "bucket"
instead — the same pattern as an S3 bucket, but built on an HF repo type
that *is* fully reachable over plain HTTPS. In the settings screen this is
just called "Bucket name" (format `yourname/repo-name`), so it behaves
exactly like the bucket-based workflow you're used to. If HF ships a public
HTTP API for the new native Buckets later, the client in `src/hfClient.ts`
can be pointed at it with minimal changes.

## Setup

1. Create a Hugging Face access token with **write** access:
   https://huggingface.co/settings/tokens
2. Create a **private dataset repo** to act as your bucket (or let the
   plugin create it for you the first time you hit "Test & connect"):
   https://huggingface.co/new-dataset
3. Install the plugin (see below), then in Obsidian's settings:
   - **Bucket name**: `yourname/your-repo-name`
   - **Hugging Face token**: the token from step 1
   - Click **Test & connect**
4. Repeat step 3 on your other devices, using the *same* bucket name and
   token. Everyone syncing to the same bucket will share files.

## Installing in Obsidian

### Desktop
Copy this folder's `manifest.json`, `main.js`, and `styles.css` into:
```
<YourVault>/.obsidian/plugins/hf-bucket-sync/
```
Then restart Obsidian and enable "HF Bucket Sync" under
Settings → Community plugins.

### Mobile (iOS/Android)
Use a file manager app (or the Files app / a sync tool) to place the same
three files into `<YourVault>/.obsidian/plugins/hf-bucket-sync/` inside the
vault folder on the device, then enable the plugin in Obsidian's settings.
The easiest way to get files onto mobile is usually the **BRAT** community
plugin, pointed at a GitHub repo containing these three files (see below).

### Submitting as a community plugin
To list it in Obsidian's official Community Plugins directory, push this
whole project to a public GitHub repo, create a GitHub Release with
`manifest.json`, `main.js`, and `styles.css` attached as release assets
(matching the version in `manifest.json`), then follow Obsidian's
submission guide: https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin
Until then, you can privately distribute it via the **BRAT** plugin using
your GitHub repo URL, which is the fastest way to get it onto another
device/mobile without going through the official review process.

## Building from source

```bash
npm install
npm run build   # type-checks and produces main.js
```

## How sync works

Each sync compares three things per file: your last-known-synced state
(stored locally), the current local file, and the current remote file.
- New file only one side → copied to the other side.
- Changed on one side only → propagated.
- Deleted on one side, unchanged on the other → deletion propagated.
- Deleted on one side but *edited* on the other → the edit is kept (never
  silently discarded).
- Changed on **both** sides → handled per your "Conflict handling" setting
  (default: keep both copies, with a `(conflict <device> <timestamp>)`
  suffix on the older local copy, so nothing is ever lost).

Files are capped at "Max file size to sync" (default 25 MB) since they're
transferred as inline base64 in a single commit; very large attachments are
skipped rather than synced.
