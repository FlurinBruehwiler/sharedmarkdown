using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace SharedMarkdown;

public static partial class DocIds
{
    const string Base62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    [GeneratedRegex("^[A-Za-z0-9]{8,32}$")]
    public static partial Regex EditId();

    [GeneratedRegex("^[A-Za-z0-9]{16}$")]
    public static partial Regex ReadId();

    public static string NewReadId() => RandomNumberGenerator.GetString(Base62, 16);
}
