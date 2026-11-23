using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;

namespace SharedMarkdown;

// Documents as Markdown files over plain HTTP, for AI agents and scripts: {document URL}.md. Documented for them in
// src/client/public/llms.txt. Edits become CRDT ops like a person's typing, so open editors update live.
public class AgentApi(DocStore store, IpGuard guard, LimitsService limits, IHubContext<DocHub> hub)
{
    readonly record struct Change(int Pos, int Delete, string Insert);

    sealed record Plan(List<Change> Changes, string Summary);

    sealed class Refused(IResult result) : Exception { public IResult Result { get; } = result; }

    public async Task<IResult> Read(HttpContext ctx, string? id, string? readId, bool withNote = false)
    {
        var ip = IpGuard.IpOf(ctx);
        if (guard.IsBlocked(ip)) return Message(403, "Access from your network is blocked.");
        if (!guard.TryTake("join", ip, limits.Current.JoinsPerIpPerMinute, TimeSpan.FromMinutes(1))) return TooMany();
        if (id != null && store.IsDeleted(id) || readId != null && store.IsDeletedReadId(readId)) return Deleted();
        var text = await store.PreviewText(id, readId);
        if (text is null)
            return Message(404, id != null
                ? $"There is no document at this link yet. PUT Markdown to this URL to write it, or POST to {Origin(ctx)}/new.md for a new document."
                : "There is no document at this link.");

        var lines = Lines(text);
        var (from, to) = (1, lines.Length);
        if (ctx.Request.Query["lines"].ToString() is { Length: > 0 } range && !TryRange(range, lines.Length, out from, out to))
            return Message(400, $"lines must look like 10-40, 10- or 10 (the document has {lines.Length} lines).");
        var numbered = ctx.Request.Query["numbered"].ToString() is "1" or "true";
        var body = from == 1 && to == lines.Length && !numbered
            ? text
            : string.Join('\n', lines[(from - 1)..to].Select((line, i) => numbered ? $"{from + i,6}\t{line}" : line));
        ctx.Response.Headers.ETag = Version(text);
        ctx.Response.Headers["X-Total-Lines"] = lines.Length.ToString();
        ctx.Response.Headers.CacheControl = "no-store";
        // Fetch tools that ask the plain link for Markdown never see the page's note for agents. Hidden when rendered.
        if (withNote)
        {
            var md = $"{Origin(ctx)}{ctx.Request.Path}.md";
            body = (id != null
                ? $"<!-- SharedMarkdown (this note isn't part of the document): anyone with this link, AI agents included, can edit the document over plain HTTP; people who have it open see the changes live. Read the exact text at {md}, change it with PATCH {md}. How: {Origin(ctx)}/llms.txt -->"
                : $"<!-- SharedMarkdown (this note isn't part of the document): this is a read-only link. The exact text: {md}. More: {Origin(ctx)}/llms.txt -->") + "\n\n" + body;
        }
        return Results.Text(body, "text/markdown; charset=utf-8");
    }

    public Task<IResult> Patch(HttpContext ctx, string id) => Write(ctx, id, async () =>
    {
        var edits = ParseEdits(await Body(ctx));
        return text =>
        {
            var changes = new List<Change>();
            var done = new List<string>();
            for (var n = 0; n < edits.Count; n++)
            {
                var (old, replacement, all, append) = edits[n];
                var which = edits.Count > 1 ? $"Edit {n + 1}: " : "";
                if (append)
                {
                    var sep = text.Length == 0 || text.EndsWith('\n') || replacement.StartsWith('\n') ? "" : "\n";
                    changes.Add(new Change(text.Length, 0, sep + replacement));
                    done.Add($"appended at line {Lines(text).Length + 1}");
                    text += sep + replacement;
                    continue;
                }
                var at = Occurrences(text, old);
                if (at.Count == 0)
                    throw new Refused(Message(409, Capitalize(which + "the \"old\" text isn't in the document (it must match exactly, including whitespace and line breaks). The document may have changed: GET it again. Nothing was changed.")));
                if (at.Count > 1 && !all)
                    throw new Refused(Message(409, Capitalize(which + $"the \"old\" text appears {at.Count} times. Include more of the surrounding text to make it unique, or set \"all\": true to replace every occurrence. Nothing was changed.")));
                done.Add(at.Count > 1 ? $"replaced {at.Count} occurrences" : $"replaced text at line {LineOf(text, at[0])}");
                for (var k = at.Count - 1; k >= 0; k--)
                {
                    changes.Add(Minimal(at[k], old, replacement));
                    text = string.Concat(text.AsSpan(0, at[k]), replacement, text.AsSpan(at[k] + old.Length));
                }
            }
            return new Plan(changes, Capitalize(string.Join("; ", done)) + ".");
        };
    });

