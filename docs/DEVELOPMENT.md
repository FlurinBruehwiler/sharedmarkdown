# SharedMarkdown: development notes

Markdown you share with a link. No accounts: open the site, write, send the URL, edit together in real time.
Paste a document's link into another document to connect them; linked documents show up in the sidebar.

## Run locally

```bash
dotnet run
```

Run from `src/SharedMarkdown` (or `dotnet run --project src/SharedMarkdown`). Needs the .NET 11 SDK and Node; the build type-checks and bundles `src/client` into `src/SharedMarkdown/wwwroot` and `app.html` automatically. `dotnet run` uses the Development environment (`Properties/launchSettings.json`); static assets from the build folder are only served there. Data goes to `data/` next to the project, or to `DataDir` if set.
The admin dashboard is at `/admin`; it is disabled until a password is set:

```bash
Admin__Password=something dotnet run
```

## How it works

- **Backend** (ASP.NET Core, one process): SignalR hub `Documents/DocHub.cs`, SQLite via EF Core with migrations (`Data/`), images stored in SQLite (`/api/blobs`, served from `/b/{sha}`, processed in `Images/`), abuse limits in `Protection/`, admin dashboard in Blazor Server (`Admin/`), asset serving and backups in `Infrastructure/`. All under `src/SharedMarkdown/`.
- **Real-time sync**: a hand-written RGA sequence CRDT over the markdown text, identical in `Documents/Rga.cs` and `src/client/src/rga.ts`. The server keeps a replica, writes it to SQLite every 2 s (`Documents/DocStore.cs`, `DocFlusher.cs`) and relays ops. Deleted characters are compacted away when a document that hasn't been edited for 7 days is loaded (visible characters keep their ids, so offline edits still apply). The hub's error strings and `Submit` results are the wire contract in `Documents/HubContract.cs`. Other people's cursors are sent as CRDT anchors and drawn as unlabeled carets.
- **Frontend** (`src/client/src`): TypeScript (strict) + [CodeMirror 6](https://codemirror.net), no framework, bundled by esbuild.
  - `main.ts`: wiring (hub, sync, editor, sidebar), navigation, version reload, notices, share button, theme toggle, boot.
  - `editor.ts`: the CodeMirror setup: extensions, keymap and commands, read-only mode, slash-menu items, click-to-place.
  - `livepreview.ts`: Obsidian-style live preview. `table.ts`: the table widget (pure source-model functions at the top, then the widget, then the state field and commands). `slash.ts`: the "/" menu.
  - `images.ts`: paste, shrink, upload (`upload:` placeholders), drag-and-drop. `sidebar.ts`: the document list (localStorage), title lookup, link discovery, `titleOf`.
  - `sync.ts`: `DocSync`, one open document in sync (join, flush, remote ops, cursors), and the rebase/merge of unsent edits. `rga.ts`: the CRDT. `text.ts`: diff and three-way merge. `hub.ts`: the typed SignalR client (`hubError()` reads the server's error codes). `ids.ts`: document keys (an edit id, or `r/{readId}`) and random ids.
- **Offline**: `sw.ts` (service worker, `/sw.js`) serves the last seen page when the network fails (network first, so deploys still arrive at once) and caches the hashed bundle and `/b/` images. `local.ts` keeps each opened document's RGA state, its base text (the text without this device's unsent edits) and unsent ops in IndexedDB (last 50 documents, plus any with unsent edits); without a connection a document opens from that copy, and the ops are merged through the normal rejoin when the hub reconnects. Unsent ops that no longer apply (an insert whose origin the server doesn't have) are merged as text: a three-way merge of base → this device's text into the server's text, so what others wrote meanwhile is kept; overlapping edits keep both. Edits left in documents that aren't open are sent over a second connection after reconnecting (`offline.ts`). Documents deleted by an administrator are dropped from the device and the sidebar, and never resubmitted.
- **Assets**: the bundle (`wwwroot/assets/app.js`) and service worker are ordinary static assets: `MapStaticAssets` fingerprints the bundle (`Cache-Control: immutable`) and serves it pre-compressed (gzip, plus brotli when published). The page (`app.html`, CSS inlined) is served by `Infrastructure/AppShell.cs` for every document URL with the fingerprinted bundle URL and a strict CSP. After a deploy, open tabs notice the new build on reconnect and reload, keeping unsent edits.

## Abuse protection

All limits are per client IP (IPv6 grouped by /64), have defaults in `src/SharedMarkdown/appsettings.json` (`Limits` section, or `Limits__…` environment variables) and can be changed live in the admin dashboard:

| Limit | Default |
|---|---|
| New documents per IP per hour | 100 |
| Document length | 50,000 characters |
| Stored edit history per document | 500,000 items (compacted on load) |
| Image uploads per IP per hour | 100 |
| Image upload size | 10 MB |
| Images scaled down to | 2000 px longest side |
| Open connections per IP | 30 |
| Documents opened / edit batches / title lookups per IP per minute | 120 / 1200 / 120 |
| Admin login attempts per IP per hour | 10 |

Uploaded images are decoded and re-encoded with SkiaSharp: this validates them, applies the EXIF rotation and drops all metadata (GPS position etc.). GIFs are kept as uploaded (Skia can't encode GIF; they carry no EXIF).

The admin dashboard shows usage, lists documents and images (searchable, filterable by IP, deletable one by one or per IP), blocks IPs, edits limits and makes/downloads backups and has a log explorer (day, level, search; Serilog writes `logs/sharedmarkdown-{date}.log`, 30 days kept, and the same lines go to the journal). Deleted documents stay deleted: their ids are remembered (`DeletedDocuments`), so an offline copy reconnecting later can't bring them back.

## Security notes

- The document URL is the only access control (12 random base62 characters, ~71 bits; `Documents/DocIds.cs`).
- Read-only links (`/r/{readId}`, from the arrow next to "Copy link") use a separate random id (16 base62 characters, made on first request, column `Documents.ReadId`). Connections that join with it (`DocHub.JoinRead`) get live ops, presence and others' cursors, but `Submit` refuses them server-side, their cursors aren't relayed, and nothing sent to them contains the edit id. Links inside a document are still whatever the text says (usually edit links). Pages send `Referrer-Policy: no-referrer` so the URL never leaks to linked sites, and `X-Robots-Tag: noindex` on everything but the home page (and robots.txt, the sitemap, icons and the link preview image, from `src/client/public`). Link previews of any URL show the site card, never a document's text.
- The editor page has a strict Content-Security-Policy (only the bundled script and the hashed inline theme script run).
- Admin login is a single password (`Admin:Password`), compared in constant time, rate limited, with an HttpOnly SameSite=Strict cookie. Use a long random password.

## Test

```bash
cd src/client && npm run check && npm test
dotnet test src/SharedMarkdown.Tests
```

The .NET tests (`src/SharedMarkdown.Tests`) replay `fixtures/rga.json`, random editing sessions recorded with the client's `rga.ts`, to check that `Rga.cs` integrates identically. Regenerate it after changing `rga.ts`:

```bash
cd src/client && npx esbuild test/make-rga-fixtures.ts --bundle --platform=node --format=esm --outfile=test/.out/make-rga-fixtures.mjs && node test/.out/make-rga-fixtures.mjs
```

`fixtures/titles.json` holds title cases shared by `MarkdownTitle.cs` and the client's `titleOf`.

Client tests are `src/client/test/*.test.ts` (node:test; `test/run.mjs` bundles them with esbuild): the RGA, the diff and three-way merge, the table source model, `titleOf`, and `DocSync` against a fake hub.

## Deploy

Push to `master`: `.github/workflows/ci.yml` runs the tests, publishes a self-contained linux-x64 build, copies it to the server and restarts the `sharedmarkdown` systemd unit.

One-time server setup:

1. User `sharedmarkdown`, folders `/opt/sharedmarkdown/{releases,data}` owned by it.
2. `deploy/sharedmarkdown.service` → `/etc/systemd/system/`, then `systemctl enable sharedmarkdown`.
3. `/opt/sharedmarkdown/sharedmarkdown.env` (mode 600) with `Admin__Password=<long random password>`.
4. Caddy as the reverse proxy: add the site block from `deploy/Caddyfile` and `systemctl reload caddy`. It handles TLS, WebSockets and `X-Forwarded-For`. If the proxy isn't on the same machine, add its IP to `KnownProxies`.
5. GitHub secret `DEPLOY_SSH_PRIVATE_KEY`, and passwordless sudo for `systemctl restart sharedmarkdown`.
6. Copy `/opt/sharedmarkdown/data/backups` off the server regularly (daily backups are kept 14 days on the same disk).

Data folder: `sharedmarkdown.db` (documents, images, settings), `backups/`, `logs/`, `keys/` (login cookie keys; keep them, or the admin is logged out).
