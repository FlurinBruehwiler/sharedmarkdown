using System.Text.Json;
using System.Text.Json.Nodes;
using static SharedMarkdown.Rga.ApplyResult;

namespace SharedMarkdown.Tests;

public class RgaTests
{
    const int MaxLength = 50_000, MaxItems = 500_000;

    static JsonElement Json(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    static Rga.ApplyResult Apply(Rga rga, string ops, int maxLength = MaxLength, int maxItems = MaxItems) => rga.Apply(Json(ops), maxLength, maxItems);

    static Rga With(string text)
    {
        var rga = new Rga();
        Assert.Equal(Ok, Apply(rga, JsonSerializer.Serialize(new object[] { new object[] { "i", "a", 1, "", 0, text } })));
        return rga;
    }

    // Parity with src/client/src/rga.ts: fixtures/rga.json is made by src/client/test/make-rga-fixtures.ts.
    [Fact]
    public void ReplaysTypeScriptSessionsIdentically()
    {
        var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "rga.json")))!;
        var cases = fixture["cases"]!.AsArray();
        Assert.NotEmpty(cases);
        foreach (var c in cases)
        {
            var rga = new Rga();
            foreach (var batch in c!["batches"]!.AsArray())
                Assert.Equal(Ok, rga.Apply(Json(batch!.ToJsonString()), MaxLength, MaxItems));
            Assert.Equal((string)c["text"]!, rga.Text());
            Assert.True(JsonNode.DeepEquals(c["state"], JsonNode.Parse(rga.Encode())), "state differs from rga.ts");
            Assert.Equal(rga.Encode(), Rga.Decode(rga.Encode()).Encode());
        }
    }

    [Fact]
    public void RunInsertEqualsCharacterByCharacter()
    {
        var a = With("hello world");
        var b = With("hello world");
        Assert.Equal(Ok, Apply(a, """[["i","x",20,"a",5,"PASTED"]]"""));
        for (int j = 0; j < 6; j++)
            Assert.Equal(Ok, Apply(b, $"""[["i","x",{20 + j},"{(j == 0 ? "a" : "x")}",{(j == 0 ? 5 : 19 + j)},"{"PASTED"[j]}"]]"""));
        Assert.Equal("helloPASTED world", a.Text());
        Assert.Equal(a.Encode(), b.Encode());
        // A partial resend integrates only the missing characters.
        Assert.Equal(Ok, Apply(a, """[["i","x",20,"a",5,"PASTEDMORE"]]"""));
        Assert.Equal("helloPASTEDMORE world", a.Text());
    }

    [Fact]
    public void LongPasteIntoLongDocument()
    {
        var rga = With(new string('a', 40_000));
        Assert.Equal(Ok, Apply(rga, $"""[["i","b",100000,"a",20000,"{new string('b', 9_000)}"]]"""));
        Assert.Equal(49_000, rga.Length);
        Assert.Equal(new string('a', 20_000) + new string('b', 9_000) + new string('a', 20_000), rga.Text());
    }

    [Theory]
    [InlineData("""{"i":1}""")]
    [InlineData("""[1]""")]
    [InlineData("""[[]]""")]
    [InlineData("""[["x","a",1,"",0,"t"]]""")]
    [InlineData("""[["i","a",1,"",0]]""")]
    [InlineData("""[["i","a",1,"",0,"t",1]]""")]
    [InlineData("""[["i",null,1,"",0,"t"]]""")]
    [InlineData("""[["i","a","1","",0,"t"]]""")]
    [InlineData("""[["i","a",1.5,"",0,"t"]]""")]
    [InlineData("""[["i","a",1,"",0,5]]""")]
    [InlineData("""[["i","a",1,null,0,"t"]]""")]
    [InlineData("""[["i","a",1e30,"",0,"t"]]""")]
    [InlineData("""[["d","a",1]]""")]
    [InlineData("""[["d","a",1,"1"]]""")]
    [InlineData("""[["d","a",1,99999999999]]""")]
    [InlineData("""[[1,"a",1,1]]""")]
    [InlineData("""[["i","a",1,"",0,"\ud800"]]""")]
    public void RejectsMalformedOps(string ops)
    {
        var rga = With("abc");
        var before = rga.Encode();
        Assert.Equal(Invalid, Apply(rga, ops));
        Assert.Equal(before, rga.Encode());
    }

    [Theory]
    [InlineData("""[["i","b",5,"zz",1,"x"]]""")] // unknown origin
    [InlineData("""[["i","b",5,"a",9,"x"]]""")] // origin clock past the end
    [InlineData("""[["i","",5,"a",1,"x"]]""")] // empty client
    [InlineData("""[["i","123456789012345678901234567890123",5,"a",1,"x"]]""")] // client over 32 characters
    [InlineData("""[["i","b",0,"a",1,"x"]]""")] // clock 0
    [InlineData("""[["i","b",-3,"a",1,"x"]]""")]
    [InlineData("""[["d","a",1,0]]""")] // empty delete
    [InlineData("""[["d","a",0,1]]""")]
    public void RejectsInvalidOps(string ops)
    {
        var rga = With("abc");
        Assert.Equal(Invalid, Apply(rga, ops));
        Assert.Equal("abc", rga.Text());
    }

    // B4: one op with a clock beyond 2^53 would poison every JavaScript client's Lamport clock.
    [Fact]
    public void ClocksStayExactInJavaScript()
    {
        const long max = (1L << 53) - 1;
        Assert.Equal(Invalid, Apply(With("abc"), $"""[["i","b",{max - 2},"a",1,"xyz"]]"""));
        Assert.Equal(Invalid, Apply(With("abc"), $"""[["i","b",{max},"a",1,"x"]]"""));
        Assert.Equal(Invalid, Apply(With("abc"), $"""[["i","b",{long.MaxValue / 2},"a",1,"x"]]"""));
        Assert.Equal(Invalid, Apply(With("abc"), $"""[["d","b",{max - 1},2]]"""));
        Assert.Equal(Ok, Apply(With("abc"), $"""[["i","b",{max - 3},"a",1,"xyz"]]"""));
        Assert.Equal(Ok, Apply(With("abc"), $"""[["d","b",{max - 2},2]]"""));
    }

    [Fact]
    public void BatchesAreAtomic()
    {
        var rga = With("abc");
        Assert.Equal(Invalid, Apply(rga, """[["i","b",5,"a",3,"x"],["d","a",1,1],["i","b",9,"nope",1,"y"]]"""));
        Assert.Equal("abc", rga.Text());
        // Ops may build on earlier ops of the same batch.
        Assert.Equal(Ok, Apply(rga, """[["i","b",5,"a",3,"x"],["i","b",6,"b",5,"y"],["d","b",5,1]]"""));
        Assert.Equal("abcy", rga.Text());
    }

    [Fact]
    public void EnforcesSizeLimits()
    {
        var rga = With("abcde");
        Assert.Equal(TooLarge, Apply(rga, """[["i","b",9,"a",5,"xyz"]]""", maxLength: 7));
        Assert.Equal(TooLarge, Apply(rga, """[["i","b",9,"a",5,"xyz"]]""", maxItems: 7));
        Assert.Equal("abcde", rga.Text());
        // Deleting is always allowed, even when the document is over the limit.
        Assert.Equal(Ok, Apply(rga, """[["d","a",1,2]]""", maxLength: 3));
        Assert.Equal("cde", rga.Text());
        // Resending characters that are already there doesn't count as growth.
        Assert.Equal(Ok, Apply(rga, """[["i","a",1,"",0,"abcde"]]""", maxLength: 3, maxItems: 5));
    }

    // B5: deleting what isn't there (e.g. a tombstone dropped by compaction) is a no-op.
    [Fact]
    public void DeleteOfUnknownIdIsNoOp()
    {
        var rga = With("abc");
        Assert.Equal(Ok, Apply(rga, """[["d","zz",1,5],["d","a",2,1]]"""));
        Assert.Equal("ac", rga.Text());
    }

    [Fact]
    public void CompactKeepsIdsOfVisibleCharacters()
    {
        var rga = With("abcdef");
        Assert.Equal(Ok, Apply(rga, """[["d","a",2,3]]"""));
        Assert.Equal(3, rga.Tombstones);
        rga.Compact();
        Assert.Equal(0, rga.Tombstones);
        Assert.Equal(3, rga.Items);
        Assert.Equal("aef", rga.Text());
        Assert.Equal("""[["a",1,"a",0],["a",5,"ef",0]]""", rga.Encode());
        // Inserting after a kept character still works; after a dropped tombstone it doesn't.
        Assert.Equal(Ok, Apply(rga, """[["i","b",10,"a",5,"X"]]"""));
        Assert.Equal(Invalid, Apply(rga, """[["i","b",11,"a",3,"Y"]]"""));
        Assert.Equal(Ok, Apply(rga, """[["d","a",3,1]]"""));
        Assert.Equal("aeXf", rga.Text());
    }

    [Fact]
    public void ConcurrentInsertsOrderByDescendingId()
    {
        var rga = With("ab");
        // Both go after "a"; the higher id comes first, ties broken by ordinal client comparison ("B" < "b").
        Assert.Equal(Ok, Apply(rga, """[["i","b",5,"a",1,"1"],["i","B",5,"a",1,"2"],["i","c",6,"a",1,"3"]]"""));
        Assert.Equal("a312b", rga.Text());
    }
}
