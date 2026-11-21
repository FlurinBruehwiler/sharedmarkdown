using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

public class Document
{
    public required string Id { get; set; }
    /// Serialized RGA state (see Rga.Encode), the source of truth.
    public string State { get; set; } = "";
    /// Plain markdown derived from State, kept for titles, search and export.
    public string Content { get; set; } = "";
    public string Title { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class Blob
{
    // SHA-256 of the content (hex), so identical uploads are stored once.
    public required string Id { get; set; }
    public required string ContentType { get; set; }
    public required byte[] Data { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class AppDb(DbContextOptions<AppDb> options) : DbContext(options)
{
    public DbSet<Document> Documents => Set<Document>();
    public DbSet<Blob> Blobs => Set<Blob>();
}
