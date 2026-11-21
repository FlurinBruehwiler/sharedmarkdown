using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace SharedMarkdown.Tests;

/// A DocStore over a fresh SQLite file; a second instance over the same file plays "after a restart".
sealed class StoreHost : IAsyncDisposable
{
    readonly string _dir = Directory.CreateTempSubdirectory("sm-test-").FullName;
    readonly List<ServiceProvider> _providers = [];

    public async Task<(DocStore Store, IServiceProvider Services)> Start()
    {
        var services = new ServiceCollection();
        var paths = new Paths(_dir);
        services.AddSingleton(paths);
        services.AddLogging();
        services.AddSignalR();
        services.AddDbContextFactory<AppDb>(o => o.UseSqlite(paths.ConnectionString));
        services.AddSingleton<DocStore>();
        var sp = services.BuildServiceProvider();
        _providers.Add(sp);
        await Database.Prepare(sp);
        var store = sp.GetRequiredService<DocStore>();
        await store.LoadDeleted();
        return (store, sp);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var sp in _providers) await sp.DisposeAsync();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }
}

public class DocStoreTests
{
    static JsonElement Ops(object ops) => JsonSerializer.SerializeToElement(ops);

    /// What DocHub.JoinDoc + Submit do: get the state, retry if it was evicted meanwhile, apply under the lock.
    static async Task Edit(DocStore store, string id, Func<DocState, object> ops)
    {
        while (true)
        {
            var s = await store.Get(id);
            await s.Lock.WaitAsync();
            try
            {
                if (s.Evicted) continue;
                Assert.False(s.Deleted);
                Assert.Equal(Rga.ApplyResult.Ok, s.Doc.Apply(Ops(ops(s)), 1_000_000, 1_000_000));
                s.Dirty = true;
                return;
            }
            finally { s.Lock.Release(); }
        }
    }

    /// Appends one character from client `client` (its clocks count up from 1).
    static Task Append(DocStore store, string id, string client, int clock, char ch) => Edit(store, id, s =>
    {
        var state = JsonSerializer.Deserialize<JsonElement[][]>(s.Doc.Encode())!;
        var last = state.Length == 0 ? null : state[^1];
        string oc = last is null ? "" : last[0].GetString()!;
        long ok = last is null ? 0 : last[1].GetInt64() + last[2].GetString()!.Length - 1;
        return new object[] { new object[] { "i", client, clock, oc, ok, ch.ToString() } };
    });

    static async Task<string?> StoredContent(IServiceProvider sp, string id)
    {
        await using var db = await sp.GetRequiredService<IDbContextFactory<AppDb>>().CreateDbContextAsync();
        return await db.Documents.Where(d => d.Id == id).Select(d => d.Content).FirstOrDefaultAsync();
    }

    // B1: concurrent flushes (DocFlusher, backups, the admin) must not persist an older state last.
    [Fact]
    public async Task ConcurrentFlushesKeepTheLatestState()
    {
        await using var host = new StoreHost();
        var (store, sp) = await host.Start();
        const string id = "flushflush1";
        var stop = false;
        var flushers = Enumerable.Range(0, 4).Select(_ => Task.Run(async () => { while (!Volatile.Read(ref stop)) await store.Flush(evict: false); })).ToList();
        for (int i = 1; i <= 300; i++) await Append(store, id, "c", i, (char)('a' + i % 26));
        Volatile.Write(ref stop, true);
        await Task.WhenAll(flushers);
        await store.Flush(evict: false);
        var (_, sp2) = await host.Start();
        Assert.Equal(300, (await StoredContent(sp2, id))!.Length);
    }

    // B2: a joiner racing eviction must never edit a copy that is no longer the live one.
    [Fact]
    public async Task EvictionNeverLosesEdits()
    {
        await using var host = new StoreHost();
        var (store, sp) = await host.Start();
        store.EvictAfter = TimeSpan.Zero;
        const string id = "evictevict1";
        var stop = false;
        var evictor = Task.Run(async () => { while (!Volatile.Read(ref stop)) await store.Flush(evict: true); });
        for (int i = 1; i <= 300; i++) await Append(store, id, "c", i, 'x');
        Volatile.Write(ref stop, true);
        await evictor;
        await store.Flush(evict: false);
        Assert.Equal(300, (await StoredContent(sp, id))!.Length);
        Assert.Equal(300, (await store.Get(id)).Doc.Length);
    }

