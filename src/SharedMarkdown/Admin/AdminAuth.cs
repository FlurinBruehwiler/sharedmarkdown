using System.Security.Cryptography;
using System.Text;

namespace SharedMarkdown.Admin;

public static class AdminAuth
{
    /// Constant-time password check for the admin login. Empty configured password = admin disabled.
    public static bool CheckPassword(IConfiguration config, string? attempt)
    {
        var expected = config["Admin:Password"];
        if (string.IsNullOrEmpty(expected) || string.IsNullOrEmpty(attempt)) return false;
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(attempt)), SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
    }
}
