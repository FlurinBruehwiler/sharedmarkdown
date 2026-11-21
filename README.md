# SharedMarkdown

Markdown you share with a link. No accounts: open the site, write, send the URL, edit together in real time.
Paste a document's link into another document to connect them; linked documents show up in the sidebar.

## Run locally

```bash
dotnet run
```

Needs the .NET 11 SDK and Node (the build bundles `client/` into `dist/` automatically). Data goes to `./data/`, or to `DataDir` if set.
The admin dashboard is at `/admin`; it is disabled until a password is set:

```bash
Admin__Password=something dotnet run
```

## How it works

- **Backend** (ASP.NET Core, one process): SignalR hub `DocHub.cs`, SQLite via EF Core with migrations (`Data.cs`, `Migrations/`), images stored in SQLite (`/api/blobs`, served from `/b/{sha}`), admin dashboard in Blazor Server (`Components/`).
- **Real-time sync**: a hand-written RGA sequence CRDT over the markdown text, identical in `Rga.cs` and `client/src/rga.js`. The server keeps a replica, writes it to SQLite every 2 s (`DocStore.cs`) and relays ops. Deleted characters are compacted away when a document is loaded. Other people's cursors are sent as CRDT anchors and drawn as unlabeled carets.
- **Frontend**: plain JS + [CodeMirror 6](https://codemirror.net). `client/src/livepreview.js` does Obsidian-style live preview. A ~60-line SignalR client (`client/src/hub.js`) and sync glue (`client/src/sync.js`).
- **Assets**: one content-hashed JS file (`Cache-Control: immutable`), CSS inlined into the HTML, pre-compressed (brotli/gzip) in memory at startup (`Assets.cs`). After a deploy, open tabs notice the new build on reconnect and reload, keeping unsent edits.

## Abuse protection

All limits are per client IP (IPv6 grouped by /64), have defaults in `appsettings.json` (`Limits` section, or `Limits__…` environment variables) and can be changed live in the admin dashboard:

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

The admin dashboard shows usage, lists documents and images (searchable, filterable by IP, deletable one by one or per IP), blocks IPs, edits limits and makes/downloads backups.

## Security notes

- The document URL is the only access control (12 random base62 characters, ~71 bits). Pages send `Referrer-Policy: no-referrer` so the URL never leaks to linked sites, and `X-Robots-Tag: noindex`.
- The editor page has a strict Content-Security-Policy (only the bundled script and the hashed inline theme script run).
- Admin login is a single password (`Admin:Password`), compared in constant time, rate limited, with an HttpOnly SameSite=Strict cookie. Use a long random password.

## Test

```bash
cd client && npm run check && npm test
```

## Deploy

Push to `master`: `.github/workflows/ci.yml` runs the tests, publishes a self-contained linux-x64 build, copies it to the server and restarts the `sharedmarkdown` systemd unit.

One-time server setup:

1. User `sharedmarkdown`, folders `/opt/sharedmarkdown/{releases,data}` owned by it.
2. `deploy/sharedmarkdown.service` → `/etc/systemd/system/`, then `systemctl enable sharedmarkdown`.
3. `/opt/sharedmarkdown/sharedmarkdown.env` (mode 600) with `Admin__Password=<long random password>`.
4. Caddy as the reverse proxy: add the site block from `deploy/Caddyfile` and `systemctl reload caddy`. It handles TLS, WebSockets and `X-Forwarded-For`. If the proxy isn't on the same machine, add its IP to `KnownProxies`.
5. GitHub secret `DEPLOY_SSH_PRIVATE_KEY`, and passwordless sudo for `systemctl restart sharedmarkdown`.
6. Copy `/opt/sharedmarkdown/data/backups` off the server regularly (daily backups are kept 14 days on the same disk).

Data folder: `sharedmarkdown.db` (documents, images, settings), `backups/`, `keys/` (login cookie keys; keep them, or the admin is logged out).
