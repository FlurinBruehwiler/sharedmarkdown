using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

/// Keeps live documents in memory; the SQLite copy is written behind by Flush (DocFlusher calls it every 2 s).
public class DocStore(IServiceScopeFactory scopes, IHubContext<DocHub> hub, ILogger<DocStore> log)
{
    readonly ConcurrentDictionary<string, DocState> _docs = new();
    /// Read id -> edit id, for the documents in _docs that have one.
    readonly ConcurrentDictionary<string, string> _readIds = new();
    /// Loads in progress, so concurrent joiners of one document share a load without blocking other documents.
    readonly ConcurrentDictionary<string, Lazy<Task<DocState>>> _loading = new();
    /// Ids (edit and read) of documents deleted by the admin; they stay unusable.
    readonly ConcurrentDictionary<string, byte> _deletedIds = new(), _deletedReadIds = new();
    /// Orders "add to _docs" in Load against "mark deleted and remove" in Delete.
    readonly Lock _gate = new();
    /// One flush (or delete) at a time: concurrent ones could persist an older state last, or re-insert a deleted document.
    readonly SemaphoreSlim _flushLock = new(1, 1);

    /// Documents untouched and unviewed for this long are dropped from memory (after being saved).
    internal TimeSpan EvictAfter { get; set; } = TimeSpan.FromMinutes(5);
    /// Documents with many tombstones are compacted on load once they haven't been edited for this long,
    /// so clients that were offline in the meantime can still apply their unsent edits.
    internal TimeSpan CompactAfter { get; set; } = TimeSpan.FromDays(7);

    public int LiveCount => _docs.Count;

    public bool IsDeleted(string id) => _deletedIds.ContainsKey(id);
    public bool IsDeletedReadId(string readId) => _deletedReadIds.ContainsKey(readId);

