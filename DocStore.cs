using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

public class DocState(string id)
{
    public string Id { get; } = id;
    public Rga Doc = new();
    public bool Persisted;
    public bool Dirty;
    public int Viewers;
    public DateTime LastTouched = DateTime.UtcNow;
    public readonly SemaphoreSlim Lock = new(1, 1);
}

/// Keeps live documents in memory, the SQLite copy is written behind by DocFlusher.
public class DocStore(IServiceScopeFactory scopes)
{
    public const int MaxLength = 1_000_000;
    readonly ConcurrentDictionary<string, DocState> _docs = new();
    readonly SemaphoreSlim _loadLock = new(1, 1);

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
            }
            _docs[id] = s;
            return s;
        }
        finally { _loadLock.Release(); }
    }

    public static bool TryApply(DocState s, System.Text.Json.JsonElement ops)
    {
        if (!s.Doc.Apply(ops, MaxLength)) return false;
        s.Dirty = true;
        s.LastTouched = DateTime.UtcNow;
        return true;
    }

    public async Task Flush(bool evict)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        var now = DateTime.UtcNow;
        foreach (var s in _docs.Values)
        {
            if (s.Dirty)
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
                    db.Documents.Add(new Document { Id = s.Id, State = state, Content = content, Title = title, CreatedAt = now, UpdatedAt = now });
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
            foreach (var d in await db.Documents.Where(d => missing.Contains(d.Id)).Select(d => new { d.Id, d.Title }).ToListAsync())
                result[d.Id] = d.Title;
        }
        return result;
    }

    /// First non-empty line, stripped of leading markdown syntax.
    public static string TitleOf(string md)
    {
        foreach (var raw in md.AsSpan().EnumerateLines())
        {
            var line = Regex.Replace(Regex.Replace(raw.ToString(), "&#x([0-9a-fA-F]+);", m => char.ConvertFromUtf32(Convert.ToInt32(m.Groups[1].Value, 16))), @"\\(.)", "$1").Trim().TrimStart("#>-*+ ".ToCharArray()).Trim();
            if (line.Length == 0) continue;
            return line.Length > 80 ? line[..80] : line;
        }
        return "";
    }
}

public class DocFlusher(DocStore store, ILogger<DocFlusher> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                try { await store.Flush(evict: true); }
                catch (Exception e) { log.LogError(e, "Flush failed"); }
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
