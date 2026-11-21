using System.Net;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using SharedMarkdown;
using SharedMarkdown.Admin;

var builder = WebApplication.CreateBuilder(args);

var paths = new Paths(Path.GetFullPath(builder.Configuration["DataDir"] ?? Path.Combine(builder.Environment.ContentRootPath, "data")));
Directory.CreateDirectory(paths.DataDir);
builder.Services.AddSingleton(paths);
// The factory also registers AppDb as scoped; Blazor pages use the factory (one context per operation).
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlite(paths.ConnectionString));
builder.Services.AddSingleton<DocStore>();
builder.Services.AddHostedService<DocFlusher>();
builder.Services.AddSingleton<Assets>();
builder.Services.AddSingleton<LimitsService>();
builder.Services.AddSingleton<IpGuard>();
builder.Services.AddSingleton<Maintenance>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Maintenance>());
builder.Services.AddSingleton<ServerMetrics>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ServerMetrics>());
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 512 * 1024);
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 64 * 1024 * 1024);

// Behind a reverse proxy the client IP comes from X-Forwarded-For; without this every visitor
// would share the proxy's IP and therefore one set of rate limits.
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
    o.KnownProxies.Add(IPAddress.Loopback);
    o.KnownProxies.Add(IPAddress.IPv6Loopback);
    foreach (var proxy in builder.Configuration.GetSection("KnownProxies").Get<string[]>() ?? [])
        o.KnownProxies.Add(IPAddress.Parse(proxy));
});

// Keys for the admin login cookie and antiforgery; kept with the data so logins survive restarts.
// A fixed application name, otherwise the key scope follows the install path and every deploy
// to a new release folder would log the admin out.
builder.Services.AddDataProtection().SetApplicationName("SharedMarkdown").PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(paths.DataDir, "keys")));
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(o =>
{
    o.LoginPath = "/admin/login";
    o.Cookie.Name = "sm_admin";
    o.Cookie.HttpOnly = true;
    o.Cookie.SameSite = SameSiteMode.Strict;
    o.ExpireTimeSpan = TimeSpan.FromDays(7);
    o.SlidingExpiration = true;
});
builder.Services.AddAuthorization();
builder.Services.AddCascadingAuthenticationState();
builder.Services.AddRazorComponents().AddInteractiveServerComponents();

var app = builder.Build();

await PrepareDatabase(app);
await app.Services.GetRequiredService<LimitsService>().Load();
await app.Services.GetRequiredService<IpGuard>().LoadBlocked();

app.UseForwardedHeaders();
if (!app.Environment.IsDevelopment()) app.UseHsts();
app.Use((ctx, next) =>
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

var assets = app.Services.GetRequiredService<Assets>();
app.Use((ctx, next) => assets.TryServe(ctx, out var t) ? t : next(ctx));

app.UseAuthentication();
app.UseAuthorization();
app.UseAntiforgery();

app.MapHub<DocHub>("/hub", o => o.Transports = Microsoft.AspNetCore.Http.Connections.HttpTransportType.WebSockets);

app.MapGet("/healthz", async (AppDb db) => await db.Database.CanConnectAsync() ? Results.Text("ok") : Results.StatusCode(503));

app.MapGet("/api/titles", async (string ids, HttpContext ctx, DocStore store, IpGuard guard, LimitsService limits) =>
{
    var ip = IpGuard.IpOf(ctx);
    if (guard.IsBlocked(ip)) return Results.StatusCode(403);
    if (!guard.TryTake("titles", ip, limits.Current.TitleLookupsPerIpPerMinute, TimeSpan.FromMinutes(1))) return Results.StatusCode(429);
    return Results.Ok(await store.Titles(ids.Split(',').Where(i => DocHub.IdPattern().IsMatch(i)).Distinct().Take(200)));
});

// Image decoding is CPU heavy; don't let a burst of uploads take every core.
var imageSlots = new SemaphoreSlim(Math.Max(1, Environment.ProcessorCount / 2));
app.MapPost("/api/blobs", async (HttpContext ctx, AppDb db, IpGuard guard, LimitsService limits, ILogger<ImageUploads> log) =>
{
    var ip = IpGuard.IpOf(ctx);
    var l = limits.Current;
    var mb = $"{l.MaxUploadBytes / 1024.0 / 1024:0.#} MB";
    if (guard.IsBlocked(ip)) return Results.Text("Uploads are blocked.", statusCode: 403);
    if (ctx.Request.ContentLength > l.MaxUploadBytes) return Results.Text($"Images can be at most {mb}.", statusCode: 413);
    if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } body) body.MaxRequestBodySize = l.MaxUploadBytes;
    if (!guard.TryTake("upload", ip, l.UploadsPerIpPerHour, TimeSpan.FromHours(1)))
        return Results.Text("Too many uploads, please try again later.", statusCode: 429);

    byte[] input;
    try
    {
        using var ms = new MemoryStream();
        await ctx.Request.Body.CopyToAsync(ms);
        input = ms.ToArray();
    }
    catch (BadHttpRequestException) { return Results.Text($"Images can be at most {mb}.", statusCode: 413); }
    if (input.Length == 0) return Results.Text("Empty upload.", statusCode: 400);

    ProcessedImage? image;
    var started = System.Diagnostics.Stopwatch.GetTimestamp();
    await imageSlots.WaitAsync();
    try { image = await Task.Run(() => ImageProcessor.Process(input, l.MaxImageDimension)); }
    finally { imageSlots.Release(); }
    if (image is null) return Results.Text("This file isn't a supported image (PNG, JPEG, GIF or WebP).", statusCode: 400);
    log.LogInformation("Image {In} bytes {InType} -> {Out} bytes {OutType} {W}x{H} in {Ms:0} ms", input.Length, ctx.Request.ContentType, image.Data.Length, image.ContentType, image.Width, image.Height,
        System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds);

    var id = Convert.ToHexStringLower(SHA256.HashData(image.Data))[..32];
    if (!await db.Blobs.AnyAsync(b => b.Id == id))
    {
        db.Blobs.Add(new Blob { Id = id, ContentType = image.ContentType, Data = image.Data, Width = image.Width, Height = image.Height, UploaderIp = ip, CreatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync();
    }
    return Results.Ok(new { url = $"/b/{id}" });
});

app.MapGet("/b/{id}", async (string id, HttpContext ctx, AppDb db) =>
{
    var blob = await db.Blobs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == id);
    if (blob is null) return Results.NotFound();
    ctx.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
    ctx.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
    return Results.File(blob.Data, blob.ContentType);
});

