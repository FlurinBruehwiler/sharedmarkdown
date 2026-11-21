# SharedMarkdown

Markdown you share with a link. No accounts: open the site, write, send the URL, edit together in real time.
Paste a document's link into another document to connect them; linked documents show up in the sidebar.

## Run

```bash
dotnet run
```

Needs the .NET 11 SDK and Node (the build bundles `client/` into `dist/` automatically). Data goes to `./data/sharedmarkdown.db`, or to `DataDir` if set.

## How it works

- **Backend** (ASP.NET Core): SignalR hub `DocHub.cs`, SQLite via EF Core (`Data.cs`), images stored as blobs (`/api/blobs`, served from `/b/{sha}`).
- **Real-time sync**: a hand-written RGA sequence CRDT over the markdown text, identical in `Rga.cs` and `client/src/rga.js`. The server keeps a replica, persists it (`DocStore.cs`, write-behind every 2 s), and relays ops. Other people's cursors are sent as CRDT anchors and drawn as unlabeled carets.
- **Frontend**: plain JS + [CodeMirror 6](https://codemirror.net) (`client/src/main.js`). `client/src/livepreview.js` does Obsidian-style live preview: plain markdown text, styled with decorations, syntax markers hidden except on the cursor's line. Plus a ~60-line SignalR client (`client/src/hub.js`) and sync glue (`client/src/sync.js`).
- **Assets**: one content-hashed JS file (`Cache-Control: immutable`), CSS inlined into the HTML, everything pre-compressed (brotli/gzip) in memory at startup (`Assets.cs`).

## Test

```bash
node client/test/rga.test.mjs
```

## Deploy

Push to `master`: `.github/workflows/ci.yml` publishes a self-contained linux-x64 build, copies it to the server and restarts the `sharedmarkdown` systemd unit (`deploy/sharedmarkdown.service`). Put a TLS reverse proxy in front that forwards WebSocket upgrades for `/hub`.
