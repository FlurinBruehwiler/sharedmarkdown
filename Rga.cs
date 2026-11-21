using System.Text;
using System.Text.Json;

namespace SharedMarkdown;

/// RGA (Replicated Growable Array) sequence CRDT, Roh et al. 2011. Mirrored in client/src/rga.js;
/// both must integrate operations identically.
///
/// Every character is an item with a unique id (client, clock) where clock is a Lamport timestamp.
/// Inserts name the item they go after (their origin); deletes only set a tombstone.
/// Concurrent inserts after the same origin are ordered by descending id, which makes
/// every replica converge regardless of the order ops arrive in.
///
/// Wire format (JSON arrays, runs to keep messages small):
///   insert: ["i", client, clock, originClient, originClock, text]  // text[j] gets id (client, clock+j), origin = previous char
///   delete: ["d", client, clock, count]                             // tombstones (client, clock .. clock+count-1)
///   state:  [[client, clock, text, deleted], ...]                   // runs of items in document order
// Tombstones are dropped by Compacted() when a document is loaded with many of them (see DocStore).
// TODO: use a tree/rope instead of a list if documents get much larger than the size limit.
public class Rga
{
    public record struct Id(string Client, long Clock);

    class Item(Id id, char ch)
    {
        public readonly Id Id = id;
        public readonly char Ch = ch;
        public bool Deleted;
    }

    readonly List<Item> _items = [];
    readonly Dictionary<Id, Item> _byId = [];

    public int Length { get; private set; }

    /// Stored items including deleted ones.
    public int Items => _items.Count;

