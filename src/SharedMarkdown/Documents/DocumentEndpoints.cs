using Microsoft.AspNetCore.Http.Connections;

namespace SharedMarkdown;

public static class DocumentEndpoints
{
    public static void MapDocuments(this IEndpointRouteBuilder app)
    {
        app.MapHub<DocHub>("/hub", o => o.Transports = HttpTransportType.WebSockets);

        app.MapGet("/api/titles", async (string? ids, string? r, HttpContext ctx, DocStore store, IpGuard guard, LimitsService limits) =>
        {
            var ip = IpGuard.IpOf(ctx);
            if (guard.IsBlocked(ip)) return Results.StatusCode(403);
            if (!guard.TryTake("titles", ip, limits.Current.TitleLookupsPerIpPerMinute, TimeSpan.FromMinutes(1))) return Results.StatusCode(429);
            return Results.Ok(await store.Titles(
                (ids ?? "").Split(',').Where(i => DocIds.EditId().IsMatch(i)).Distinct().Take(200),
                (r ?? "").Split(',').Where(i => DocIds.ReadId().IsMatch(i)).Distinct().Take(200)));
        });

        app.MapGet("/", (HttpContext ctx, AppShell shell) => shell.Serve(ctx));
        app.MapGet("/{id}", (string id, HttpContext ctx, AppShell shell) =>
            DocIds.EditId().IsMatch(id) ? shell.ServeDocument(ctx, id, null) : Results.NotFound().ExecuteAsync(ctx));
        app.MapGet("/r/{readId}", (string readId, HttpContext ctx, AppShell shell) =>
            DocIds.ReadId().IsMatch(readId) ? shell.ServeDocument(ctx, null, readId) : Results.NotFound().ExecuteAsync(ctx));
    }
}
