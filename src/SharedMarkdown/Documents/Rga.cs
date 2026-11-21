using System.Text;
using System.Text.Json;

namespace SharedMarkdown;

// RGA sequence CRDT (Roh et al. 2011). Must integrate ops exactly like src/client/src/rga.ts (RgaTests replays its sessions).
// Ids are (client, Lamport clock); concurrent inserts after the same origin are ordered by descending id, so replicas converge.
// Wire format: insert ["i", client, clock, originClient, originClock, text] (text[j] gets clock+j, after text[j-1]);
// delete ["d", client, clock, count]; state [[client, clock, text, deleted], ...] in document order.
// Deleting an unknown id is a no-op (maybe a compacted tombstone); inserting after an unknown origin is invalid.
// TODO: use a tree/rope instead of a list if documents get much larger than the size limit.
public class Rga
{
    public record struct Id(string Client, long Clock);

    public const long MaxClock = (1L << 53) - 1; // Number.MAX_SAFE_INTEGER: a larger clock would poison JS clients

    internal abstract record Op;
    internal sealed record Ins(Id Id, Id? Origin, string Text) : Op;
    internal sealed record Del(Id Id, int Count) : Op;

    public sealed class Batch
    {
        internal Batch(List<Op> ops, long grow) { Ops = ops; Grow = grow; }
        internal readonly List<Op> Ops;
        public long Grow { get; }
    }

    class Item(Id id, char ch)
    {
        public readonly Id Id = id;
        public readonly char Ch = ch;
        public bool Deleted;
    }

    readonly List<Item> _items = [];
    readonly Dictionary<Id, Item> _byId = [];

    public int Length { get; private set; }

    public int Items => _items.Count;

    public int Tombstones => _items.Count - Length;

    // Keeps visible ids so offline clients can still insert after them; only safe while nobody has the document open.
    public void Compact()
    {
        _items.RemoveAll(it => it.Deleted);
        _byId.Clear();
        foreach (var it in _items) _byId[it.Id] = it;
    }

    static bool Greater(Id a, Id b) => a.Clock != b.Clock ? a.Clock > b.Clock : string.CompareOrdinal(a.Client, b.Client) > 0;

    int After(Id? origin, int hint)
    {
        if (origin is not { } o) return 0;
        var item = _byId[o];
        return (hint >= 0 && hint < _items.Count && _items[hint] == item ? hint : _items.IndexOf(item)) + 1;
    }

    void InsertRun(Id first, Id? origin, string text)
    {
        int hint = -1;
        for (int j = 0; j < text.Length;)
        {
            var id = first with { Clock = first.Clock + j };
            if (_byId.ContainsKey(id)) { origin = id; hint = -1; j++; continue; }
            int idx = After(origin, hint);
            while (idx < _items.Count && Greater(_items[idx].Id, id)) idx++;
            Id? next = idx < _items.Count ? _items[idx].Id : null;
            int end = j + 1;
            while (end < text.Length)
            {
                var nid = first with { Clock = first.Clock + end };
                if (_byId.ContainsKey(nid) || next is { } n && Greater(n, nid)) break;
                end++;
            }
            var run = new Item[end - j];
            for (int k = 0; k < run.Length; k++)
            {
                run[k] = new Item(first with { Clock = first.Clock + j + k }, text[j + k]);
                _byId[run[k].Id] = run[k];
            }
            _items.InsertRange(idx, run);
            Length += run.Length;
            origin = run[^1].Id;
            hint = idx + run.Length - 1;
            j = end;
        }
    }

    public enum ApplyResult { Ok, Invalid, TooLarge }

    public ApplyResult Apply(JsonElement ops, int maxLength, int maxItems)
    {
        var r = Check(ops, maxLength, maxItems, out var batch);
        if (r == ApplyResult.Ok) Apply(batch!);
        return r;
    }

    public ApplyResult Check(JsonElement ops, int maxLength, int maxItems, out Batch? batch)
    {
        batch = null;
        if (Parse(ops) is not { } list) return ApplyResult.Invalid;
        var added = new HashSet<Id>();
        bool Known(Id id) => _byId.ContainsKey(id) || added.Contains(id);
        long grow = 0;
        foreach (var op in list)
        {
            switch (op)
            {
                case Ins ins:
                    if (ins.Id.Client.Length is 0 or > 32 || ins.Id.Clock < 1 || ins.Id.Clock > MaxClock - ins.Text.Length) return ApplyResult.Invalid;
                    if (ins.Origin is { } o && !Known(o)) return ApplyResult.Invalid;
                    for (int j = 0; j < ins.Text.Length; j++)
                        if (!Known(ins.Id with { Clock = ins.Id.Clock + j }))
                        {
                            added.Add(ins.Id with { Clock = ins.Id.Clock + j });
                            grow++;
                        }
                    break;
                case Del del:
                    if (del.Count < 1 || del.Count > maxLength || del.Id.Clock < 1 || del.Id.Clock > MaxClock - del.Count) return ApplyResult.Invalid;
                    break;
            }
        }
        // Pure deletions are always allowed, so an oversized document can still be trimmed.
        if (grow > 0 && (Length + grow > maxLength || _items.Count + grow > maxItems)) return ApplyResult.TooLarge;
        batch = new Batch(list, grow);
        return ApplyResult.Ok;
    }

    public void Apply(Batch batch)
    {
        foreach (var op in batch.Ops)
        {
            switch (op)
            {
                case Ins ins:
                    InsertRun(ins.Id, ins.Origin, ins.Text);
                    break;
                case Del del:
                    for (int j = 0; j < del.Count; j++)
                        if (_byId.TryGetValue(del.Id with { Clock = del.Id.Clock + j }, out var item) && !item.Deleted)
                        {
                            item.Deleted = true;
                            Length--;
                        }
                    break;
            }
        }
    }

    static List<Op>? Parse(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Array) return null;
        var list = new List<Op>(json.GetArrayLength());
        try
        {
            foreach (var op in json.EnumerateArray())
            {
                if (op.ValueKind != JsonValueKind.Array || op.GetArrayLength() < 1 || op[0].ValueKind != JsonValueKind.String) return null;
                switch (op[0].GetString())
                {
                    case "i" when op.GetArrayLength() == 6:
                    {
                        if (Str(op[1]) is not { } client || Int(op[2]) is not { } clock || Str(op[3]) is not { } oc
                            || Int(op[4]) is not { } ok || Str(op[5]) is not { } text) return null;
                        list.Add(new Ins(new Id(client, clock), oc == "" ? null : new Id(oc, ok), text));
                        break;
                    }
                    case "d" when op.GetArrayLength() == 4:
                    {
                        if (Str(op[1]) is not { } client || Int(op[2]) is not { } clock || Int(op[3]) is not { } count
                            || count > int.MaxValue) return null;
                        list.Add(new Del(new Id(client, clock), (int)count));
                        break;
                    }
                    default:
                        return null;
                }
            }
        }
        catch (InvalidOperationException) { return null; }
        return list;

        static string? Str(JsonElement e) => e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        static long? Int(JsonElement e) => e.ValueKind == JsonValueKind.Number && e.TryGetInt64(out var v) ? v : null;
    }

    public string Text()
    {
        var sb = new StringBuilder(Length);
        foreach (var it in _items) if (!it.Deleted) sb.Append(it.Ch);
        return sb.ToString();
    }

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