    /// A fresh replica holding just `text`, with no tombstones. The ids come from a new random
    /// client name, so they can never collide with ids clients still hold from before.
    public static Rga Compacted(string text)
    {
        var rga = new Rga();
        var client = "~" + Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(6));
        for (int i = 0; i < text.Length; i++)
        {
            var item = new Item(new Id(client, i + 1), text[i]);
            rga._items.Add(item);
            rga._byId[item.Id] = item;
        }
        rga.Length = text.Length;
        return rga;
    }

    static bool Greater(Id a, Id b) => a.Clock != b.Clock ? a.Clock > b.Clock : string.CompareOrdinal(a.Client, b.Client) > 0;

    void InsertOne(Id id, Id? origin, char ch)
    {
        if (_byId.ContainsKey(id)) return; // already integrated
        int idx = origin is { } o ? _items.IndexOf(_byId[o]) + 1 : 0;
        while (idx < _items.Count && Greater(_items[idx].Id, id)) idx++;
        var item = new Item(id, ch);
        _items.Insert(idx, item);
        _byId[id] = item;
        Length++;
    }

    /// Applies a batch of ops atomically. Returns false (and changes nothing) if an op is malformed,
    /// references an unknown item, or would grow the document past maxLength.
    public ApplyResult Apply(JsonElement ops, int maxLength, int maxItems)
    {
        try
        {
            var r = Validate(ops, maxLength, maxItems);
            if (r != ApplyResult.Ok) return r;
        }
        catch (Exception e) when (e is InvalidOperationException or FormatException or IndexOutOfRangeException or KeyNotFoundException) { return ApplyResult.Invalid; }
        Integrate(ops);
        return ApplyResult.Ok;
    }

    public enum ApplyResult { Ok, Invalid, TooLarge }

    ApplyResult Validate(JsonElement ops, int maxLength, int maxItems)
    {
        if (ops.ValueKind != JsonValueKind.Array) return ApplyResult.Invalid;
        var added = new HashSet<Id>();
        bool Known(Id id) => _byId.ContainsKey(id) || added.Contains(id);
        long grow = 0;
        foreach (var op in ops.EnumerateArray())
        {
            if (op.ValueKind != JsonValueKind.Array || op.GetArrayLength() < 4) return ApplyResult.Invalid;
            switch (op[0].GetString())
            {
                case "i" when op.GetArrayLength() == 6:
                {
                    var client = op[1].GetString() ?? "";
                    var clock = op[2].GetInt64();
                    var oc = op[3].GetString() ?? "";
                    var text = op[5].GetString() ?? "";
                    if (client == "" || client.Length > 32 || clock < 1 || clock > long.MaxValue / 2) return ApplyResult.Invalid;
                    if (oc != "" && !Known(new Id(oc, op[4].GetInt64()))) return ApplyResult.Invalid;
                    for (int j = 0; j < text.Length; j++) added.Add(new Id(client, clock + j));
                    grow += text.Length;
                    break;
                }
                case "d":
                {
                    var client = op[1].GetString() ?? "";
                    var clock = op[2].GetInt64();
                    var count = op[3].GetInt32();
                    if (count < 1 || count > maxLength) return ApplyResult.Invalid;
                    for (int j = 0; j < count; j++)
                        if (!Known(new Id(client, clock + j))) return ApplyResult.Invalid;
                    break;
                }
                default:
                    return ApplyResult.Invalid;
            }
        }
        // Pure deletions are always allowed, so an oversized document can still be trimmed.
        if (grow > 0 && (Length + grow > maxLength || _items.Count + grow > maxItems)) return ApplyResult.TooLarge;
        return ApplyResult.Ok;
    }

    void Integrate(JsonElement ops)
    {
        foreach (var op in ops.EnumerateArray())
        {
            switch (op[0].GetString())
            {
                case "i" when op.GetArrayLength() == 6:
                {
                    var client = op[1].GetString() ?? "";
                    var clock = op[2].GetInt64();
                    var oc = op[3].GetString() ?? "";
                    Id? origin = oc == "" ? null : new Id(oc, op[4].GetInt64());
                    var text = op[5].GetString() ?? "";
                    for (int j = 0; j < text.Length; j++)
                    {
                        var id = new Id(client, clock + j);
                        InsertOne(id, origin, text[j]);
                        origin = id;
                    }
                    break;
                }
                case "d":
                {
                    var client = op[1].GetString() ?? "";
                    var clock = op[2].GetInt64();
                    var count = op[3].GetInt32();
                    for (int j = 0; j < count; j++)
                    {
                        var item = _byId[new Id(client, clock + j)];
                        if (!item.Deleted) { item.Deleted = true; Length--; }
                    }
                    break;
                }
            }
        }
    }

    public string Text()
    {
        var sb = new StringBuilder(Length);
        foreach (var it in _items) if (!it.Deleted) sb.Append(it.Ch);
        return sb.ToString();
    }

    /// Run-length encoded state in document order, see the class comment.
    public string Encode()
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartArray();
            var sb = new StringBuilder();
            for (int i = 0; i < _items.Count;)
            {
                var first = _items[i];
                sb.Clear().Append(first.Ch);
                int j = i + 1;
                while (j < _items.Count && _items[j].Id.Client == first.Id.Client
                       && _items[j].Id.Clock == first.Id.Clock + (j - i) && _items[j].Deleted == first.Deleted)
                    sb.Append(_items[j++].Ch);
                w.WriteStartArray();
                w.WriteStringValue(first.Id.Client);
                w.WriteNumberValue(first.Id.Clock);
                w.WriteStringValue(sb.ToString());
                w.WriteNumberValue(first.Deleted ? 1 : 0);
                w.WriteEndArray();
                i = j;
            }
            w.WriteEndArray();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    public static Rga Decode(string json)
    {
        var rga = new Rga();
        if (string.IsNullOrEmpty(json)) return rga;
        using var doc = JsonDocument.Parse(json);
        foreach (var run in doc.RootElement.EnumerateArray())
        {
            var client = run[0].GetString()!;
            var clock = run[1].GetInt64();
            var text = run[2].GetString()!;
            var deleted = run[3].GetInt32() == 1;
            for (int j = 0; j < text.Length; j++)
            {
                var item = new Item(new Id(client, clock + j), text[j]) { Deleted = deleted };
                rga._items.Add(item);
                rga._byId[item.Id] = item;
                if (!deleted) rga.Length++;
            }
        }
        return rga;
    }
}
