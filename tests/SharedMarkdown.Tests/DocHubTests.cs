using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace SharedMarkdown.Tests;

public sealed class AppFactory : WebApplicationFactory<Program>
{
    readonly string _dir = Directory.CreateTempSubdirectory("sm-hub-").FullName;

    protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.UseSetting("DataDir", _dir);

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }
}

sealed class Client : IAsyncDisposable
{
    public readonly HubConnection Hub;
    public readonly ConcurrentQueue<(string Method, string Args)> Received = new();

    Client(HubConnection hub)
    {
        Hub = hub;
        foreach (var (method, arity) in new[] { ("ops", 1), ("cursor", 3), ("presence", 1), ("peer", 0), ("deleted", 0) })
            hub.On(method, Enumerable.Repeat(typeof(object), arity).ToArray(), args =>
            {
                Received.Enqueue((method, JsonSerializer.Serialize(args)));
                return Task.CompletedTask;
            });
    }

    public static async Task<Client> Connect(AppFactory app)
    {
        var server = app.Server;
        var hub = new HubConnectionBuilder()
            .WithUrl(new Uri(server.BaseAddress, "hub"), o =>
            {
                o.Transports = HttpTransportType.WebSockets;
                o.SkipNegotiation = true;
                o.WebSocketFactory = async (ctx, ct) => await server.CreateWebSocketClient().ConnectAsync(ctx.Uri, ct);
            })
            .Build();
        await hub.StartAsync();
        return new Client(hub);
    }

    public bool Got(string method) => Received.Any(r => r.Method == method);

    public async Task<bool> WaitFor(string method, int ms = 3000)
    {
        for (var waited = 0; waited < ms; waited += 20)
        {
            if (Got(method)) return true;
            await Task.Delay(20);
        }
        return false;
    }

    public ValueTask DisposeAsync() => Hub.DisposeAsync();
}

public class DocHubTests(AppFactory app) : IClassFixture<AppFactory>
{
    static string NewId() => "t" + Guid.NewGuid().ToString("N")[..15];
    static JsonElement Ops(object ops) => JsonSerializer.SerializeToElement(ops);
    static readonly JsonElement Hello = Ops(new object[] { new object[] { "i", "ed", 1, "", 0, "hello" } });

    [Fact]
    public async Task ReadOnlyConnectionsCanChangeNothingAndNeverSeeTheEditId()
    {
        var id = NewId();
        await using var editor = await Client.Connect(app);
        await using var reader = await Client.Connect(app);

        await editor.Hub.InvokeAsync<JoinResult>("Join", id);
        Assert.Equal(SubmitStatus.Ok, await editor.Hub.InvokeAsync<string>("Submit", id, Hello));
        var readId = await editor.Hub.InvokeAsync<string>("ReadLink", id);
        Assert.Matches(DocIds.ReadId(), readId);

        var joined = await reader.Hub.InvokeAsync<JsonElement>("JoinRead", readId);
        Assert.Contains("hello", joined.GetRawText());
        Assert.DoesNotContain(id, joined.GetRawText());

        var more = Ops(new object[] { new object[] { "i", "rd", 10, "ed", 5, "!" } });
        Assert.Equal(SubmitStatus.ReadOnly, await reader.Hub.InvokeAsync<string>("Submit", id, more));
        var e = await Assert.ThrowsAsync<HubException>(() => reader.Hub.InvokeAsync<string>("ReadLink", id));
        Assert.Contains(HubErrors.Invalid, e.Message);

        await reader.Hub.InvokeAsync("Cursor", "ed", 3L);
        await editor.Hub.InvokeAsync("Cursor", "ed", 2L);
        Assert.True(await reader.WaitFor("cursor"));
        await editor.Hub.InvokeAsync<string>("Submit", id, Ops(new object[] { new object[] { "i", "ed", 6, "ed", 5, "?" } }));
        Assert.True(await reader.WaitFor("ops"));
        await Task.Delay(200);
        Assert.DoesNotContain(editor.Received, r => r.Method == "cursor");
        Assert.DoesNotContain(reader.Received, r => r.Args.Contains(id));
        Assert.Equal("hello?", (await app.Services.GetRequiredService<DocStore>().Get(id)).Doc.Text());
    }

