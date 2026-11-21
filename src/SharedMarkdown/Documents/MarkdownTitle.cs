using System.Text.RegularExpressions;

namespace SharedMarkdown;

public static partial class MarkdownTitle
{
    // Must match titleOf in src/client/src/main.ts. Bump Version when the rules change: stored titles are recomputed at startup.
    public const int Version = 1;

    [GeneratedRegex(@"!\[[^\]]*\]\([^)]*\)")] private static partial Regex Image();
    [GeneratedRegex(@"\[([^\]]*)\]\([^)]*\)")] private static partial Regex Link();
    [GeneratedRegex(@"\*\*|__|~~|==|`")] private static partial Regex Emphasis();
    [GeneratedRegex(@"\\(.)")] private static partial Regex Escape();
    [GeneratedRegex(@"^([#>\-*+]+|\d+[.)])(\s+|$)")] private static partial Regex BlockPrefix();
    [GeneratedRegex(@"^\[[ xX]\]\s+")] private static partial Regex TaskBox();

    public static string Of(string md)
    {
        foreach (var raw in md.AsSpan().EnumerateLines())
        {
            var line = raw.ToString();
            line = Image().Replace(line, "");
            line = Link().Replace(line, "$1");
            line = Emphasis().Replace(line, "");
            line = Escape().Replace(line, "$1").Trim();
            line = BlockPrefix().Replace(line, "");
            line = TaskBox().Replace(line, "").Trim();
            if (line.Length == 0) continue;
            return line.Length > 80 ? line[..80] : line;
        }
        return "";
    }
}
