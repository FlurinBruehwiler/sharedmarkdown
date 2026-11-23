using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace SharedMarkdown.Tests;

public class AgentApiTests(AppFactory app) : IClassFixture<AppFactory>
{
    readonly HttpClient http = app.CreateClient();

    static string NewId() => "a" + Guid.NewGuid().ToString("N")[..15];

    async Task<HttpResponseMessage> Put(string id, string text, string? ifMatch = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Put, $"/{id}.md") { Content = new StringContent(text) };
        if (ifMatch != null) req.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        return await http.SendAsync(req);
    }

    Task<HttpResponseMessage> Patch(string id, object body) =>
        http.SendAsync(new HttpRequestMessage(HttpMethod.Patch, $"/{id}.md") { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") });

    async Task<string> Text(string id) => await http.GetStringAsync($"/{id}.md");

    [Fact]
    public async Task ReadsWhatIsWritten()
    {
        var id = NewId();
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/{id}.md")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Put(id, "# Notes\r\n\r\none\ntwo\n")).StatusCode);
        var res = await http.GetAsync($"/{id}.md");
        Assert.Equal("text/markdown", res.Content.Headers.ContentType?.MediaType);
        Assert.Equal("# Notes\n\none\ntwo\n", await res.Content.ReadAsStringAsync());
        Assert.Equal("4", res.Headers.GetValues("X-Total-Lines").Single());
        Assert.NotNull(res.Headers.ETag);
        Assert.Equal("one\ntwo", await http.GetStringAsync($"/{id}.md?lines=3-"));
        Assert.Equal("     2\t\n     3\tone", await http.GetStringAsync($"/{id}.md?lines=2-3&numbered=1"));
        Assert.Equal(HttpStatusCode.BadRequest, (await http.GetAsync($"/{id}.md?lines=9-12")).StatusCode);

        var md = new HttpRequestMessage(HttpMethod.Get, $"/{id}");
        md.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/markdown"));
        var negotiated = await (await http.SendAsync(md)).Content.ReadAsStringAsync();
        Assert.StartsWith("<!-- SharedMarkdown", negotiated);
        Assert.Contains($"PATCH http://localhost/{id}.md", negotiated);
        Assert.EndsWith("-->\n\n# Notes\n\none\ntwo\n", negotiated);
        Assert.Contains("<html", await http.GetStringAsync($"/{id}"));
    }

    [Fact]
    public async Task PatchReplacesExactTextOnce()
    {
        var id = NewId();
        await Put(id, "- [ ] Milk\n- [ ] Bread\n");
        var ok = await Patch(id, new { edits = new object[] { new { old = "- [ ] Milk", @new = "- [x] Milk" }, new { append = "- [ ] Eggs" } } });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal("- [x] Milk\n- [ ] Bread\n- [ ] Eggs", await Text(id));

        var twice = await Patch(id, new { old = "- [", @new = "* [" });
        Assert.Equal(HttpStatusCode.Conflict, twice.StatusCode);
        Assert.Contains("3 times", await twice.Content.ReadAsStringAsync());

        var missing = await Patch(id, new { edits = new object[] { new { old = "Bread", @new = "Rye" }, new { old = "Butter", @new = "x" } } });
        Assert.Equal(HttpStatusCode.Conflict, missing.StatusCode);
        Assert.Equal("- [x] Milk\n- [ ] Bread\n- [ ] Eggs", await Text(id)); // all or nothing

        Assert.Equal(HttpStatusCode.OK, (await Patch(id, new { old = "- [", @new = "* [", all = true })).StatusCode);
        Assert.Equal("* [x] Milk\n* [ ] Bread\n* [ ] Eggs", await Text(id));
        Assert.Equal(HttpStatusCode.BadRequest, (await Patch(id, new { old = "", @new = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await http.SendAsync(new HttpRequestMessage(HttpMethod.Patch, $"/{id}.md") { Content = new StringContent("not json") })).StatusCode);
    }

    [Fact]
    public async Task PutNeedsTheCurrentVersion()
    {
        var id = NewId();
        await Put(id, "first");
        Assert.Equal(HttpStatusCode.PreconditionRequired, (await Put(id, "second")).StatusCode);
        Assert.Equal(HttpStatusCode.PreconditionFailed, (await Put(id, "second", "\"0000000000000000\"")).StatusCode);
        var etag = (await http.GetAsync($"/{id}.md")).Headers.ETag!.Tag;
        Assert.Equal(HttpStatusCode.OK, (await Put(id, "second", etag)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Put(id, "third", "*")).StatusCode);
        Assert.Equal("third", await Text(id));
    }

    [Fact]
    public async Task CreatesDocumentsWithBothLinks()
    {
        var res = await http.PostAsync("/new.md", new StringContent("# Made by an agent\n"));
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var editId = res.Headers.Location!.AbsolutePath.Trim('/');
        Assert.Matches(DocIds.EditId(), editId);
        Assert.Equal("# Made by an agent\n", await Text(editId));
        var readLink = (await res.Content.ReadAsStringAsync()).Split('\n').Single(l => l.StartsWith("Read-only link: "));
        var readId = readLink[(readLink.LastIndexOf('/') + 1)..];
        Assert.Equal("# Made by an agent\n", await http.GetStringAsync($"/r/{readId}.md"));
    }

    [Fact]
    public async Task ReadLinksCantWrite()
    {
        var res = await http.PostAsync("/new.md", new StringContent("secret plans"));
        var body = await res.Content.ReadAsStringAsync();
        var readId = body.Split('\n').Single(l => l.StartsWith("Read-only link: ")).Split('/').Last();
        var put = await http.SendAsync(new HttpRequestMessage(HttpMethod.Put, $"/r/{readId}.md") { Content = new StringContent("gone") });
        Assert.Equal(HttpStatusCode.Forbidden, put.StatusCode);
        var patch = await http.SendAsync(new HttpRequestMessage(HttpMethod.Patch, $"/r/{readId}.md") { Content = new StringContent("{\"old\":\"secret\",\"new\":\"open\"}") });
        Assert.Equal(HttpStatusCode.Forbidden, patch.StatusCode);
        Assert.Equal("secret plans", await http.GetStringAsync($"/r/{readId}.md"));
    }

    [Fact]
    public async Task RefusesTooLargeAndDeletedDocuments()
    {
        var id = NewId();
        var big = await Put(id, new string('x', 50_001));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, big.StatusCode);
        Assert.Equal("", await Text(id));

        await Put(id, "soon gone");
        await app.Services.GetRequiredService<DocStore>().Delete([id]);
        Assert.Equal(HttpStatusCode.Gone, (await http.GetAsync($"/{id}.md")).StatusCode);
        Assert.Equal(HttpStatusCode.Gone, (await Put(id, "back", "*")).StatusCode);
    }

    [Fact]
    public async Task EditsReachOpenEditorsAndMergeWithTheirs()
    {
        var id = NewId();
        await Put(id, "# Plan\n\n- one\n");
        await using var editor = await Client.Connect(app);
        var joined = await editor.Hub.InvokeAsync<JoinResult>("Join", id);
        var replica = Rga.Decode(joined.State.GetRawText());

        Assert.Equal(HttpStatusCode.OK, (await Patch(id, new { old = "- one", @new = "- one (agent)" })).StatusCode);
        Assert.True(await editor.WaitFor("ops"));
        var ops = JsonDocument.Parse(editor.Received.First(r => r.Method == "ops").Args).RootElement[0];
        Assert.Equal(Rga.ApplyResult.Ok, replica.Apply(ops, 50_000, 500_000));
        Assert.Equal("# Plan\n\n- one (agent)\n", replica.Text());

        // A person's edit made before seeing the agent's still lands where they made it.
        var mine = JsonSerializer.SerializeToElement(new object[] { new object[] { "i", "person", 1000, "", 0, "Title: " } });
        Assert.Equal(SubmitStatus.Ok, await editor.Hub.InvokeAsync<string>("Submit", id, mine));
        Assert.Equal("Title: # Plan\n\n- one (agent)\n", await Text(id));
    }
}
