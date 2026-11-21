using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;

namespace SharedMarkdown;

/// Relays RGA operations between clients editing the same document and keeps the server replica
/// (which is what gets persisted and handed to new joiners). Merging is entirely the CRDT's job.
/// Error and status strings are the wire contract in HubContract.cs.
public class DocHub(DocStore store, IpGuard guard, LimitsService limits, AppShell shell, ILogger<DocHub> log) : Hub
{
    /// Cursor messages relayed per connection per second; more are dropped (the client sends far fewer).
    public const int CursorsPerSecond = 20;

    /// Per-connection state, kept in Context.Items.
    sealed class Conn(string ip)
    {
        public string Ip { get; } = ip;
        /// Counted in IpGuard's connections (released on disconnect).
        public bool Counted;
        /// Joined through a read-only link: receives everything, may change nothing.
        public bool ReadOnly;
        /// The joined document.
        public DocState? Doc;
        /// Random id shown to other clients (the SignalR connection id stays private).
        public string Peer { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(6));
        public long CursorWindow;
        public int Cursors;
    }

    Conn C => (Conn)Context.Items[typeof(Conn)]!;

    public override Task OnConnectedAsync()
    {
        var conn = new Conn(IpGuard.IpOf(Context.GetHttpContext()));
        Context.Items[typeof(Conn)] = conn;
        if (guard.IsBlocked(conn.Ip) || !guard.TryConnect(conn.Ip, limits.Current.MaxConnectionsPerIp))
        {
            log.LogInformation("Refused connection from {Ip}", conn.Ip);
            Context.Abort();
            return Task.CompletedTask;
        }
        conn.Counted = true;
        return Task.CompletedTask;
    }

    /// The current client build. Clients call this first after every (re)connect and reload when it
    /// differs from theirs, so tabs left open across a deploy never talk an outdated protocol.
    /// Keep this method's signature stable forever.
    public string Version() => shell.Build;

    public async Task<JoinResult> Join(string id)
    {
        if (!DocIds.EditId().IsMatch(id)) throw new HubException(HubErrors.BadId);
        await Admit(readOnly: false);
        if (store.IsDeleted(id)) throw new HubException(HubErrors.Deleted);
        return await JoinDoc(id);
    }

    /// Joins through a read-only link. Same result as Join, which contains nothing that reveals the edit id.
    public async Task<JoinResult> JoinRead(string readId)
    {
        if (!DocIds.ReadId().IsMatch(readId)) throw new HubException(HubErrors.BadId);
        await Admit(readOnly: true);
        if (store.IsDeletedReadId(readId)) throw new HubException(HubErrors.Deleted);
        if (await store.ResolveReadId(readId) is not string id) throw new HubException(HubErrors.NotFound);
        return await JoinDoc(id);
    }

    /// Common to both joins: rate limit, leave the current document, set the mode.
    async Task Admit(bool readOnly)
    {
        if (!guard.TryTake("join", C.Ip, limits.Current.JoinsPerIpPerMinute, TimeSpan.FromMinutes(1)))
            throw new HubException(HubErrors.Rate);
        await LeaveCurrent();
        // Read-only before joining the group, so there's no moment where a read-only connection could edit.
        C.ReadOnly = readOnly;
    }

    /// The read-only link's id for the joined document, created on first request. Editors only.
    public async Task<string> ReadLink(string id)
    {
        if (C.ReadOnly || C.Doc is not DocState s || s.Id != id) throw new HubException(HubErrors.Invalid);
        await s.Lock.WaitAsync();
        try
        {
            if (s.Deleted) throw new HubException(HubErrors.Deleted);
            // A read link for a document nobody wrote in yet saves it, so it counts as creating one.
            if (s.IsNew)
            {
                if (!guard.TryTake("create", C.Ip, limits.Current.DocumentsPerIpPerHour, TimeSpan.FromHours(1))) throw new HubException(HubErrors.Create);
                s.CreatorIp = C.Ip;
            }
            return store.EnsureReadId(s);
        }
        finally { s.Lock.Release(); }
    }

