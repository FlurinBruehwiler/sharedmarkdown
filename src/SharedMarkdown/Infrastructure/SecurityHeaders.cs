namespace SharedMarkdown;

public static class SecurityHeaders
{
    /// Headers sent with every response.
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app) => app.Use((ctx, next) =>
    {
        var h = ctx.Response.Headers;
        h.XContentTypeOptions = "nosniff";
        // The document URL is the only thing protecting a document: never send it to other sites.
        h["Referrer-Policy"] = "no-referrer";
        h.XFrameOptions = "DENY";
        // Shared documents are private-by-link; keep them out of search engines.
        h["X-Robots-Tag"] = "noindex, nofollow";
        h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
        h["Cross-Origin-Opener-Policy"] = "same-origin";
        return next(ctx);
    });
}