app.MapGet("/admin/backups/{name}", (string name, Maintenance maintenance) =>
    maintenance.FindBackup(name) is { } b ? Results.File(b.Path, "application/vnd.sqlite3", b.Name) : Results.NotFound())
    .RequireAuthorization();

app.MapPost("/admin/logout", async (HttpContext ctx) =>
{
    await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.Redirect("/admin/login");
}).RequireAuthorization();

app.MapStaticAssets();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();

app.MapGet("/", assets.ServeIndex);
app.MapGet("/{id}", (string id, HttpContext ctx) => DocHub.IdPattern().IsMatch(id) ? assets.ServeIndex(ctx) : Results.NotFound().ExecuteAsync(ctx));

app.Run();

static async Task PrepareDatabase(WebApplication app)
{
    var paths = app.Services.GetRequiredService<Paths>();
    var log = app.Services.GetRequiredService<ILogger<Program>>();
    // Databases from before migrations existed can't be upgraded; set them aside rather than fail.
    if (File.Exists(paths.Database))
    {
        bool legacy;
        await using (var conn = new SqliteConnection(paths.ConnectionString + ";Pooling=False"))
        {
            await conn.OpenAsync();
            var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT count(*) FROM sqlite_master WHERE name = 'Documents'";
            var hasDocs = (long)(await cmd.ExecuteScalarAsync())! > 0;
            cmd.CommandText = "SELECT count(*) FROM sqlite_master WHERE name = '__EFMigrationsHistory'";
            legacy = hasDocs && (long)(await cmd.ExecuteScalarAsync())! == 0;
        }
        if (legacy)
        {
            var suffix = $".pre-migrations-{DateTime.UtcNow:yyyyMMddHHmmss}.bak";
            foreach (var f in new[] { "", "-wal", "-shm" })
                if (File.Exists(paths.Database + f)) File.Move(paths.Database + f, paths.Database + f + suffix);
            log.LogWarning("Old database without migrations moved to {File}", paths.Database + suffix);
        }
    }
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDb>();
    await db.Database.MigrateAsync();
    await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL;");
    log.LogInformation("Using database {File}", paths.Database);
}

/// Log category for image uploads.
public class ImageUploads;

public partial class Program
{
    /// Constant-time password check for the admin login. Empty configured password = admin disabled.
    public static bool CheckAdminPassword(IConfiguration config, string? attempt)
    {
        var expected = config["Admin:Password"];
        if (string.IsNullOrEmpty(expected) || string.IsNullOrEmpty(attempt)) return false;
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(attempt)), SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(expected)));
    }
}
