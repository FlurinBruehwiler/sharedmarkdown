using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

namespace SharedMarkdown.Admin;

public static class AdminEndpoints
{
    public static void MapAdmin(this IEndpointRouteBuilder app)
    {
        app.MapGet("/admin/backups/{name}", (string name, Maintenance maintenance) =>
            maintenance.FindBackup(name) is { } b ? Results.File(b.Path, "application/vnd.sqlite3", b.Name) : Results.NotFound())
            .RequireAuthorization();

        app.MapPost("/admin/logout", async (HttpContext ctx) =>
        {
            await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return Results.Redirect("/admin/login");
        }).RequireAuthorization();
    }
}
