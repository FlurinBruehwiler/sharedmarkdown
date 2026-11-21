using System.Net;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using SharedMarkdown;
using SharedMarkdown.Admin;
using Serilog;
using Serilog.Events;

var builder = WebApplication.CreateBuilder(args);

var paths = new Paths(Path.GetFullPath(builder.Configuration["DataDir"] ?? Path.Combine(builder.Environment.ContentRootPath, "data")));
Directory.CreateDirectory(paths.DataDir);
builder.Services.AddSingleton(paths);
var logFiles = new LogFiles(paths);
builder.Services.AddSingleton(logFiles);
builder.Services.AddSerilog(log =>
{
    // Serilog replaces the logger factory, so the usual Logging:LogLevel filters are applied here.
    foreach (var level in builder.Configuration.GetSection("Logging:LogLevel").GetChildren())
        if (Enum.TryParse<LogEventLevel>(level.Value switch { "Trace" => "Verbose", "Critical" => "Fatal", var v => v }, out var min))
        {
            if (level.Key == "Default") log.MinimumLevel.Is(min);
            else log.MinimumLevel.Override(level.Key, min);
        }
    // SignalR logs every HubException (our expected refusals: "rate", "deleted"…) as an error.
    log.Filter.ByExcluding(e => e.Exception is Microsoft.AspNetCore.SignalR.HubException)
       .WriteTo.Console(outputTemplate: "{Level:u3} {SourceContext}: {Message:lj}{NewLine}{Exception}")
       .WriteTo.File(Path.Combine(logFiles.Dir, LogFiles.FilePattern), outputTemplate: LogFiles.Template,
           rollingInterval: RollingInterval.Day, retainedFileCountLimit: 30, fileSizeLimitBytes: 20_000_000, rollOnFileSizeLimit: true);
});
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlite(paths.ConnectionString));
builder.Services.AddSingleton<DocStore>();
builder.Services.AddHostedService<DocFlusher>();
builder.Services.AddSingleton<AppShell>();
builder.Services.AddSingleton<ImageService>();
builder.Services.AddSingleton<LimitsService>();
builder.Services.AddSingleton<IpGuard>();
builder.Services.AddSingleton<Maintenance>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Maintenance>());
builder.Services.AddSingleton<ServerMetrics>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ServerMetrics>());
builder.Services.AddSingleton<Traffic>();
builder.Services.AddSignalR(o =>
{
    o.MaximumReceiveMessageSize = 512 * 1024;
    o.AddFilter<TrafficHubFilter>();
});

// Without this every visitor behind the reverse proxy would share its IP, and so one set of rate limits.
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
    o.KnownProxies.Add(IPAddress.Loopback);
    o.KnownProxies.Add(IPAddress.IPv6Loopback);
    foreach (var proxy in builder.Configuration.GetSection("KnownProxies").Get<string[]>() ?? [])
        o.KnownProxies.Add(IPAddress.Parse(proxy));
});

// A fixed name: otherwise the key scope follows the install path and every deploy would log the admin out.
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

await Database.Prepare(app.Services);
await app.Services.GetRequiredService<LimitsService>().Load();
await app.Services.GetRequiredService<IpGuard>().LoadBlocked();
await app.Services.GetRequiredService<DocStore>().LoadDeleted();

var traffic = app.Services.GetRequiredService<Traffic>();
app.Use((ctx, next) => { traffic.Request(); return next(ctx); });
app.UseForwardedHeaders();
if (!app.Environment.IsDevelopment()) app.UseHsts();
app.UseSecurityHeaders();
app.UseAuthentication();
app.UseAuthorization();
app.UseAntiforgery();

app.MapGet("/healthz", async (AppDb db) => await db.Database.CanConnectAsync() ? Results.Text("ok") : Results.StatusCode(503));
// Code-split chunks are named by their content (esbuild), so they never change: cache them for good.
app.Use((ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/assets/chunks"))
        ctx.Response.OnStarting(() => { ctx.Response.Headers.CacheControl = "public, max-age=31536000, immutable"; return Task.CompletedTask; });
    return next(ctx);
});
app.MapStaticAssets();
app.Services.GetRequiredService<AppShell>().Load(app);
app.MapDocuments();
app.MapBlobs();
app.MapAdmin();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();

app.Run();

public partial class Program;
