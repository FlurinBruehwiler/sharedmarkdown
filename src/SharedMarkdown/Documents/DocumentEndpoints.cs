using Microsoft.AspNetCore.Http.Connections;

namespace SharedMarkdown;

public static class DocumentEndpoints
{
    static bool WantsMarkdown(HttpContext ctx) => ctx.Request.Headers.Accept.ToString().Contains("text/markdown", StringComparison.OrdinalIgnoreCase);

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
        // A client that asks for Markdown (agents, scripts) gets the document's text instead of the editor.
        app.MapGet("/{id}", async (string id, HttpContext ctx, AppShell shell, AgentApi api) =>
        {
            if (!DocIds.EditId().IsMatch(id)) await Results.NotFound().ExecuteAsync(ctx);
            else if (WantsMarkdown(ctx)) await (await api.Read(ctx, id, null, withNote: true)).ExecuteAsync(ctx);
            else await shell.ServeDocument(ctx, id, null);
        });
        app.MapGet("/r/{readId}", async (string readId, HttpContext ctx, AppShell shell, AgentApi api) =>
        {
            if (!DocIds.ReadId().IsMatch(readId)) await Results.NotFound().ExecuteAsync(ctx);
            else if (WantsMarkdown(ctx)) await (await api.Read(ctx, null, readId, withNote: true)).ExecuteAsync(ctx);
            else await shell.ServeDocument(ctx, null, readId);
        });
    }
}
