using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace SharedMarkdown.Tests;

public class LinkPreviewTests(AppFactory app) : IClassFixture<AppFactory>
{
    const string GenericTitle = "<title>SharedMarkdown – Collaborative Markdown editor, no account needed</title>";

    static string NewId() => "t" + Guid.NewGuid().ToString("N")[..15];

    static string? Meta(string html, string attr, string name) =>
        Regex.Match(html, $"<meta {attr}=\"{Regex.Escape(name)}\" content=\"([^\"]*)\">") is { Success: true } m ? WebUtility.HtmlDecode(m.Groups[1].Value) : null;

    async Task<(string Id, string ReadId)> Create(string text)
    {
        var id = NewId();
        await using var c = await Client.Connect(app);
        await c.Hub.InvokeAsync<JoinResult>("Join", id);
        var ops = JsonSerializer.SerializeToElement(new object[] { new object[] { "i", "ed", 1, "", 0, text } });
        Assert.Equal(SubmitStatus.Ok, await c.Hub.InvokeAsync<string>("Submit", id, ops));
        var readId = await c.Hub.InvokeAsync<string>("ReadLink", id);
        return (id, readId);
    }

    async Task<string> Page(string path)
    {
        var res = await app.CreateClient().GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Contains("noindex", res.Headers.GetValues("X-Robots-Tag").Single());
        return await res.Content.ReadAsStringAsync();
    }

    static void AssertGeneric(string html)
    {
        Assert.Contains(GenericTitle, html);
        Assert.Equal("https://sharedmarkdown.com/", Meta(html, "property", "og:url"));
        Assert.Contains("<link rel=\"canonical\"", html);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DocumentPagesPreviewTheirTitleAndText(bool flushed)
    {
        var (id, readId) = await Create("# Trip plan\n\nWe **leave** on Friday.\n- pack [maps](https://x.y)\n");
        if (flushed) await app.Services.GetRequiredService<DocStore>().Flush(false);

        foreach (var path in new[] { "/" + id, "/r/" + readId })
        {
            var html = await Page(path);
            Assert.Contains("<title data-site=\"SharedMarkdown – Collaborative Markdown editor, no account needed\">Trip plan · SharedMarkdown</title>", html);
            Assert.Equal("Trip plan", Meta(html, "property", "og:title"));
            Assert.Equal("We leave on Friday. pack maps", Meta(html, "property", "og:description"));
            Assert.Equal("We leave on Friday. pack maps", Meta(html, "name", "description"));
            Assert.Equal("article", Meta(html, "property", "og:type"));
            Assert.Equal("http://localhost" + path, Meta(html, "property", "og:url"));
            Assert.Equal("https://sharedmarkdown.com/og.png", Meta(html, "property", "og:image"));
            Assert.DoesNotContain("rel=\"canonical\"", html);
        }
        Assert.DoesNotContain(id, await Page("/r/" + readId));
    }

    [Fact]
    public async Task TheHomePageStaysGeneric()
    {
        var res = await app.CreateClient().GetAsync("/");
        Assert.False(res.Headers.Contains("X-Robots-Tag"));
        var html = await res.Content.ReadAsStringAsync();
        AssertGeneric(html);
        Assert.Equal("website", Meta(html, "property", "og:type"));
    }

    [Fact]
    public async Task UntitledText()
    {
        var (id, _) = await Create("Only a title");
        var html = await Page("/" + id);
        Assert.Equal("Only a title", Meta(html, "property", "og:title"));
        Assert.Equal("A shared Markdown document on SharedMarkdown.", Meta(html, "property", "og:description"));
    }

    [Fact]
    public async Task UnknownEmptyAndDeletedDocumentsGetTheGenericPage()
    {
        var store = app.Services.GetRequiredService<DocStore>();
        var unknown = NewId();
        var live = store.LiveCount;
        AssertGeneric(await Page("/" + unknown));
        AssertGeneric(await Page("/r/AAAAAAAAAAAAAAAA"));
        Assert.Equal(live, store.LiveCount);
        await using (var scope = app.Services.CreateAsyncScope())
            Assert.False(await scope.ServiceProvider.GetRequiredService<AppDb>().Documents.AnyAsync(d => d.Id == unknown));

        var (empty, emptyRead) = await Create("  \n![](/b/x)\n");
        AssertGeneric(await Page("/" + empty));
        AssertGeneric(await Page("/r/" + emptyRead));

        var (deleted, deletedRead) = await Create("# Secret\n\nGone now");
        await store.Flush(false);
        await store.Delete([deleted]);
        AssertGeneric(await Page("/" + deleted));
        AssertGeneric(await Page("/r/" + deletedRead));
    }

    [Fact]
    public async Task DocumentTextIsEscaped()
    {
        var evil = "\"><script>alert(1)</script>";
        var (id, readId) = await Create($"# {evil}\n\n<img src=x onerror=alert(2)> 'quote' & \"double\" </title><script>alert(3)</script>");
        var scripts = Regex.Matches(await Page("/" + NewId()), "<script").Count;
        foreach (var path in new[] { "/" + id, "/r/" + readId })
        {
            var html = await Page(path);
            Assert.DoesNotContain("alert(1)</script>", html);
            Assert.DoesNotContain("<script>alert", html);
            Assert.DoesNotContain("onerror=alert(2)>", html);
            Assert.Equal(evil, Meta(html, "property", "og:title"));
            Assert.Contains("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; · SharedMarkdown</title>", html);
            Assert.Equal("'quote' & \"double\" alert(3)", Meta(html, "property", "og:description"));
            Assert.Equal(scripts, Regex.Matches(html, "<script").Count);
        }
    }

    [Theory]
    [InlineData("# Title\nBody text", "Body text")]
    [InlineData("Title", "")]
    [InlineData("\n\n## Title\n\n## Sub *heading*\n> quoted _words_\n> > nested\n1. one\n- [x] done\n* star", "Sub heading quoted words nested one done star")]
    [InlineData("T\n![pic](/b/abc) after [link](https://x) ~~gone~~ ==hl== `code` __u__", "after link gone hl code u")]
    [InlineData("T\n| a | b |\n|---|:--:|\n| 1 | 2 |", "a b 1 2")]
    [InlineData("T\n```js\nlet x = 1\n```\n---\n***\nend", "let x = 1 end")]
    [InlineData("T\nsnake_case_name and 2*3*4 stay", "snake_case_name and 2*3*4 stay")]
    [InlineData("T\n  lots   of\t\tspace  \n\n\nhere", "lots of space here")]
    public void SnippetIsPlainText(string md, string snippet) => Assert.Equal(snippet, MarkdownTitle.Snippet(md));

    [Fact]
    public void SnippetIsCutAtAWord()
    {
        var md = "Title\n" + string.Join(' ', Enumerable.Repeat("word,", 100));
        var s = MarkdownTitle.Snippet(md);
        Assert.EndsWith("word…", s);
        Assert.InRange(s.Length, 150, 181);

        var unbroken = MarkdownTitle.Snippet("Title\n" + new string('x', 500));
        Assert.Equal(new string('x', 180) + "…", unbroken);
    }
}
