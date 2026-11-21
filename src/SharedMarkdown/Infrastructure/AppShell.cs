using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.Extensions;
using Microsoft.AspNetCore.StaticAssets;

namespace SharedMarkdown;

public partial class AppShell(IWebHostEnvironment env, DocStore store, ILogger<AppShell> log)
{
    const string Bundle = "assets/app.js";
    const string NoText = "A shared Markdown document on SharedMarkdown.";
    string? _html;
    string _csp = "";
    // app.html cut at the per-document values; odd entries name the value.
    string[]? _docParts;

    public string Build { get; private set; } = "";

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
        try { _docParts = DocTemplate(_html).Split('\0'); }
        catch (FormatException e) { log.LogError("Documents get the generic link preview: {Error}", e.Message); }
    }

    static string? Prop(StaticAssetDescriptor d, string name) => d.Properties.FirstOrDefault(p => p.Name == name)?.Value;

    public Task Serve(HttpContext ctx) => _html is null
        ? Results.Text("The frontend isn't built.", statusCode: 503).ExecuteAsync(ctx)
        : Send(ctx, _html);

    // Chat apps build a link's preview from the page's meta tags, without running scripts.
    public async Task ServeDocument(HttpContext ctx, string? id, string? readId)
    {
        if (_html is null || _docParts is null) { await Serve(ctx); return; }
        string? text = null;
        try { text = await store.PreviewText(id, readId); }
        catch (Exception e) { log.LogWarning(e, "Link preview of {Doc} failed", id ?? "r/" + readId); }
        var title = MarkdownTitle.Of(text ?? "");
        if (title.Length == 0) { await Serve(ctx); return; }
        var snippet = MarkdownTitle.Snippet(text!);
        var url = UriHelper.BuildAbsolute(ctx.Request.Scheme, ctx.Request.Host, ctx.Request.PathBase, ctx.Request.Path);
        var html = new StringBuilder();
        for (var i = 0; i < _docParts.Length; i++)
            html.Append(i % 2 == 0 ? _docParts[i] : Escape(_docParts[i] switch
            {
                "title" => title + " · SharedMarkdown",
                "heading" => title,
                "description" => snippet.Length > 0 ? snippet : NoText,
                "url" => url,
                var name => throw new InvalidOperationException(name),
            }));
        await Send(ctx, html.ToString());
    }

    // WebUtility.HtmlEncode would also turn Latin-1 letters into numeric entities.
    static string Escape(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;").Replace("'", "&#39;");

    Task Send(HttpContext ctx, string html)
    {
        ctx.Response.Headers.CacheControl = "no-cache";
        ctx.Response.Headers.ContentSecurityPolicy = _csp;
        return Results.Text(html, "text/html; charset=utf-8").ExecuteAsync(ctx);
    }

    // No canonical link: the home page's would contradict a document page. The generic title stays in data-site
    // for the client (document.title of an empty document).
    static string DocTemplate(string html)
    {
        foreach (var (pattern, replacement) in new[]
        {
            ("<title>([^<]*)</title>", "<title data-site=\"$1\">\0title\0</title>"),
            ("(<meta name=\"description\" content=\")[^\"]*", "$1\0description\0"),
            ("<link rel=\"canonical\"[^>]*>\r?\n?", ""),
            ("(<meta property=\"og:type\" content=\")[^\"]*", "${1}article"),
            ("(<meta property=\"og:title\" content=\")[^\"]*", "$1\0heading\0"),
            ("(<meta property=\"og:description\" content=\")[^\"]*", "$1\0description\0"),
            ("(<meta property=\"og:url\" content=\")[^\"]*", "$1\0url\0"),
        })
        {
            var re = new Regex(pattern);
            if (re.Count(html) != 1) throw new FormatException($"app.html has no single match for {pattern}");
            html = re.Replace(html, replacement);
        }
        return html;
    }

    [GeneratedRegex("<script>(.*?)</script>", RegexOptions.Singleline)]
    private static partial Regex InlineScript();

    // Styles allow 'unsafe-inline' because CodeMirror injects its base styles at runtime.
    static string CspFor(string html)
    {
        var hashes = InlineScript().Matches(html).Select(m => $"'sha256-{Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(m.Groups[1].Value)))}'");
        return "default-src 'self'; script-src 'self' " + string.Join(' ', hashes) + "; style-src 'self' 'unsafe-inline'; " +
               "img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    }
}
