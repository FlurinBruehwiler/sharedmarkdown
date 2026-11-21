using System.Text.Json;

namespace SharedMarkdown;

// Wire contract with src/client (hub.ts, sync.ts): keep these strings exactly as they are.

public static class HubErrors
{
    public const string BadId = "bad id";
    public const string Rate = "rate";
    public const string NotFound = "not found";
    public const string Deleted = "deleted";
    public const string Invalid = "invalid";
    public const string Create = "create";
}

public static class SubmitStatus
{
    public const string Ok = "ok";
    public const string Invalid = "invalid";
    public const string Size = "size";
    public const string Create = "create";
    public const string Rate = "rate";
    public const string ReadOnly = "readonly";
    public const string Deleted = "deleted";
}

public sealed record JoinResult(JsonElement State, int MaxChars, int MaxImageDimension);