    public Task<IResult> Put(HttpContext ctx, string id) => Write(ctx, id, async () =>
    {
        var replacement = Normalize(await Body(ctx));
        var expected = ctx.Request.Headers.IfMatch.ToString();
        return text =>
        {
            if (text.Length > 0 && expected.Length == 0)
                throw new Refused(Message(428, "The document isn't empty: send If-Match with the ETag from your last GET, so you don't overwrite changes made since. (If-Match: * overwrites anyway.) Or use PATCH to change parts of it."));
            if (expected.Length > 0 && expected != "*" && expected != Version(text))
                throw new Refused(Message(412, "The document changed since you read it. GET it again and redo your change. Nothing was changed."));
            return new Plan([Minimal(0, text, replacement)], "Replaced the document.");
        };
    });

    public async Task<IResult> Create(HttpContext ctx)
    {
        var id = DocIds.NewEditId();
        var origin = Origin(ctx);
        var result = await Write(ctx, id, async () =>
        {
            var text = Normalize(await Body(ctx));
            return _ => new Plan([new Change(0, 0, text)], "Created the document.");
        }, s =>
        {
            ctx.Response.Headers.Location = $"{origin}/{id}";
            return $"Created a document.\nEdit link (anyone with it can read and edit; share it with whoever asked): {origin}/{id}\nRead-only link: {origin}/r/{store.EnsureReadId(s)}\nMarkdown, for reading and editing over HTTP: {origin}/{id}.md";
        });
        return result;
    }

    async Task<IResult> Write(HttpContext ctx, string id, Func<Task<Func<string, Plan>>> prepare, Func<DocState, string>? created = null)
    {
        var ip = IpGuard.IpOf(ctx);
        if (guard.IsBlocked(ip)) return Message(403, "Access from your network is blocked.");
        var l = limits.Current;
        if (!guard.TryTake("submit", ip, l.SubmitsPerIpPerMinute, TimeSpan.FromMinutes(1))) return TooMany();
        if (store.IsDeleted(id)) return Deleted();
        Func<string, Plan> plan;
        try { plan = await prepare(); }
        catch (Refused r) { return r.Result; }

        while (true)
        {
            var s = await store.Get(id);
            await s.Lock.WaitAsync();
            try
            {
                if (s.Deleted) return Deleted();
                if (s.Evicted) continue;
                Plan p;
                try { p = plan(s.Doc.Text()); }
                catch (Refused r) { return r.Result; }
                var inserted = p.Changes.Sum(c => c.Insert.Length);
                var length = s.Doc.Length + inserted - p.Changes.Sum(c => c.Delete);
                if (length > s.Doc.Length && length > l.MaxDocumentChars)
                    return Message(413, $"The document would be {length:N0} characters long; the limit is {l.MaxDocumentChars:N0}. Nothing was changed.");
                if (s.Doc.Items + inserted > l.MaxDocumentItems)
                    return Message(413, "The document's edit history is full; it can't grow any more. Nothing was changed.");
                var creating = s.IsNew && inserted > 0;
                if (creating && !guard.TryTake("create", ip, l.DocumentsPerIpPerHour, TimeSpan.FromHours(1)))
                    return Message(429, "Too many new documents from your network this hour. Try again later.");

                var changed = p.Changes.Any(c => c.Delete > 0 || c.Insert.Length > 0);
                if (changed)
                {
                    var client = "a" + RandomNumberGenerator.GetString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 11);
                    var ops = new List<object[]>();
                    foreach (var c in p.Changes) ops.AddRange(s.Doc.Splice(c.Pos, c.Delete, c.Insert, client));
                    if (creating) s.CreatorIp = ip;
                    s.Dirty = true;
                    s.Touch();
                    // Under the lock, like DocHub.Submit: every client receives ops in the order they were applied.
                    await hub.Clients.Group(s.Id).SendAsync("ops", ops);
                }
                var text = s.Doc.Text();
                ctx.Response.Headers.ETag = Version(text);
                var message = created?.Invoke(s) ?? (changed ? p.Summary : "No change: the text was already like that.") + $" The document now has {Lines(text).Length} lines.";
                return Results.Text(message + "\n", "text/plain; charset=utf-8", statusCode: created != null ? 201 : 200);
            }
            finally { s.Lock.Release(); }
        }
    }

    async Task<string> Body(HttpContext ctx)
    {
        var max = Math.Max(1 << 20, limits.Current.MaxDocumentChars * 8L);
        if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } f) f.MaxRequestBodySize = max;
        try
        {
            using var reader = new StreamReader(ctx.Request.Body, Encoding.UTF8);
            return await reader.ReadToEndAsync();
        }
        catch (BadHttpRequestException) { throw new Refused(Message(413, "The request is too large.")); }
    }

    static List<(string Old, string New, bool All, bool Append)> ParseEdits(string body)
    {
        const string Usage = "Send JSON like {\"edits\":[{\"old\":\"exact text to replace\",\"new\":\"replacement\"}]}, or {\"edits\":[{\"append\":\"text to add at the end\"}]}.";
        JsonElement root;
        try { root = JsonDocument.Parse(body).RootElement; }
        catch (JsonException) { throw new Refused(Message(400, "The body isn't valid JSON. " + Usage)); }
        var items = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("edits", out var e) ? e : root;
        var list = items.ValueKind == JsonValueKind.Array ? items.EnumerateArray().ToList() : items.ValueKind == JsonValueKind.Object ? [items] : [];
        if (list.Count == 0) throw new Refused(Message(400, "No edits. " + Usage));
        var edits = new List<(string, string, bool, bool)>();
        foreach (var item in list)
        {
            string? Str(string name) => item.ValueKind == JsonValueKind.Object && item.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? Normalize(v.GetString()!) : null;
            if (Str("append") is { } append) { edits.Add(("", append, false, true)); continue; }
            if (Str("old") is not { Length: > 0 } old || Str("new") is not { } replacement)
                throw new Refused(Message(400, "Each edit needs a non-empty \"old\" and a \"new\" string (or \"append\"). " + Usage));
            var all = item.TryGetProperty("all", out var a) && a.ValueKind == JsonValueKind.True;
            edits.Add((old, replacement, all, false));
        }
        return edits;
    }

    // Only the part that differs, so other people's cursors and concurrent typing around it stay where they are.
    static Change Minimal(int at, string old, string replacement)
    {
        int prefix = 0, suffix = 0, max = Math.Min(old.Length, replacement.Length);
        while (prefix < max && old[prefix] == replacement[prefix]) prefix++;
        while (suffix < max - prefix && old[^(suffix + 1)] == replacement[^(suffix + 1)]) suffix++;
        return new Change(at + prefix, old.Length - prefix - suffix, replacement[prefix..^suffix]);
    }

    static List<int> Occurrences(string text, string find)
    {
        var at = new List<int>();
        for (var i = text.IndexOf(find, StringComparison.Ordinal); i >= 0; i = text.IndexOf(find, i + find.Length, StringComparison.Ordinal)) at.Add(i);
        return at;
    }

    static bool TryRange(string s, int total, out int from, out int to)
    {
        to = 0;
        var parts = s.Split('-', 2);
        if (!int.TryParse(parts[0], out from) || from < 1) return false;
        if (parts.Length == 1) to = from;
        else if (parts[1].Length == 0) to = total;
        else if (!int.TryParse(parts[1], out to)) return false;
        to = Math.Min(to, total);
        return from <= Math.Max(total, 1) && (to >= from || total == 0);
    }

    // Like a file: a final line break ends the last line rather than starting an empty one.
    static string[] Lines(string text) => text.Length == 0 ? [] : (text.EndsWith('\n') ? text[..^1] : text).Split('\n');
    static int LineOf(string text, int pos) => text.AsSpan(0, pos).Count('\n') + 1;
    static string Normalize(string s) => s.Replace("\r\n", "\n").Replace('\r', '\n');
    static string Capitalize(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];
    static string Version(string text) => "\"" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16] + "\"";
    static string Origin(HttpContext ctx) => $"{ctx.Request.Scheme}://{ctx.Request.Host}";
    static IResult Message(int status, string text) => Results.Text(text + "\n", "text/plain; charset=utf-8", statusCode: status);
    static IResult TooMany() => Message(429, "Too many requests from your network. Wait a minute and try again.");
    static IResult Deleted() => Message(410, "This document was deleted.");
}

