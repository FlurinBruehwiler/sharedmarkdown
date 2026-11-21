using System.Collections.Concurrent;
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
    public int Viewers;
    public DateTime LastTouched = DateTime.UtcNow;
    public readonly SemaphoreSlim Lock = new(1, 1);

    /// True until the first edit; that edit counts as creating the document.
    public bool IsNew => !Persisted && Doc.Items == 0;
}

/// Keeps live documents in memory, the SQLite copy is written behind by DocFlusher.
public class DocStore(IServiceScopeFactory scopes, IHubContext<DocHub> hub, ILogger<DocStore> log)
{
    readonly ConcurrentDictionary<string, DocState> _docs = new();
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
                await s.Lock.WaitAsync();
                try { content = s.Doc.Text(); state = s.Doc.Encode(); s.Dirty = false; }
                finally { s.Lock.Release(); }

                var title = TitleOf(content);
                if (s.Persisted)
                {
                    await db.Documents.Where(d => d.Id == s.Id).ExecuteUpdateAsync(u => u
                        .SetProperty(d => d.State, state)
                        .SetProperty(d => d.Content, content)
                        .SetProperty(d => d.Title, title)
                        .SetProperty(d => d.UpdatedAt, now));
                }
                else
                {
                    db.Documents.Add(new Document { Id = s.Id, State = state, Content = content, Title = title, CreatorIp = s.CreatorIp, CreatedAt = now, UpdatedAt = now });
                    await db.SaveChangesAsync();
                    db.ChangeTracker.Clear();
                    s.Persisted = true;
                }
            }
            else if (evict && s.Viewers == 0 && now - s.LastTouched > TimeSpan.FromMinutes(5))
            {
                _docs.TryRemove(s.Id, out _);
            }
        }
    }

    /// Deletes documents (admin action); anyone viewing them is told and stops syncing.
    public async Task Delete(IReadOnlyCollection<string> ids)
    {
        foreach (var id in ids)
            if (_docs.TryRemove(id, out var s)) s.Deleted = true;
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        foreach (var chunk in ids.Chunk(500))
            await db.Documents.Where(d => chunk.Contains(d.Id)).ExecuteDeleteAsync();
        foreach (var id in ids)
            await hub.Clients.Group(id).SendAsync("deleted");
        log.LogInformation("Deleted {Count} documents", ids.Count);
    }

    public async Task<Dictionary<string, string>> Titles(IEnumerable<string> ids)
    {
        var result = new Dictionary<string, string>();
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
