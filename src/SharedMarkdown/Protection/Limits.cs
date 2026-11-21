using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

/// Abuse limits. Defaults come from the "Limits" config section; the admin dashboard can override them at runtime.
public class Limits
{
    public int DocumentsPerIpPerHour { get; set; } = 100;
    /// Maximum visible document length in characters (UTF-16 units, ~bytes for plain text).
    public int MaxDocumentChars { get; set; } = 50_000;
    /// Cap on stored CRDT items including deleted ones, so endless type/delete can't grow a document forever.
    public int MaxDocumentItems { get; set; } = 500_000;
    public int UploadsPerIpPerHour { get; set; } = 100;
    public int MaxUploadBytes { get; set; } = 10 * 1024 * 1024;
    /// Larger images are scaled down to fit this many pixels on their longest side.
    public int MaxImageDimension { get; set; } = 2000;
    public int MaxConnectionsPerIp { get; set; } = 30;
    /// Opening documents (each one is loaded into memory).
    public int JoinsPerIpPerMinute { get; set; } = 120;
    /// Edit batches; the client sends at most a few per second while typing.
    public int SubmitsPerIpPerMinute { get; set; } = 1200;
    public int TitleLookupsPerIpPerMinute { get; set; } = 120;
    public int AdminLoginAttemptsPerIpPerHour { get; set; } = 10;

    /// Why these limits can't be used, or null if they're fine.
    public string? Validate()
    {
        int[] all = [DocumentsPerIpPerHour, MaxDocumentChars, MaxDocumentItems, UploadsPerIpPerHour, MaxUploadBytes, MaxImageDimension,
            MaxConnectionsPerIp, JoinsPerIpPerMinute, SubmitsPerIpPerMinute, TitleLookupsPerIpPerMinute, AdminLoginAttemptsPerIpPerHour];
        return all.Any(v => v < 1) ? "All values must be at least 1." : null;
    }

    public Limits Copy() => (Limits)MemberwiseClone();
}

public class LimitsService(IConfiguration config, IServiceScopeFactory scopes, ILogger<LimitsService> log)
{
    const string Key = "limits";
    volatile Limits _current = config.GetSection("Limits").Get<Limits>() ?? new Limits();

    public Limits Current => _current;
    public Limits Defaults => config.GetSection("Limits").Get<Limits>() ?? new Limits();

    public async Task Load()
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        var row = await db.Settings.FindAsync(Key);
        if (row is null) return;
        try { _current = JsonSerializer.Deserialize<Limits>(row.Value) ?? _current; }
        catch (JsonException e) { log.LogError(e, "Stored limits are invalid, using defaults"); }
    }

    public async Task Save(Limits limits)
    {
        if (limits.Validate() is { } error) throw new ArgumentException(error, nameof(limits));
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        var row = await db.Settings.FindAsync(Key);
        if (row is null) db.Settings.Add(row = new AppSetting { Key = Key });
        row.Value = JsonSerializer.Serialize(limits);
        await db.SaveChangesAsync();
        _current = limits;
        log.LogInformation("Limits changed: {Limits}", limits);
    }

    public async Task Reset()
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        await db.Settings.Where(s => s.Key == Key).ExecuteDeleteAsync();
        _current = Defaults;
    }
}
