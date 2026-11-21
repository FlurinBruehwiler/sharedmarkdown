using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

public class DocState(string id)
{
    public string Id { get; } = id;
    public Rga Doc = new();
    public bool Persisted;
    public bool Dirty;
    public bool Deleted;
    public string CreatorIp = "";
    /// Id of the read-only link (/r/{ReadId}), null until someone asks for one. Never sent to editors' peers.
    public string? ReadId;
    public int Viewers;
    public DateTime LastTouched = DateTime.UtcNow;
    public readonly SemaphoreSlim Lock = new(1, 1);

    /// True until the first edit (or read link); that counts as creating the document.
    public bool IsNew => !Persisted && Doc.Items == 0 && ReadId == null;
}

/// Keeps live documents in memory, the SQLite copy is written behind by DocFlusher.
public class DocStore(IServiceScopeFactory scopes, IHubContext<DocHub> hub, ILogger<DocStore> log)
{
    readonly ConcurrentDictionary<string, DocState> _docs = new();
    /// Read id -> edit id, for the documents in _docs that have one.
    readonly ConcurrentDictionary<string, string> _readIds = new();
    readonly SemaphoreSlim _loadLock = new(1, 1);

    public int LiveCount => _docs.Count;

    public async Task<DocState> Get(string id)
    {
        if (_docs.TryGetValue(id, out var s)) { s.LastTouched = DateTime.UtcNow; return s; }
        await _loadLock.WaitAsync();
        try
        {
            if (_docs.TryGetValue(id, out s)) return s;
            s = new DocState(id);
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            var row = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id);
            if (row != null)
            {
                s.Doc = Rga.Decode(row.State);
                s.Persisted = true;
                s.CreatorIp = row.CreatorIp;
                s.ReadId = row.ReadId;
                if (row.ReadId != null) _readIds[row.ReadId] = id;
                // Nobody has it open (it wasn't in memory), so this is a safe moment to drop tombstones.
                // Clients that reconnect with edits against the old ids fall back to a text merge.
                if (s.Doc.Items - s.Doc.Length > Math.Max(1000, s.Doc.Length))
                {
                    log.LogInformation("Compacting {Doc}: {Items} items, {Length} visible", id, s.Doc.Items, s.Doc.Length);
                    s.Doc = Rga.Compacted(s.Doc.Text());
                    s.Dirty = true;
                }
            }
            _docs[id] = s;
            return s;
        }
        finally { _loadLock.Release(); }
    }

    /// The edit id of the document with this read id, or null if there is none.
    public async Task<string?> ResolveReadId(string readId)
    {
        if (_readIds.TryGetValue(readId, out var id)) return id;
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        return await db.Documents.Where(d => d.ReadId == readId).Select(d => d.Id).FirstOrDefaultAsync();
    }

    /// The document's read id, made up on first use. Saved with the next flush (a new, empty document
    /// gets its row then too, so the link keeps working). Call with s.Lock held.
    public string EnsureReadId(DocState s)
    {
        if (s.ReadId != null) return s.ReadId;
        // 16 base62 characters (~95 bits), independent of the edit id; a different length than edit
        // ids so the two kinds of link are easy to tell apart.
        s.ReadId = RandomNumberGenerator.GetString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 16);
        _readIds[s.ReadId] = s.Id;
        s.Dirty = true;
        return s.ReadId;
    }

    public async Task Flush(bool evict)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        var now = DateTime.UtcNow;
        foreach (var s in _docs.Values)
        {
            if (s.Dirty && !s.Deleted)
            {
                string content, state;
                string? readId;
                await s.Lock.WaitAsync();
                try { content = s.Doc.Text(); state = s.Doc.Encode(); readId = s.ReadId; s.Dirty = false; }
                finally { s.Lock.Release(); }

                var title = TitleOf(content);
                if (s.Persisted)
                {
                    await db.Documents.Where(d => d.Id == s.Id).ExecuteUpdateAsync(u => u
                        .SetProperty(d => d.State, state)
                        .SetProperty(d => d.Content, content)
                        .SetProperty(d => d.Title, title)
                        .SetProperty(d => d.ReadId, readId)
                        .SetProperty(d => d.UpdatedAt, now));
                }
                else
                {
                    db.Documents.Add(new Document { Id = s.Id, State = state, Content = content, Title = title, CreatorIp = s.CreatorIp, ReadId = readId, CreatedAt = now, UpdatedAt = now });
                    await db.SaveChangesAsync();
                    db.ChangeTracker.Clear();
                    s.Persisted = true;
                }
            }
            else if (evict && s.Viewers == 0 && now - s.LastTouched > TimeSpan.FromMinutes(5))
            {
                _docs.TryRemove(s.Id, out _);
                if (s.ReadId != null) _readIds.TryRemove(s.ReadId, out _);
            }
        }
    }

    /// Deletes documents (admin action); anyone viewing them is told and stops syncing.
    public async Task Delete(IReadOnlyCollection<string> ids)
    {
        foreach (var id in ids)
            if (_docs.TryRemove(id, out var s))
            {
                s.Deleted = true;
                if (s.ReadId != null) _readIds.TryRemove(s.ReadId, out _);
            }
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        foreach (var chunk in ids.Chunk(500))
            await db.Documents.Where(d => chunk.Contains(d.Id)).ExecuteDeleteAsync();
        foreach (var id in ids)
            await hub.Clients.Group(id).SendAsync("deleted");
        log.LogInformation("Deleted {Count} documents", ids.Count);
    }

    /// Titles by edit id, plus titles of read-only links keyed "r/{readId}" (never revealing the edit id).
    public async Task<Dictionary<string, string>> Titles(IEnumerable<string> ids, IEnumerable<string>? readIds = null)
    {
        var result = new Dictionary<string, string>();
        var missingRead = new List<string>();
        foreach (var r in readIds ?? [])
        {
            if (_readIds.TryGetValue(r, out var editId) && _docs.TryGetValue(editId, out var rs)) result["r/" + r] = TitleOf(rs.Doc.Text());
            else missingRead.Add(r);
        }
        if (missingRead.Count > 0)
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            foreach (var d in await db.Documents.Where(d => d.ReadId != null && missingRead.Contains(d.ReadId)).Select(d => new { d.ReadId, Head = d.Content.Substring(0, 4000) }).ToListAsync())
                result["r/" + d.ReadId] = TitleOf(d.Head);
        }
        var missing = new List<string>();
        foreach (var id in ids)
        {
            if (_docs.TryGetValue(id, out var s)) result[id] = TitleOf(s.Doc.Text());
            else missing.Add(id);
        }
        if (missing.Count > 0)
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            // Computed from the text rather than the stored Title, so documents saved before a change to
            // TitleOf get the current rules too. The title is in the first lines; 4000 chars is plenty.
            foreach (var d in await db.Documents.Where(d => missing.Contains(d.Id)).Select(d => new { d.Id, Head = d.Content.Substring(0, 4000) }).ToListAsync())
                result[d.Id] = TitleOf(d.Head);
        }
        return result;
    }

    /// First line with text, without markdown syntax: images dropped, links reduced to their text.
    /// Mirrors titleOf in client/src/main.ts.
    public static string TitleOf(string md)
    {
        foreach (var raw in md.AsSpan().EnumerateLines())
        {
            var line = raw.ToString();
            line = Regex.Replace(line, @"!\[[^\]]*\]\([^)]*\)", "");
            line = Regex.Replace(line, @"\[([^\]]*)\]\([^)]*\)", "$1");
            line = Regex.Replace(line, @"\*\*|__|~~|==|`", "");
            line = Regex.Replace(line, @"\\(.)", "$1").Trim();
            line = Regex.Replace(line, @"^([#>\-*+]+|\d+[.)])(\s+|$)", "");
            line = Regex.Replace(line, @"^\[[ xX]\]\s+", "").Trim();
            if (line.Length == 0) continue;
            return line.Length > 80 ? line[..80] : line;
        }
        return "";
    }

}

public class DocFlusher(DocStore store, IpGuard guard, ILogger<DocFlusher> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        var ticks = 0;
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                try { await store.Flush(evict: true); }
                catch (Exception e) { log.LogError(e, "Flush failed"); }
                if (++ticks % 300 == 0) guard.Prune();
            }
        }
        catch (OperationCanceledException) { }
    }

    public override async Task StopAsync(CancellationToken ct)
    {
        await base.StopAsync(ct);
        await store.Flush(evict: false);
    }
}
