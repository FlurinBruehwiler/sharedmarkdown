using System.Security.Cryptography;
using SharedMarkdown;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

var dataDir = builder.Configuration["DataDir"] ?? Path.Combine(builder.Environment.ContentRootPath, "data");
Directory.CreateDirectory(dataDir);
builder.Services.AddDbContext<AppDb>(o => o.UseSqlite($"Data Source={Path.Combine(dataDir, "sharedmarkdown.db")}"));
builder.Services.AddSingleton<DocStore>();
builder.Services.AddHostedService<DocFlusher>();
builder.Services.AddSingleton<Assets>();
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 2 * 1024 * 1024);
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = MaxBlobBytes + 1024);

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDb>();
    // TODO: switch to EF migrations once the schema starts changing.
    db.Database.EnsureCreated();
    db.Database.ExecuteSqlRaw("PRAGMA journal_mode=WAL;");
}

var assets = app.Services.GetRequiredService<Assets>();
app.Use((ctx, next) => assets.TryServe(ctx, out var t) ? t : next(ctx));
app.UseWebSockets();

app.MapHub<DocHub>("/hub", o => o.Transports = Microsoft.AspNetCore.Http.Connections.HttpTransportType.WebSockets);

app.MapGet("/api/titles", async (string ids, DocStore store) =>
    Results.Ok(await store.Titles(ids.Split(',').Where(i => DocHub.IdPattern().IsMatch(i)).Distinct().Take(200))));

app.MapPost("/api/blobs", async (HttpRequest req, AppDb db) =>
{
    var type = req.ContentType?.Split(';')[0].Trim().ToLowerInvariant() ?? "";
    if (!AllowedImageTypes.Contains(type)) return Results.BadRequest("unsupported type");
    using var ms = new MemoryStream();
    await req.Body.CopyToAsync(ms);
    if (ms.Length == 0 || ms.Length > MaxBlobBytes) return Results.BadRequest("bad size");
    var data = ms.ToArray();
    var id = Convert.ToHexStringLower(SHA256.HashData(data))[..32];
    if (!await db.Blobs.AnyAsync(b => b.Id == id))
    {
        db.Blobs.Add(new Blob { Id = id, ContentType = type, Data = data, CreatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync();
    }
    return Results.Ok(new { url = $"/b/{id}" });
});

app.MapGet("/b/{id}", async (string id, HttpContext ctx, AppDb db) =>
{
    var blob = await db.Blobs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == id);
    if (blob is null) return Results.NotFound();
    ctx.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
    ctx.Response.Headers.XContentTypeOptions = "nosniff";
    return Results.File(blob.Data, blob.ContentType);
});

app.MapGet("/", assets.ServeIndex);
app.MapGet("/{id}", (string id, HttpContext ctx) => DocHub.IdPattern().IsMatch(id) ? assets.ServeIndex(ctx) : Results.NotFound().ExecuteAsync(ctx));

app.Run();

partial class Program
{
    const int MaxBlobBytes = 15 * 1024 * 1024;
    static readonly HashSet<string> AllowedImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
}
