using System.Text;
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
            var line = Plain(raw.ToString());
            if (line.Length == 0) continue;
            return line.Length > 80 ? line[..80] : line;
        }
        return "";
    }

    static string Plain(string line)
    {
        line = Image().Replace(line, "");
        line = Link().Replace(line, "$1");
        line = Emphasis().Replace(line, "");
        line = Escape().Replace(line, "$1").Trim();
        line = BlockPrefix().Replace(line, "");
        return TaskBox().Replace(line, "").Trim();
    }

    [GeneratedRegex(@"^\s*(```|~~~)")] private static partial Regex Fence();
    [GeneratedRegex(@"^\s*([-*_]\s*){3,}$")] private static partial Regex Rule();
    [GeneratedRegex(@"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")] private static partial Regex TableDelimiter();
    [GeneratedRegex(@"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])")] private static partial Regex SingleEmphasis();
    [GeneratedRegex(@"<[^>]*>")] private static partial Regex HtmlTag();
    [GeneratedRegex(@"[\s\p{Cc}|]+")] private static partial Regex Gaps();

    // Plain text of what follows the title, for link previews.
    public static string Snippet(string md, int max = 180)
    {
        var sb = new StringBuilder();
        var afterTitle = false;
        foreach (var raw in md.AsSpan().EnumerateLines())
        {
            var line = raw.ToString();
            if (!afterTitle) { afterTitle = Plain(line).Length > 0; continue; }
            if (Fence().IsMatch(line) || Rule().IsMatch(line) || TableDelimiter().IsMatch(line)) continue;
            line = Plain(line);
            while (BlockPrefix().IsMatch(line)) line = TaskBox().Replace(BlockPrefix().Replace(line, ""), "").Trim();
            line = SingleEmphasis().Replace(line, m => m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value);
            line = Gaps().Replace(HtmlTag().Replace(line, " "), " ").Trim();
            if (line.Length == 0) continue;
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(line);
            if (sb.Length > max) break;
        }
        if (sb.Length <= max) return sb.ToString();
        var cut = sb.ToString(0, max + 1).LastIndexOf(' ');
        if (cut < max / 2) cut = char.IsHighSurrogate(sb[max - 1]) ? max - 1 : max;
        return sb.ToString(0, cut).TrimEnd(' ', ',', ';', ':', '-') + "…";
    }
}