public static class AgentEndpoints
{
    public static void MapAgentApi(this IEndpointRouteBuilder app)
    {
        app.MapPost("/new.md", (HttpContext ctx, AgentApi api) => api.Create(ctx));
        app.MapGet("/{id}.md", (string id, HttpContext ctx, AgentApi api) =>
            DocIds.EditId().IsMatch(id) ? api.Read(ctx, id, null) : Task.FromResult(Results.NotFound()));
        app.MapMethods("/{id}.md", ["PATCH"], (string id, HttpContext ctx, AgentApi api) =>
            DocIds.EditId().IsMatch(id) ? api.Patch(ctx, id) : Task.FromResult(Results.NotFound()));
        app.MapPut("/{id}.md", (string id, HttpContext ctx, AgentApi api) =>
            DocIds.EditId().IsMatch(id) ? api.Put(ctx, id) : Task.FromResult(Results.NotFound()));
        app.MapGet("/r/{readId}.md", (string readId, HttpContext ctx, AgentApi api) =>
            DocIds.ReadId().IsMatch(readId) ? api.Read(ctx, null, readId) : Task.FromResult(Results.NotFound()));
        app.MapMethods("/r/{readId}.md", ["PATCH", "PUT", "POST", "DELETE"], () =>
            Results.Text("This is a read-only link: it can't be changed. Only the edit link (without /r/) allows changes.\n", "text/plain; charset=utf-8", statusCode: 403));
    }
}
