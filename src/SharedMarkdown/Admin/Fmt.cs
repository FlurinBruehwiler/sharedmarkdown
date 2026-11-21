namespace SharedMarkdown.Admin;

static class Fmt
{
    static readonly TimeZoneInfo Zurich = TimeZoneInfo.TryFindSystemTimeZoneById("Europe/Zurich", out var tz) ? tz : TimeZoneInfo.Utc;

    public static string Bytes(long n) => n switch
    {
        < 1024 => $"{n} B",
        < 1024 * 1024 => $"{n / 1024.0:0.#} KB",
        < 1024L * 1024 * 1024 => $"{n / 1024.0 / 1024:0.#} MB",
        _ => $"{n / 1024.0 / 1024 / 1024:0.##} GB",
    };

    public static string Time(DateTime utc) => TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), Zurich).ToString("dd.MM.yyyy HH:mm");

    public static string Clock(DateTimeOffset t) => TimeZoneInfo.ConvertTime(t, Zurich).ToString("HH:mm:ss");

    public static string Title(string t) => string.IsNullOrWhiteSpace(t) ? "Untitled" : t;
}