    /// Loads the deleted ids; call once at startup.
    public async Task LoadDeleted()
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        await foreach (var d in db.DeletedDocuments.AsNoTracking().AsAsyncEnumerable())
        {
            _deletedIds[d.Id] = 0;
            if (d.ReadId != null) _deletedReadIds[d.ReadId] = 0;
        }
    }

    /// The document, loaded if needed. The result can be Deleted (don't use it) or, by the time its lock is
    /// taken, Evicted (call Get again).
    public async Task<DocState> Get(string id)
    {
        if (_docs.TryGetValue(id, out var s)) { s.Touch(); return s; }
        var load = _loading.GetOrAdd(id, i => new Lazy<Task<DocState>>(() => Load(i)));
        try { return await load.Value; }
        finally { _loading.TryRemove(KeyValuePair.Create(id, load)); }
    }

    async Task<DocState> Load(string id)
    {
        if (_docs.TryGetValue(id, out var s)) return s;
        s = new DocState(id);
        if (IsDeleted(id)) { s.Deleted = true; return s; }
        using (var scope = scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            var row = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id);
            if (row != null)
            {
                s.Doc = Rga.Decode(row.State);
                s.Persisted = true;
                s.CreatorIp = row.CreatorIp;
                s.ReadId = row.ReadId;
                s.Title = row.Title;
                s.UpdatedAt = row.UpdatedAt;
                // Nobody has it open (it wasn't in memory), so this is a safe moment to drop tombstones. Visible
                // characters keep their ids; only edits from clients offline since before the compaction that
                // insert next to a dropped tombstone fail (the client then falls back to a text merge), hence the wait.
                if (s.Doc.Tombstones > Math.Max(1000, s.Doc.Length) && DateTime.UtcNow - row.UpdatedAt > CompactAfter)
                {
                    log.LogInformation("Compacting {Doc}: {Items} items, {Length} visible", id, s.Doc.Items, s.Doc.Length);
                    s.Doc.Compact();
                    // Not marked dirty: it's saved with the next edit, and compacting again on the next load gives the same result.
                }
            }
        }
        lock (_gate)
        {
            if (IsDeleted(id)) { s.Deleted = true; return s; }
            if (_docs.TryGetValue(id, out var existing)) return existing;
            _docs[id] = s;
            if (s.ReadId != null) _readIds[s.ReadId] = id;
        }
        return s;
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
        s.ReadId = DocIds.NewReadId();
        _readIds[s.ReadId] = s.Id;
        s.Dirty = true;
        return s.ReadId;
    }

    /// Saves changed documents; with `evict`, drops idle ones from memory. A document that fails to save
    /// stays dirty (retried next time) and doesn't stop the others.
    public async Task Flush(bool evict)
    {
        await _flushLock.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            foreach (var s in _docs.Values)
            {
                try
                {
                    if (!await Save(db, s) && evict) TryEvict(s);
                }
                catch (Exception e)
                {
                    log.LogError(e, "Saving {Doc} failed", s.Id);
                    await s.Lock.WaitAsync();
                    try { if (!s.Deleted) s.Dirty = true; } finally { s.Lock.Release(); }
                }
            }
        }
        finally { _flushLock.Release(); }
    }

    /// Writes the document if it changed. Call with _flushLock held.
    async Task<bool> Save(AppDb db, DocState s)
    {
        string content, state, creatorIp;
        string? readId;
        await s.Lock.WaitAsync();
        try
        {
            if (!s.Dirty || s.Deleted) return false;
            content = s.Doc.Text();
            state = s.Doc.Encode();
            readId = s.ReadId;
            creatorIp = s.CreatorIp;
            s.Dirty = false;
        }
        finally { s.Lock.Release(); }

        var title = MarkdownTitle.Of(content);
        var now = DateTime.UtcNow;
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO Documents (Id, State, Content, Title, CreatorIp, ReadId, CreatedAt, UpdatedAt)
            VALUES ({s.Id}, {state}, {content}, {title}, {creatorIp}, {readId}, {now}, {now})
            ON CONFLICT (Id) DO UPDATE SET State = excluded.State, Content = excluded.Content, Title = excluded.Title,
                ReadId = excluded.ReadId, UpdatedAt = excluded.UpdatedAt
            """);
        s.Title = title;
        await s.Lock.WaitAsync();
        try { s.Persisted = true; s.UpdatedAt = now; } finally { s.Lock.Release(); }
        return true;
    }

    /// Drops an idle, saved document from memory. Under its lock, so a concurrent joiner either gets in first
    /// (Viewers > 0, not evicted) or sees Evicted and loads it again.
    void TryEvict(DocState s)
    {
        if (!s.Lock.Wait(0)) return;
        try
        {
            if (s.Viewers > 0 || s.Dirty || s.Deleted || Environment.TickCount64 - s.LastTouched < EvictAfter.TotalMilliseconds) return;
            s.Evicted = true;
            _docs.TryRemove(KeyValuePair.Create(s.Id, s));
            if (s.ReadId != null) _readIds.TryRemove(KeyValuePair.Create(s.ReadId, s.Id));
        }
        finally { s.Lock.Release(); }
    }

    /// Deletes documents (admin action) for good: their ids can't be used again. Anyone viewing them is told
    /// and stops syncing.
    public async Task Delete(IReadOnlyCollection<string> ids)
    {
        await _flushLock.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            var readIds = new Dictionary<string, string?>();
            foreach (var chunk in ids.Chunk(500))
                foreach (var d in await db.Documents.Where(d => chunk.Contains(d.Id)).Select(d => new { d.Id, d.ReadId }).ToListAsync())
                    readIds[d.Id] = d.ReadId;

            var live = new List<DocState>();
            lock (_gate)
            {
                foreach (var id in ids)
                {
                    _deletedIds[id] = 0;
                    if (_docs.TryRemove(id, out var s)) live.Add(s);
                }
            }
            foreach (var s in live)
            {
                await s.Lock.WaitAsync();
                try
                {
                    s.Deleted = true;
                    s.Dirty = false;
                    if (s.ReadId != null)
                    {
                        readIds[s.Id] = s.ReadId;
                        _readIds.TryRemove(KeyValuePair.Create(s.ReadId, s.Id));
                    }
                }
                finally { s.Lock.Release(); }
            }
            foreach (var r in readIds.Values)
                if (r != null) _deletedReadIds[r] = 0;

            var now = DateTime.UtcNow;
            await using (var tx = await db.Database.BeginTransactionAsync())
            {
                foreach (var id in ids)
                    await db.Database.ExecuteSqlInterpolatedAsync(
                        $"INSERT OR IGNORE INTO DeletedDocuments (Id, ReadId, DeletedAt) VALUES ({id}, {readIds.GetValueOrDefault(id)}, {now})");
                foreach (var chunk in ids.Chunk(500))
                    await db.Documents.Where(d => chunk.Contains(d.Id)).ExecuteDeleteAsync();
                await tx.CommitAsync();
            }
        }
        finally { _flushLock.Release(); }
        foreach (var id in ids)
            await hub.Clients.Group(id).SendAsync("deleted");
        log.LogInformation("Deleted {Count} documents", ids.Count);
    }

    /// Titles by edit id, plus titles of read-only links keyed "r/{readId}" (never revealing the edit id).
    /// Uses the stored titles (live documents: as of their last flush), like the admin's document list.
    public async Task<Dictionary<string, string>> Titles(IEnumerable<string> ids, IEnumerable<string>? readIds = null)
    {
        var result = new Dictionary<string, string>();
        var missingRead = new List<string>();
        foreach (var r in readIds ?? [])
        {
            if (_readIds.TryGetValue(r, out var editId) && _docs.TryGetValue(editId, out var rs)) result["r/" + r] = rs.Title;
            else missingRead.Add(r);
        }
        var missing = new List<string>();
        foreach (var id in ids)
        {
            if (_docs.TryGetValue(id, out var s)) result[id] = s.Title;
            else missing.Add(id);
        }
        if (missingRead.Count == 0 && missing.Count == 0) return result;
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        if (missingRead.Count > 0)
            foreach (var d in await db.Documents.Where(d => d.ReadId != null && missingRead.Contains(d.ReadId)).Select(d => new { d.ReadId, d.Title }).ToListAsync())
                result["r/" + d.ReadId] = d.Title;
        if (missing.Count > 0)
            foreach (var d in await db.Documents.Where(d => missing.Contains(d.Id)).Select(d => new { d.Id, d.Title }).ToListAsync())
                result[d.Id] = d.Title;
        return result;
    }
}
