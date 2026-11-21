using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace SharedMarkdown;

/// Document ids. The edit id (in /{id}) is the only access control for editing; the read id (in /r/{readId})
/// only grants viewing. Both are random base62 strings; only the /r/ prefix tells the two kinds of link apart.
public static partial class DocIds
{
    const string Base62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    /// Edit ids are made by the client (12 base62 characters); the server accepts 8 to 32.
    [GeneratedRegex("^[A-Za-z0-9]{8,32}$")]
    public static partial Regex EditId();

    [GeneratedRegex("^[A-Za-z0-9]{16}$")]
    public static partial Regex ReadId();

    /// A new read id: 16 base62 characters (~95 bits), independent of the edit id.
    public static string NewReadId() => RandomNumberGenerator.GetString(Base62, 16);
}
