using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;

namespace SharedMarkdown;

/// Relays RGA operations between clients editing the same document and keeps the server replica
/// (which is what gets persisted and handed to new joiners). Merging is entirely the CRDT's job.
public partial class DocHub(DocStore store, IpGuard guard, LimitsService limits, Assets assets, ILogger<DocHub> log) : Hub
{
    [GeneratedRegex("^[A-Za-z0-9]{8,32}$")]
    public static partial Regex IdPattern();

    const string DocKey = "doc", IpKey = "ip", CountedKey = "counted";
    DocState? Current => Context.Items.TryGetValue(DocKey, out var v) ? v as DocState : null;
    string Ip => (string)Context.Items[IpKey]!;

    /// Random per-connection id shown to other clients (the SignalR connection id stays private).
    string Peer => (string)(Context.Items.TryGetValue("peer", out var p) ? p! : Context.Items["peer"] = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(6)));

    public override Task OnConnectedAsync()
    {
        var ip = IpGuard.IpOf(Context.GetHttpContext());
        Context.Items[IpKey] = ip;
        if (guard.IsBlocked(ip) || !guard.TryConnect(ip, limits.Current.MaxConnectionsPerIp))
        {
            log.LogInformation("Refused connection from {Ip}", ip);
            Context.Abort();
            return Task.CompletedTask;
        }
        Context.Items[CountedKey] = true;
        return Task.CompletedTask;
    }

    /// The current client build. Clients call this first after every (re)connect and reload when it
    /// differs from theirs, so tabs left open across a deploy never talk an outdated protocol.
    /// Keep this method's signature stable forever.
    public string Version() => assets.Build;

    public async Task<object> Join(string id)
    {
        if (!IdPattern().IsMatch(id)) throw new HubException("bad id");
        if (!guard.TryTake("join", Ip, limits.Current.JoinsPerIpPerMinute, TimeSpan.FromMinutes(1)))
            throw new HubException("rate");
        await LeaveCurrent();

        var s = await store.Get(id);
        int viewers;
        string state;
        await s.Lock.WaitAsync();
        try
        {
            // Joining the group and taking the snapshot under the lock means no op falls between them.
            // An op may still arrive before this method returns; clients buffer it (integration is idempotent).
            await Groups.AddToGroupAsync(Context.ConnectionId, id);
            Context.Items[DocKey] = s;
            viewers = ++s.Viewers;
            state = s.Doc.Encode();
        }
        finally { s.Lock.Release(); }
        await Clients.Group(id).SendAsync("presence", viewers);
        await Clients.OthersInGroup(id).SendAsync("peer"); // others re-announce their cursors
        return new { state = JsonDocument.Parse(state).RootElement, maxChars = limits.Current.MaxDocumentChars, maxImageDimension = limits.Current.MaxImageDimension };
    }

    /// Returns "ok", or why the batch was refused: "invalid", "size", "create" (too many new documents) or "rate".
    public async Task<string> Submit(string id, JsonElement ops)
    {
        if (Current is not DocState s || s.Id != id || s.Deleted) return "invalid";
        var l = limits.Current;
        if (!guard.TryTake("submit", Ip, l.SubmitsPerIpPerMinute, TimeSpan.FromMinutes(1))) return "rate";
        await s.Lock.WaitAsync();
        try
        {
            var creating = s.IsNew;
            if (creating && !guard.TryTake("create", Ip, l.DocumentsPerIpPerHour, TimeSpan.FromHours(1))) return "create";
            switch (s.Doc.Apply(ops, l.MaxDocumentChars, l.MaxDocumentItems))
            {
                case Rga.ApplyResult.Invalid: return "invalid";
                case Rga.ApplyResult.TooLarge: return "size";
            }
            if (creating) s.CreatorIp = Ip;
            s.Dirty = true;
            s.LastTouched = DateTime.UtcNow;
            // Sent while holding the lock so every client receives ops in the order the server applied them.
            await Clients.OthersInGroup(id).SendAsync("ops", ops);
            return "ok";
        }
        finally { s.Lock.Release(); }
    }

    /// Cursor position as an RGA anchor: the id of the character before it ("" = document start).
    public async Task Cursor(string client, long clock)
    {
        if (Current is DocState s && client.Length <= 32)
            await Clients.OthersInGroup(s.Id).SendAsync("cursor", Peer, client, clock);
    }

    public override async Task OnDisconnectedAsync(Exception? e)
    {
        if (Context.Items.ContainsKey(CountedKey)) guard.Disconnect(Ip);
        await LeaveCurrent();
    }

    async Task LeaveCurrent()
    {
        if (Current is not DocState s) return;
        Context.Items.Remove(DocKey);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, s.Id);
        await Clients.Group(s.Id).SendAsync("cursor", Peer, null, 0);
        int viewers;
        await s.Lock.WaitAsync();
        try { viewers = --s.Viewers; s.LastTouched = DateTime.UtcNow; } finally { s.Lock.Release(); }
        await Clients.Group(s.Id).SendAsync("presence", viewers);
    }
}
