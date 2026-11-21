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
    /// IP that created the document, for abuse handling.
    public string CreatorIp { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class Blob
{
    // SHA-256 of the stored content (hex), so identical uploads are stored once.
    public required string Id { get; set; }
    public required string ContentType { get; set; }
    public required byte[] Data { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public string UploaderIp { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

public class BlockedIp
{
    public required string Ip { get; set; }
    public string Reason { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

/// Small key/value store for settings changed in the admin dashboard.
public class AppSetting
{
    public required string Key { get; set; }
    public string Value { get; set; } = "";
}

public class AppDb(DbContextOptions<AppDb> options) : DbContext(options)
{
    public DbSet<Document> Documents => Set<Document>();
    public DbSet<Blob> Blobs => Set<Blob>();
    public DbSet<BlockedIp> BlockedIps => Set<BlockedIp>();
    public DbSet<AppSetting> Settings => Set<AppSetting>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Document>().HasIndex(d => d.CreatedAt);
        b.Entity<Document>().HasIndex(d => d.CreatorIp);
        b.Entity<Document>().HasIndex(d => d.UpdatedAt);
        b.Entity<Blob>().HasIndex(x => x.CreatedAt);
        b.Entity<Blob>().HasIndex(x => x.UploaderIp);
        b.Entity<BlockedIp>().HasKey(x => x.Ip);
        b.Entity<AppSetting>().HasKey(x => x.Key);
    }
}
