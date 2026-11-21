using System.Collections.Concurrent;
using System.Net;
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

/// Per-IP fixed-window counters, live connection counts, and the IP block list.
public class IpGuard(IServiceScopeFactory scopes)
{
    record struct Window(long Start, int Count);

    readonly ConcurrentDictionary<(string Bucket, string Ip), Window> _windows = new();
    readonly ConcurrentDictionary<string, int> _connections = new();
    volatile HashSet<string> _blocked = [];

    /// Counts one action; false if the IP already used `limit` actions in the current window.
    public bool TryTake(string bucket, string ip, int limit, TimeSpan window)
    {
        var now = Environment.TickCount64;
        var ms = (long)window.TotalMilliseconds;
        while (true)
        {
            var key = (bucket, ip);
            var w = _windows.GetOrAdd(key, _ => new Window(now, 0));
            var next = now - w.Start >= ms ? new Window(now, 1) : w with { Count = w.Count + 1 };
            if (next.Count > limit) return false;
            if (_windows.TryUpdate(key, next, w)) return true;
        }
    }

    /// Recent activity per IP for the dashboard.
    public int Used(string bucket, string ip) => _windows.TryGetValue((bucket, ip), out var w) ? w.Count : 0;

    public IEnumerable<(string Bucket, string Ip, int Count)> Activity() =>
        _windows.Select(kv => (kv.Key.Bucket, kv.Key.Ip, kv.Value.Count));

    public bool TryConnect(string ip, int limit)
    {
        while (true)
        {
            var n = _connections.GetOrAdd(ip, 0);
            if (n >= limit) return false;
            if (_connections.TryUpdate(ip, n + 1, n)) return true;
        }
    }

    public void Disconnect(string ip) => _connections.AddOrUpdate(ip, 0, (_, n) => Math.Max(0, n - 1));

    public int Connections => _connections.Values.Sum();

    public bool IsBlocked(string ip) => _blocked.Contains(ip);

    public async Task LoadBlocked()
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        _blocked = (await db.BlockedIps.Select(b => b.Ip).ToListAsync()).ToHashSet();
    }

    /// Drops expired windows and idle connection entries so memory doesn't grow with every IP ever seen.
    public void Prune()
    {
        var now = Environment.TickCount64;
        foreach (var (key, w) in _windows)
            if (now - w.Start > TimeSpan.FromHours(2).TotalMilliseconds) _windows.TryRemove(key, out _);
        foreach (var (ip, n) in _connections)
            if (n == 0) _connections.TryRemove(new KeyValuePair<string, int>(ip, 0));
    }

    public static string IpOf(HttpContext? ctx)
    {
        var ip = ctx?.Connection.RemoteIpAddress;
        if (ip is null) return "unknown";
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return ip.ToString();
        // Group IPv6 clients by /64: one household or server usually gets a whole /64.
        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            var bytes = ip.GetAddressBytes();
            Array.Clear(bytes, 8, 8);
            return new IPAddress(bytes) + "/64";
        }
        return ip.ToString();
    }
}
