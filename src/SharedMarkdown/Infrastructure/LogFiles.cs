using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace SharedMarkdown;

public sealed partial class LogFiles(Paths paths)
{
    public const string Template = "{Timestamp:yyyy-MM-ddTHH:mm:ss.fffzzz} {Level:u3} {SourceContext}: {Message:lj}{NewLine}{Exception}";
    public const string FilePattern = "sharedmarkdown-.log";

    public sealed record LogFile(string Name, string Path, long Size, DateTime ModifiedUtc);
    public sealed record Entry(DateTimeOffset Time, LogLevel Level, string Category, string Message, string? Detail);

    readonly Lock _lock = new();
    (string Path, long Size, DateTime Modified, List<Entry> Entries)? _cache;

    public string Dir => Path.Combine(paths.DataDir, "logs");

    public List<LogFile> List() => !Directory.Exists(Dir) ? [] :
        new DirectoryInfo(Dir).EnumerateFiles()
            .Where(f => FileName().IsMatch(f.Name))
            .Select(f => new LogFile(f.Name, f.FullName, f.Length, f.LastWriteTimeUtc))
            .OrderByDescending(f => f.Name, StringComparer.Ordinal)
            .ToList();

    public LogFile? Find(string name) => FileName().IsMatch(name) ? List().FirstOrDefault(f => f.Name == name) : null;

    public List<Entry> Read(LogFile file)
    {
        var info = new FileInfo(file.Path);
        lock (_lock)
        {
            if (_cache is { } c && c.Path == file.Path && c.Size == info.Length && c.Modified == info.LastWriteTimeUtc) return c.Entries;
        }
        var entries = Parse(file.Path);
        lock (_lock) _cache = (file.Path, info.Length, info.LastWriteTimeUtc, entries);
        return entries;
    }

    static List<Entry> Parse(string path)
    {
        var entries = new List<Entry>();
        using var stream = OpenShared(path);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        Entry? current = null;
        var detail = new StringBuilder();
        void Finish()
        {
            if (current is null) return;
            entries.Add(detail.Length == 0 ? current : current with { Detail = detail.ToString().TrimEnd() });
            detail.Clear();
        }
        while (reader.ReadLine() is { } line)
        {
            var m = EntryLine().Match(line);
            if (m.Success && DateTimeOffset.TryParseExact(m.Groups[1].Value, "yyyy-MM-ddTHH:mm:ss.fffzzz", CultureInfo.InvariantCulture, DateTimeStyles.None, out var time))
            {
                Finish();
                current = new Entry(time, LevelOf(m.Groups[2].Value), m.Groups[3].Value, m.Groups[4].Value, null);
            }
            else if (current is not null) detail.AppendLine(line);
        }
        Finish();
        return entries;
    }

    public static FileStream OpenShared(string path) => new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);

    static LogLevel LevelOf(string s) => s switch
    {
        "VRB" => LogLevel.Trace,
        "DBG" => LogLevel.Debug,
        "INF" => LogLevel.Information,
        "WRN" => LogLevel.Warning,
        "ERR" => LogLevel.Error,
        _ => LogLevel.Critical,
    };

    [GeneratedRegex(@"^sharedmarkdown-\d{8}(_\d{3})?\.log$")]
    private static partial Regex FileName();

    [GeneratedRegex(@"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d) (VRB|DBG|INF|WRN|ERR|FTL) ([^:]*): (.*)$")]
    private static partial Regex EntryLine();
}
