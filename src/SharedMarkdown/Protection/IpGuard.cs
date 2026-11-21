using System.Collections.Concurrent;
using System.Net;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

public class IpGuard(IServiceScopeFactory scopes)
{
    record struct Window(long Start, int Count);

    readonly ConcurrentDictionary<(string Bucket, string Ip), Window> _windows = new();
    readonly ConcurrentDictionary<string, int> _connections = new();
    volatile HashSet<string> _blocked = [];

    internal Func<long> Clock { get; set; } = () => Environment.TickCount64;

    public bool TryTake(string bucket, string ip, int limit, TimeSpan window)
    {
        var now = Clock();
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

    public void Prune()
    {
        var now = Clock();
        foreach (var (key, w) in _windows)
            if (now - w.Start > TimeSpan.FromHours(2).TotalMilliseconds) _windows.TryRemove(key, out _);
        foreach (var (ip, n) in _connections)
            if (n == 0) _connections.TryRemove(new KeyValuePair<string, int>(ip, 0));
    }

    public static string IpOf(HttpContext? ctx) => IpOf(ctx?.Connection.RemoteIpAddress);

    public static string IpOf(IPAddress? ip)
    {
        if (ip is null) return "unknown";
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return ip.ToString();
        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            var bytes = ip.GetAddressBytes();
            Array.Clear(bytes, 8, 8); // one household or server usually gets a whole /64
            return new IPAddress(bytes) + "/64";
        }
        return ip.ToString();
    }
}
