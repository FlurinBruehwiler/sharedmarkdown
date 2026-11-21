using Microsoft.AspNetCore.Http.Connections;

namespace SharedMarkdown;

public static class DocumentEndpoints
{
    /// The editor page for every document URL, the sync hub, and title lookups for the sidebar.
    public static void MapDocuments(this IEndpointRouteBuilder app)
    {
        app.MapHub<DocHub>("/hub", o => o.Transports = HttpTransportType.WebSockets);

        // `ids` are edit ids; `r` are read-only link ids, whose titles come back keyed "r/{readId}".
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
            DocIds.EditId().IsMatch(id) ? shell.Serve(ctx) : Results.NotFound().ExecuteAsync(ctx));
        // Read-only links: the same app; it joins with the read id (DocHub.JoinRead), never learning the edit id.
        app.MapGet("/r/{readId}", (string readId, HttpContext ctx, AppShell shell) =>
            DocIds.ReadId().IsMatch(readId) ? shell.Serve(ctx) : Results.NotFound().ExecuteAsync(ctx));
    }
}
