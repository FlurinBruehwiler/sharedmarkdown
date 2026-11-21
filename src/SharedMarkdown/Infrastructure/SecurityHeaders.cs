namespace SharedMarkdown;

public static class SecurityHeaders
{
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app) => app.Use((ctx, next) =>
    {
        var h = ctx.Response.Headers;
        h.XContentTypeOptions = "nosniff";
        h["Referrer-Policy"] = "no-referrer"; // the document URL is its only access control
        h.XFrameOptions = "DENY";
        h["X-Robots-Tag"] = "noindex, nofollow";
        h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
        h["Cross-Origin-Opener-Policy"] = "same-origin";
        return next(ctx);
    });
}
