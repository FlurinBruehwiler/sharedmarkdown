using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;

namespace SharedMarkdown;

/// Relays RGA operations between clients editing the same document and keeps the server replica
/// (which is what gets persisted and handed to new joiners). Merging is entirely the CRDT's job.
public partial class DocHub(DocStore store) : Hub
{
    [GeneratedRegex("^[A-Za-z0-9]{8,32}$")]
    public static partial Regex IdPattern();

    const string DocKey = "doc";
    DocState? Current => Context.Items.TryGetValue(DocKey, out var v) ? v as DocState : null;

    /// Random per-connection id shown to other clients (the SignalR connection id stays private).
    string Peer => (string)(Context.Items.TryGetValue("peer", out var p) ? p! : Context.Items["peer"] = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(6)));

    public async Task<JsonElement> Join(string id)
    {
        if (!IdPattern().IsMatch(id)) throw new HubException("bad id");
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
        return JsonDocument.Parse(state).RootElement;
    }

    public async Task<bool> Submit(string id, JsonElement ops)
    {
        if (Current is not DocState s || s.Id != id) return false;
        await s.Lock.WaitAsync();
        try
        {
            if (!DocStore.TryApply(s, ops)) return false;
            // Sent while holding the lock so every client receives ops in the order the server applied them.
            await Clients.OthersInGroup(id).SendAsync("ops", ops);
            return true;
        }
        finally { s.Lock.Release(); }
    }

    /// Cursor position as an RGA anchor: the id of the character before it ("" = document start).
    public async Task Cursor(string client, long clock)
    {
        if (Current is DocState s)
            await Clients.OthersInGroup(s.Id).SendAsync("cursor", Peer, client, clock);
    }

    public override Task OnDisconnectedAsync(Exception? e) => LeaveCurrent();

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
