namespace SharedMarkdown;

public static class SecurityHeaders
{
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app) => app.Use((ctx, next) =>
    {
        var h = ctx.Response.Headers;
        h.XContentTypeOptions = "nosniff";
        h["Referrer-Policy"] = "no-referrer"; // the document URL is its only access control
        h.XFrameOptions = "DENY";
        if (!Indexable(ctx.Request.Path)) h["X-Robots-Tag"] = "noindex, nofollow";
        h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
        h["Cross-Origin-Opener-Policy"] = "same-origin";
        return next(ctx);
    });

    // Only the home page (and the files search engines and link previews fetch for it) may be indexed:
    // documents are private links.
    static readonly HashSet<string> Public = ["/", "/robots.txt", "/sitemap.xml", "/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/og.png"];

    static bool Indexable(PathString path) => Public.Contains(path.Value ?? "");
}
