using System.Net;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
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
builder.Services.AddSingleton<AppShell>();
builder.Services.AddSingleton<ImageService>();
builder.Services.AddSingleton<LimitsService>();
builder.Services.AddSingleton<IpGuard>();
builder.Services.AddSingleton<Maintenance>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Maintenance>());
builder.Services.AddSingleton<ServerMetrics>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ServerMetrics>());
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 512 * 1024);

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

await Database.Prepare(app.Services);
await app.Services.GetRequiredService<LimitsService>().Load();
await app.Services.GetRequiredService<IpGuard>().LoadBlocked();
await app.Services.GetRequiredService<DocStore>().LoadDeleted();

app.UseForwardedHeaders();
if (!app.Environment.IsDevelopment()) app.UseHsts();
app.UseSecurityHeaders();
app.UseAuthentication();
app.UseAuthorization();
app.UseAntiforgery();

app.MapGet("/healthz", async (AppDb db) => await db.Database.CanConnectAsync() ? Results.Text("ok") : Results.StatusCode(503));
app.MapStaticAssets();
app.Services.GetRequiredService<AppShell>().Load(app); // after MapStaticAssets
app.MapDocuments();
app.MapBlobs();
app.MapAdmin();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();

app.Run();

/// Entry point; public for WebApplicationFactory in the tests.
public partial class Program;