    async Task<JoinResult> JoinDoc(string id)
    {
        while (true)
        {
            var s = await store.Get(id);
            int viewers;
            string state;
            await s.Lock.WaitAsync();
            try
            {
                if (s.Deleted) throw new HubException(HubErrors.Deleted);
                if (s.Evicted) continue; // dropped from memory after Get returned it: load it again
                // Joining the group and taking the snapshot under the lock means no op falls between them.
                // An op may still arrive before this method returns; clients buffer it (integration is idempotent).
                await Groups.AddToGroupAsync(Context.ConnectionId, id);
                C.Doc = s;
                viewers = ++s.Viewers;
                state = s.Doc.Encode();
            }
            finally { s.Lock.Release(); }
            await Clients.Group(id).SendAsync("presence", viewers);
            await Clients.OthersInGroup(id).SendAsync("peer"); // others re-announce their cursors
            using var json = JsonDocument.Parse(state);
            var l = limits.Current;
            return new JoinResult(json.RootElement.Clone(), l.MaxDocumentChars, l.MaxImageDimension);
        }
    }

    /// Returns SubmitStatus.Ok, or why the batch was refused (see SubmitStatus). Read-only connections are
    /// refused here, not just in the client.
    public async Task<string> Submit(string id, JsonElement ops)
    {
        if (C.ReadOnly) return SubmitStatus.ReadOnly;
        if (C.Doc is not DocState s || s.Id != id) return store.IsDeleted(id) ? SubmitStatus.Deleted : SubmitStatus.Invalid;
        var l = limits.Current;
        if (!guard.TryTake("submit", C.Ip, l.SubmitsPerIpPerMinute, TimeSpan.FromMinutes(1))) return SubmitStatus.Rate;
        await s.Lock.WaitAsync();
        try
        {
            if (s.Deleted) return SubmitStatus.Deleted;
            switch (s.Doc.Check(ops, l.MaxDocumentChars, l.MaxDocumentItems, out var batch))
            {
                case Rga.ApplyResult.Invalid: return SubmitStatus.Invalid;
                case Rga.ApplyResult.TooLarge: return SubmitStatus.Size;
            }
            // The first characters create the document; only a batch that is applied counts against the limit.
            var creating = s.IsNew && batch!.Grow > 0;
            if (creating && !guard.TryTake("create", C.Ip, l.DocumentsPerIpPerHour, TimeSpan.FromHours(1))) return SubmitStatus.Create;
            s.Doc.Apply(batch!);
            if (creating) s.CreatorIp = C.Ip;
            s.Dirty = true;
            s.Touch();
            // Sent while holding the lock so every client receives ops in the order the server applied them.
            await Clients.OthersInGroup(id).SendAsync("ops", ops);
            return SubmitStatus.Ok;
        }
        finally { s.Lock.Release(); }
    }

    /// Cursor position as an RGA anchor: the id of the character before it ("" = document start).
    /// Read-only viewers are counted in presence but their carets aren't shown.
    public async Task Cursor(string client, long clock)
    {
        var c = C;
        if (c.Doc is not DocState s || c.ReadOnly || client.Length > 32) return;
        var now = Environment.TickCount64;
        if (now - c.CursorWindow >= 1000) { c.CursorWindow = now; c.Cursors = 0; }
        if (++c.Cursors > CursorsPerSecond) return;
        await Clients.OthersInGroup(s.Id).SendAsync("cursor", c.Peer, client, clock);
    }

    public override async Task OnDisconnectedAsync(Exception? e)
    {
        if (C.Counted) guard.Disconnect(C.Ip);
        await LeaveCurrent();
    }

    async Task LeaveCurrent()
    {
        if (C.Doc is not DocState s) return;
        C.Doc = null;
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, s.Id);
        if (!C.ReadOnly) await Clients.Group(s.Id).SendAsync("cursor", C.Peer, null, 0);
        int viewers;
        await s.Lock.WaitAsync();
        try { viewers = --s.Viewers; } finally { s.Lock.Release(); }
        s.Touch();
        await Clients.Group(s.Id).SendAsync("presence", viewers);
    }
}
