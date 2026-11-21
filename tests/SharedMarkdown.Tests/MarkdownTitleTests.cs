using System.Text.Json;

namespace SharedMarkdown.Tests;

public class MarkdownTitleTests
{
    record TitleCase(string Markdown, string Title);

    public static TheoryData<string, string> Cases()
    {
        var cases = JsonSerializer.Deserialize<List<TitleCase>>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "titles.json")), JsonSerializerOptions.Web)!;
        var data = new TheoryData<string, string>();
        foreach (var c in cases) data.Add(c.Markdown, c.Title);
        return data;
    }

    // Shared with the client's titleOf (src/client/src/main.ts).
    [Theory]
    [MemberData(nameof(Cases))]
    public void MatchesSharedFixture(string markdown, string title) => Assert.Equal(title, MarkdownTitle.Of(markdown));
}