    [Fact]
    public async Task ConcurrentGetsShareOneState()
    {
        await using var host = new StoreHost();
        var (store, _) = await host.Start();
        var states = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => Task.Run(() => store.Get("sharedshared"))));
        Assert.All(states, s => Assert.Same(states[0], s));
    }

    // B1: one document failing to save doesn't stop the others, and is retried.
    [Fact]
    public async Task FailedSaveStaysDirty()
    {
        await using var host = new StoreHost();
        var (store, sp) = await host.Start();
        await Append(store, "brokenbroken", "c", 1, 'a');
        await Append(store, "finefinefine", "c", 1, 'b');
        var broken = await store.Get("brokenbroken");
        broken.CreatorIp = null!; // violates NOT NULL
        await store.Flush(evict: false);
        Assert.Null(await StoredContent(sp, "brokenbroken"));
        Assert.Equal("b", await StoredContent(sp, "finefinefine"));
        Assert.True(broken.Dirty);
        broken.CreatorIp = "1.2.3.4";
        await store.Flush(evict: false);
        Assert.Equal("a", await StoredContent(sp, "brokenbroken"));
    }

    // B1 + B6: a flush racing a delete must not re-insert the document, and the id stays deleted.
    [Fact]
    public async Task DeleteWinsOverFlushAndStaysDeleted()
    {
        await using var host = new StoreHost();
        var (store, sp) = await host.Start();
        const string id = "deletedelete";
        await Append(store, id, "c", 1, 'a');
        string readId;
        var s = await store.Get(id);
        await s.Lock.WaitAsync();
        try { readId = store.EnsureReadId(s); } finally { s.Lock.Release(); }
        await store.Flush(evict: false);
        await Append(store, id, "c", 2, 'b'); // dirty again

        var flushes = Task.Run(async () => { for (int i = 0; i < 20; i++) await store.Flush(evict: false); });
        await store.Delete([id]);
        await flushes;
        await store.Flush(evict: false);

        Assert.Null(await StoredContent(sp, id));
        Assert.True(s.Deleted);
        Assert.True(store.IsDeleted(id));
        Assert.True(store.IsDeletedReadId(readId));
        Assert.True((await store.Get(id)).Deleted);

        var (store2, _) = await host.Start();
        Assert.True(store2.IsDeleted(id));
        Assert.True(store2.IsDeletedReadId(readId));
        Assert.True((await store2.Get(id)).Deleted);
    }

    // B3: titles come from the stored title, never from the live replica.
    [Fact]
    public async Task TitlesUseStoredTitles()
    {
        await using var host = new StoreHost();
        var (store, _) = await host.Start();
        const string id = "titletitle12";
        await Edit(store, id, _ => new object[] { new object[] { "i", "c", 1, "", 0, "# My title\n\nbody" } });
        Assert.Equal("", (await store.Titles([id]))[id]); // not flushed yet
        await store.Flush(evict: false);
        Assert.Equal("My title", (await store.Titles([id]))[id]);
        var s = await store.Get(id);
        string readId;
        await s.Lock.WaitAsync();
        try { readId = store.EnsureReadId(s); } finally { s.Lock.Release(); }
        await store.Flush(evict: false);
        var (store2, _) = await host.Start(); // not in memory: from the database
        var titles = await store2.Titles([id, "missingmissing"], [readId]);
        Assert.Equal("My title", titles[id]);
        Assert.Equal("My title", titles["r/" + readId]);
        Assert.False(titles.ContainsKey("missingmissing"));

        // Lookups while the document is being edited don't touch the replica (they used to throw).
        var stop = false;
        var lookups = Task.Run(async () => { while (!Volatile.Read(ref stop)) await store.Titles([id]); });
        for (int i = 0; i < 300; i++) await Edit(store, id, _ => new object[] { new object[] { "i", "d", 100 + i, "", 0, "x" } });
        Volatile.Write(ref stop, true);
        await lookups;
    }

    // B5: compaction keeps visible ids, and only happens to documents left alone for a while.
    [Fact]
    public async Task CompactsOnlyOldDocuments()
    {
        await using var host = new StoreHost();
        var (store, sp) = await host.Start();
        foreach (var id in new[] { "oldoldoldold", "newnewnewnew" })
        {
            await Edit(store, id, _ => new object[] { new object[] { "i", "c", 1, "", 0, new string('x', 3000) + "keep" } });
            await Edit(store, id, _ => new object[] { new object[] { "d", "c", 1, 3000 } });
        }
        await store.Flush(evict: false);
        await using (var db = await sp.GetRequiredService<IDbContextFactory<AppDb>>().CreateDbContextAsync())
            await db.Documents.Where(d => d.Id == "oldoldoldold").ExecuteUpdateAsync(u => u.SetProperty(d => d.UpdatedAt, DateTime.UtcNow.AddDays(-8)));

        var (store2, _) = await host.Start();
        var old = await store2.Get("oldoldoldold");
        Assert.Equal(0, old.Doc.Tombstones);
        Assert.Equal("""[["c",3001,"keep",0]]""", old.Doc.Encode());
        // An offline client's edits next to visible characters still apply; deletes of dropped tombstones are no-ops.
        Assert.Equal(Rga.ApplyResult.Ok, old.Doc.Apply(Ops(new object[] { new object[] { "i", "z", 5000, "c", 3004, "!" }, new object[] { "d", "c", 5, 2 } }), 50_000, 500_000));
        Assert.Equal("keep!", old.Doc.Text());

        Assert.Equal(3000, (await store2.Get("newnewnewnew")).Doc.Tombstones);
    }
}
