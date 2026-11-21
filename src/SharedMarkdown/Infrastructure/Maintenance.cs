using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

public record Paths(string DataDir)
{
    public string Database => Path.Combine(DataDir, "sharedmarkdown.db");
    public string Backups => Path.Combine(DataDir, "backups");
    public string ConnectionString => $"Data Source={Database}";
}

public partial class Maintenance(Paths paths, DocStore store, IServiceScopeFactory scopes, IConfiguration config, ILogger<Maintenance> log) : BackgroundService
{
    public sealed record BackupFile(string Name, string Path, DateTime CreatedUtc, long Size);

    int KeepBackups => config.GetValue("Backups:Keep", 14);
    static readonly TimeSpan OrphanGrace = TimeSpan.FromDays(7);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), ct);
            while (true)
            {
                if (NewestDailyBackup() is not { } last || DateTime.UtcNow - last > TimeSpan.FromHours(23))
                {
                    try { await CreateBackup(); }
                    catch (Exception e) { log.LogError(e, "Backup failed"); }
                    try { await RemoveOrphanedImages(); }
                    catch (Exception e) { log.LogError(e, "Image cleanup failed"); }
                }
                await Task.Delay(TimeSpan.FromHours(1), ct);
            }
        }
        catch (OperationCanceledException) { }
    }

    DateTime? NewestDailyBackup() => ListBackups().FirstOrDefault(b => IsDaily(b.Name))?.CreatedUtc;

    [GeneratedRegex(@"^sharedmarkdown-\d{8}-\d{6}\.db$")]
    private static partial Regex DailyName();

    public static bool IsDaily(string name) => DailyName().IsMatch(name);

    public async Task<string> CreateBackup(string? label = null)
    {
        if (label is not null && !Regex.IsMatch(label, "^[a-z0-9]+$")) throw new ArgumentException("Labels are lowercase letters and digits.", nameof(label));
        await store.Flush(evict: false);
        Directory.CreateDirectory(paths.Backups);
        var name = $"sharedmarkdown-{DateTime.UtcNow:yyyyMMdd-HHmmss}{(label is null ? "" : "-" + label)}.db";
        var target = Path.Combine(paths.Backups, name);
        await using (var source = new SqliteConnection(paths.ConnectionString))
        await using (var destination = new SqliteConnection($"Data Source={target};Pooling=False"))
        {
            await source.OpenAsync();
            await destination.OpenAsync();
            source.BackupDatabase(destination);
        }
        if (label is null)
            foreach (var old in ListBackups().Where(b => IsDaily(b.Name)).Skip(KeepBackups)) File.Delete(old.Path);
        log.LogInformation("Created backup {Name}", name);
        return name;
    }

    // Only files actually in the backup folder, so a name from a URL can't point elsewhere.
    public List<BackupFile> ListBackups() =>
        !Directory.Exists(paths.Backups) ? [] :
        Directory.GetFiles(paths.Backups, "*.db")
            .Select(p => new FileInfo(p))
            .Select(f => new BackupFile(f.Name, f.FullName, f.LastWriteTimeUtc, f.Length))
            .OrderByDescending(b => b.CreatedUtc)
            .ToList();

    public BackupFile? FindBackup(string name) => ListBackups().FirstOrDefault(b => b.Name == name);

    [GeneratedRegex("/b/([0-9a-f]{32})")]
    private static partial Regex BlobLink();

    public async Task<int> RemoveOrphanedImages()
    {
        await store.Flush(evict: false);
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        var referenced = new HashSet<string>();
        await foreach (var content in db.Documents.AsNoTracking().Select(d => d.Content).AsAsyncEnumerable())
            foreach (Match m in BlobLink().Matches(content)) referenced.Add(m.Groups[1].Value);
        var cutoff = DateTime.UtcNow - OrphanGrace;
        var candidates = await db.Blobs.Where(b => b.CreatedAt < cutoff).Select(b => b.Id).ToListAsync();
        var orphans = candidates.Where(id => !referenced.Contains(id)).ToList();
        foreach (var chunk in orphans.Chunk(500))
            await db.Blobs.Where(b => chunk.Contains(b.Id)).ExecuteDeleteAsync();
        if (orphans.Count > 0) log.LogInformation("Removed {Count} unreferenced images", orphans.Count);
        return orphans.Count;
    }
}
