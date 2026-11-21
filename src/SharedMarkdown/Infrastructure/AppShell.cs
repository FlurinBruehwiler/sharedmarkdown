using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.StaticAssets;

namespace SharedMarkdown;

/// The editor page (app.html from the client build), served for every document URL. The bundle and
/// service worker are ordinary static assets (MapStaticAssets fingerprints, compresses and caches them);
/// this fills in the bundle's fingerprinted URL and sends the page with a strict Content-Security-Policy.
public partial class AppShell(IWebHostEnvironment env, ILogger<AppShell> log)
{
    const string Bundle = "assets/app.js";
    string? _html;
    string _csp = "";

    /// The bundle's fingerprinted URL. Clients compare it after reconnecting to notice a deploy.
    public string Build { get; private set; } = "";

    /// Reads app.html and resolves the bundle URL. Call after MapStaticAssets().
    public void Load(IEndpointRouteBuilder endpoints)
    {
        var file = new[] { AppContext.BaseDirectory, env.ContentRootPath }.Select(d => Path.Combine(d, "app.html")).FirstOrDefault(File.Exists);
        if (file is null) { log.LogError("app.html not found: build the client (src/client: node build.mjs)"); return; }
        var route = endpoints.DataSources.SelectMany(d => d.Endpoints)
            .Select(e => e.Metadata.GetMetadata<StaticAssetDescriptor>())
            .FirstOrDefault(d => d is not null && d.Selectors.Count == 0 && Prop(d, "label") == Bundle && Prop(d, "fingerprint") is not null)?.Route;
        Build = "/" + (route ?? Bundle);
        _html = File.ReadAllText(file).Replace("/*JS*/", Build);
        _csp = CspFor(_html);
    }

    static string? Prop(StaticAssetDescriptor d, string name) => d.Properties.FirstOrDefault(p => p.Name == name)?.Value;

    public Task Serve(HttpContext ctx)
    {
        if (_html is null) return Results.Text("The frontend isn't built.", statusCode: 503).ExecuteAsync(ctx);
        ctx.Response.Headers.CacheControl = "no-cache";
        ctx.Response.Headers.ContentSecurityPolicy = _csp;
        return Results.Text(_html, "text/html; charset=utf-8").ExecuteAsync(ctx);
    }

    [GeneratedRegex("<script>(.*?)</script>", RegexOptions.Singleline)]
    private static partial Regex InlineScript();

    /// Only our own scripts and the page's inline theme script (by hash) may run. Styles allow
    /// 'unsafe-inline' because CodeMirror injects its base styles at runtime.
    static string CspFor(string html)
    {
        var hashes = InlineScript().Matches(html).Select(m => $"'sha256-{Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(m.Groups[1].Value)))}'");
        return "default-src 'self'; script-src 'self' " + string.Join(' ', hashes) + "; style-src 'self' 'unsafe-inline'; " +
               "img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    }
}
