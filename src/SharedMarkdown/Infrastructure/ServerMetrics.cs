using System.Diagnostics;

namespace SharedMarkdown;

public record MetricSample(DateTime Time, double CpuPercent, double MemoryPercent, double Load1, long AppMemoryBytes);

public record ServerSnapshot(
    double? CpuPercent, double? AppCpuPercent, int Cores,
    (double One, double Five, double Fifteen)? Load,
    long? MemoryTotal, long? MemoryAvailable, long? SwapTotal, long? SwapFree,
    long DiskTotal, long DiskFree, string DiskPath,
    long AppMemory, long GcHeap, int Threads, TimeSpan AppUptime, TimeSpan? SystemUptime,
    string Host, string Os);

public class ServerMetrics(Paths paths) : BackgroundService
{
    const int Keep = 360;
    readonly LinkedList<MetricSample> _history = new();
    readonly Lock _lock = new();
    (ulong Busy, ulong Total)? _lastCpu;
    (TimeSpan Cpu, DateTime At)? _lastApp;
    volatile ServerSnapshot? _latest;

    public ServerSnapshot? Latest => _latest;

    public List<MetricSample> History()
    {
        lock (_lock) return [.. _history];
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        try
        {
            do
            {
                try { Sample(); } catch (Exception e) when (e is IOException or UnauthorizedAccessException or FormatException) { }
            } while (await timer.WaitForNextTickAsync(ct));
        }
        catch (OperationCanceledException) { }
    }

    void Sample()
    {
        var now = DateTime.UtcNow;
        var cpu = ReadCpu();
        double? cpuPercent = null;
        if (cpu is { } c && _lastCpu is { } prev && c.Total > prev.Total)
            cpuPercent = 100.0 * (c.Busy - prev.Busy) / (c.Total - prev.Total);
        _lastCpu = cpu;

        using var proc = Process.GetCurrentProcess();
        double? appCpu = null;
        if (_lastApp is { } a && now > a.At)
            appCpu = 100.0 * (proc.TotalProcessorTime - a.Cpu).TotalSeconds / (now - a.At).TotalSeconds / Environment.ProcessorCount;
        _lastApp = (proc.TotalProcessorTime, now);

        var mem = ReadMeminfo();
        var drive = new DriveInfo(paths.DataDir);
        var snapshot = new ServerSnapshot(
            cpuPercent, appCpu, Environment.ProcessorCount, ReadLoad(),
            mem.GetValueOrDefault("MemTotal"), mem.GetValueOrDefault("MemAvailable"), mem.GetValueOrDefault("SwapTotal"), mem.GetValueOrDefault("SwapFree"),
            drive.TotalSize, drive.AvailableFreeSpace, paths.DataDir,
            proc.WorkingSet64, GC.GetTotalMemory(false), proc.Threads.Count, now - proc.StartTime.ToUniversalTime(), ReadUptime(),
            Environment.MachineName, System.Runtime.InteropServices.RuntimeInformation.OSDescription);
        _latest = snapshot;

        if (cpuPercent is { } cp && snapshot.MemoryTotal is > 0 && snapshot.MemoryAvailable is { } avail)
        {
            var sample = new MetricSample(now, cp, 100.0 * (snapshot.MemoryTotal.Value - avail) / snapshot.MemoryTotal.Value, snapshot.Load?.One ?? 0, proc.WorkingSet64);
            lock (_lock)
            {
                _history.AddLast(sample);
                while (_history.Count > Keep) _history.RemoveFirst();
            }
        }
    }

    static (ulong Busy, ulong Total)? ReadCpu()
    {
        if (!File.Exists("/proc/stat")) return null;
        var parts = File.ReadLines("/proc/stat").First().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var v = parts.Skip(1).Take(8).Select(ulong.Parse).ToArray(); // user nice system idle iowait irq softirq steal
        var total = v.Aggregate(0UL, (s, x) => s + x);
        var idle = v[3] + v[4];
        return (total - idle, total);
    }

    static Dictionary<string, long> ReadMeminfo()
    {
        var result = new Dictionary<string, long>();
        if (!File.Exists("/proc/meminfo")) return result;
        foreach (var line in File.ReadLines("/proc/meminfo"))
        {
            var parts = line.Split(':', 2);
            if (parts.Length == 2 && long.TryParse(parts[1].Trim().Split(' ')[0], out var kb)) result[parts[0]] = kb * 1024;
        }
        return result;
    }

    static (double, double, double)? ReadLoad()
    {
        if (!File.Exists("/proc/loadavg")) return null;
        var p = File.ReadAllText("/proc/loadavg").Split(' ');
        var c = System.Globalization.CultureInfo.InvariantCulture;
        return (double.Parse(p[0], c), double.Parse(p[1], c), double.Parse(p[2], c));
    }

    static TimeSpan? ReadUptime()
    {
        if (!File.Exists("/proc/uptime")) return null;
        return TimeSpan.FromSeconds(double.Parse(File.ReadAllText("/proc/uptime").Split(' ')[0], System.Globalization.CultureInfo.InvariantCulture));
    }
}