    [Fact]
    public async Task DeletedDocumentsStayDeleted()
    {
        var id = NewId();
        await using var editor = await Client.Connect(app);
        await editor.Hub.InvokeAsync<JoinResult>("Join", id);
        Assert.Equal(SubmitStatus.Ok, await editor.Hub.InvokeAsync<string>("Submit", id, Hello));
        var readId = await editor.Hub.InvokeAsync<string>("ReadLink", id);

        await app.Services.GetRequiredService<DocStore>().Delete([id]);
        Assert.True(await editor.WaitFor("deleted"));
        var more = Ops(new object[] { new object[] { "i", "ed", 6, "ed", 5, "!" } });
        Assert.Equal(SubmitStatus.Deleted, await editor.Hub.InvokeAsync<string>("Submit", id, more));

        await using var late = await Client.Connect(app);
        Assert.Contains(HubErrors.Deleted, (await Assert.ThrowsAsync<HubException>(() => late.Hub.InvokeAsync<JoinResult>("Join", id))).Message);
        Assert.Equal(SubmitStatus.Deleted, await late.Hub.InvokeAsync<string>("Submit", id, Hello));
        Assert.Contains(HubErrors.Deleted, (await Assert.ThrowsAsync<HubException>(() => late.Hub.InvokeAsync<JoinResult>("JoinRead", readId))).Message);
    }

    [Fact]
    public async Task JoinChecksIds()
    {
        await using var c = await Client.Connect(app);
        Assert.Contains(HubErrors.BadId, (await Assert.ThrowsAsync<HubException>(() => c.Hub.InvokeAsync<JoinResult>("Join", "bad/id"))).Message);
        Assert.Contains(HubErrors.NotFound, (await Assert.ThrowsAsync<HubException>(() => c.Hub.InvokeAsync<JoinResult>("JoinRead", "AAAAAAAAAAAAAAAA"))).Message);
        var result = await c.Hub.InvokeAsync<JsonElement>("Join", NewId());
        Assert.Equal("[]", result.GetProperty("state").GetRawText());
        Assert.True(result.GetProperty("maxChars").GetInt32() > 0);
        Assert.True(result.GetProperty("maxImageDimension").GetInt32() > 0);
    }

    [Fact]
    public async Task OnlyAppliedBatchesCountAsCreatingADocument()
    {
        var limits = app.Services.GetRequiredService<LimitsService>();
        var guard = app.Services.GetRequiredService<IpGuard>();
        await using var c = await Client.Connect(app);
        var id = NewId();
        await c.Hub.InvokeAsync<JoinResult>("Join", id);
        int Created() => guard.Activity().Where(a => a.Bucket == "create").Sum(a => a.Count);
        var used = Created();
        var bad = Ops(new object[] { new object[] { "i", "ed", 1, "nobody", 3, "x" } });
        Assert.Equal(SubmitStatus.Invalid, await c.Hub.InvokeAsync<string>("Submit", id, bad));
        var tooBig = Ops(new object[] { new object[] { "i", "ed", 1, "", 0, new string('x', limits.Current.MaxDocumentChars + 1) } });
        Assert.Equal(SubmitStatus.Size, await c.Hub.InvokeAsync<string>("Submit", id, tooBig));
        Assert.Equal(used, Created());
        Assert.Equal(SubmitStatus.Ok, await c.Hub.InvokeAsync<string>("Submit", id, Hello));
        Assert.Equal(used + 1, Created());
    }

    [Fact]
    public async Task CursorsAreRateLimited()
    {
        var id = NewId();
        await using var a = await Client.Connect(app);
        await using var b = await Client.Connect(app);
        await a.Hub.InvokeAsync<JoinResult>("Join", id);
        await b.Hub.InvokeAsync<JoinResult>("Join", id);
        for (int i = 0; i < DocHub.CursorsPerSecond * 3; i++) await a.Hub.InvokeAsync("Cursor", "x", (long)i);
        await b.Hub.InvokeAsync<string>("Version");
        await Task.Delay(200);
        var relayed = b.Received.Count(r => r.Method == "cursor");
        Assert.InRange(relayed, 1, DocHub.CursorsPerSecond * 2);
    }
}
