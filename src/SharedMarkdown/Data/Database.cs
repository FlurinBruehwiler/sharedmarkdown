using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

public static class Database
{
    public static async Task Prepare(IServiceProvider services)
    {
        var paths = services.GetRequiredService<Paths>();
        var log = services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(Database));
        if (File.Exists(paths.Database))
        {
            bool legacy;
            await using (var conn = new SqliteConnection(paths.ConnectionString + ";Pooling=False"))
            {
                await conn.OpenAsync();
                var cmd = conn.CreateCommand();
                cmd.CommandText = "SELECT count(*) FROM sqlite_master WHERE name = 'Documents'";
                var hasDocs = (long)(await cmd.ExecuteScalarAsync())! > 0;
                cmd.CommandText = "SELECT count(*) FROM sqlite_master WHERE name = '__EFMigrationsHistory'";
                legacy = hasDocs && (long)(await cmd.ExecuteScalarAsync())! == 0;
            }
            if (legacy)
            {
                var suffix = $".pre-migrations-{DateTime.UtcNow:yyyyMMddHHmmss}.bak";
                foreach (var f in new[] { "", "-wal", "-shm" })
                    if (File.Exists(paths.Database + f)) File.Move(paths.Database + f, paths.Database + f + suffix);
                log.LogWarning("Old database without migrations moved to {File}", paths.Database + suffix);
            }
        }
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        await db.Database.MigrateAsync();
        await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL;");
        await UpdateTitles(db, log);
        log.LogInformation("Using database {File}", paths.Database);
    }

    static async Task UpdateTitles(AppDb db, ILogger log)
    {
        const string key = "titleVersion";
        var version = MarkdownTitle.Version.ToString();
        var row = await db.Settings.FindAsync(key);
        if (row?.Value == version) return;
        var n = 0;
        foreach (var chunk in (await db.Documents.Select(d => d.Id).ToListAsync()).Chunk(500))
            foreach (var d in await db.Documents.Where(d => chunk.Contains(d.Id)).Select(d => new { d.Id, d.Title, Head = d.Content.Substring(0, 4000) }).ToListAsync())
            {
                var title = MarkdownTitle.Of(d.Head);
                if (title == d.Title) continue;
                await db.Documents.Where(x => x.Id == d.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.Title, title));
                n++;
            }
        if (row is null) db.Settings.Add(new AppSetting { Key = key, Value = version });
        else row.Value = version;
        await db.SaveChangesAsync();
        if (n > 0) log.LogInformation("Updated {Count} document titles", n);
    }
}
