using System.IO.Compression;
using System.Security.Cryptography;

namespace SharedMarkdown;

/// Serves the bundled frontend from memory, pre-compressed with brotli and gzip.
/// Files under /assets/ have content hashes in their names and are cached forever;
/// the HTML shell is revalidated by ETag.
public class Assets
{
    record Entry(string ContentType, byte[] Raw, byte[] Br, byte[] Gz, string ETag, bool Immutable);

    readonly Dictionary<string, Entry> _files = new(StringComparer.Ordinal);
    Entry? _index;
    string _csp = "";

    /// Name of the current JS bundle (content-hashed), used by clients to notice a new deploy.
    public string Build { get; private set; } = "";

    public Assets(IWebHostEnvironment env)
    {
        var root = Path.Combine(AppContext.BaseDirectory, "dist");
        if (!Directory.Exists(root)) root = Path.Combine(env.ContentRootPath, "dist");
        if (!Directory.Exists(root)) return;
        foreach (var path in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            var rel = "/" + Path.GetRelativePath(root, path).Replace('\\', '/');
            var raw = File.ReadAllBytes(path);
            var entry = new Entry(TypeOf(path), raw, Compress(raw, true), Compress(raw, false),
                "\"" + Convert.ToHexString(SHA256.HashData(raw))[..16] + "\"", rel.StartsWith("/assets/"));
            if (rel == "/index.html") { _index = entry; _csp = CspFor(System.Text.Encoding.UTF8.GetString(raw)); }
            else _files[rel] = entry;
            if (rel.StartsWith("/assets/") && rel.EndsWith(".js")) Build = rel;
        }
    }

    public Task ServeIndex(HttpContext ctx)
    {
        if (_index is null) return Results.Text("Frontend not built. Run `node build.mjs` in client/.").ExecuteAsync(ctx);
        ctx.Response.Headers.ContentSecurityPolicy = _csp;
        return Serve(ctx, _index);
    }

    /// Only our own bundle and the inline theme script (by hash) may run on the editor page.
    /// Styles allow 'unsafe-inline' because CodeMirror injects its base styles at runtime.
    static string CspFor(string html)
    {
        var hashes = System.Text.RegularExpressions.Regex.Matches(html, "<script>(.*?)</script>", System.Text.RegularExpressions.RegexOptions.Singleline)
            .Select(m => $"'sha256-{Convert.ToBase64String(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(m.Groups[1].Value)))}'");
        return "default-src 'self'; script-src 'self' " + string.Join(' ', hashes) + "; style-src 'self' 'unsafe-inline'; " +
               "img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    }

    public bool TryServe(HttpContext ctx, out Task task)
    {
        task = Task.CompletedTask;
        if (!_files.TryGetValue(ctx.Request.Path.Value ?? "", out var e)) return false;
        task = Serve(ctx, e);
        return true;
    }

    static async Task Serve(HttpContext ctx, Entry e)
    {
        var res = ctx.Response;
        res.Headers.CacheControl = e.Immutable ? "public, max-age=31536000, immutable" : "no-cache";
        res.Headers.ETag = e.ETag;
        res.Headers.Vary = "Accept-Encoding";
        res.Headers.XContentTypeOptions = "nosniff";
        res.ContentType = e.ContentType;
        if (ctx.Request.Headers.IfNoneMatch == e.ETag) { res.StatusCode = 304; return; }

        var accept = ctx.Request.Headers.AcceptEncoding.ToString();
        var body = e.Raw;
        if (accept.Contains("br")) { body = e.Br; res.Headers.ContentEncoding = "br"; }
        else if (accept.Contains("gzip")) { body = e.Gz; res.Headers.ContentEncoding = "gzip"; }
        res.ContentLength = body.Length;
        if (!HttpMethods.IsHead(ctx.Request.Method)) await res.Body.WriteAsync(body);
    }

    static byte[] Compress(byte[] raw, bool brotli)
    {
        using var ms = new MemoryStream();
        using (Stream z = brotli ? new BrotliStream(ms, CompressionLevel.SmallestSize) : new GZipStream(ms, CompressionLevel.SmallestSize))
            z.Write(raw);
        return ms.ToArray();
    }

    static string TypeOf(string path) => Path.GetExtension(path) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".ico" => "image/x-icon",
        ".woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
}
