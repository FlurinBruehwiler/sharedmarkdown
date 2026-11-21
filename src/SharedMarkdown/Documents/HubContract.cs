using System.Text.Json;

namespace SharedMarkdown;

// The wire contract with the client (src/client/src/hub.ts, sync.ts). Keep these strings exactly as they are.

/// Messages of the HubException thrown by DocHub.Join, JoinRead and ReadLink.
public static class HubErrors
{
    /// The id doesn't have the shape of a document (or read) id.
    public const string BadId = "bad id";
    /// Too many joins from this IP.
    public const string Rate = "rate";
    /// No document has this read id.
    public const string NotFound = "not found";
    /// The admin deleted the document; drop any local copy.
    public const string Deleted = "deleted";
    /// The call doesn't fit the connection's state (not joined to that document, read-only, ...).
    public const string Invalid = "invalid";
    /// ReadLink on a new document, but this IP created too many documents.
    public const string Create = "create";
}

/// Results of DocHub.Submit.
public static class SubmitStatus
{
    public const string Ok = "ok";
    /// Malformed ops, ops for a document this connection didn't join, or an insert after an unknown character.
    public const string Invalid = "invalid";
    /// The document would get too long.
    public const string Size = "size";
    /// The batch would create a new document, but this IP created too many.
    public const string Create = "create";
    /// Too many batches from this IP.
    public const string Rate = "rate";
    /// Joined through a read-only link.
    public const string ReadOnly = "readonly";
    /// The admin deleted the document; drop any local copy.
    public const string Deleted = "deleted";
}

/// What Join and JoinRead return (serialized camelCase: state, maxChars, maxImageDimension).
/// State is the document as Rga.Encode runs.
public sealed record JoinResult(JsonElement State, int MaxChars, int MaxImageDimension);
