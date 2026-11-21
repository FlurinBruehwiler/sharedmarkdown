using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

/// Validates, re-encodes and stores uploaded images.
public class ImageService(IServiceScopeFactory scopes, ILogger<ImageService> log)
{
    /// Image decoding is CPU heavy; don't let a burst of uploads take every core.
    readonly SemaphoreSlim _slots = new(Math.Max(1, Environment.ProcessorCount / 2));

    /// Processes and stores the image; returns its id, or null if it isn't a supported image.
    public async Task<string?> Store(byte[] input, string? contentType, int maxDimension, string uploaderIp)
    {
        ProcessedImage? image;
        var started = Stopwatch.GetTimestamp();
        await _slots.WaitAsync();
        try { image = await Task.Run(() => ImageProcessor.Process(input, maxDimension)); }
        finally { _slots.Release(); }
        if (image is null) return null;
        log.LogInformation("Image {In} bytes {InType} -> {Out} bytes {OutType} {W}x{H} in {Ms:0} ms", input.Length, contentType, image.Data.Length, image.ContentType, image.Width, image.Height,
            Stopwatch.GetElapsedTime(started).TotalMilliseconds);

        var id = Convert.ToHexStringLower(SHA256.HashData(image.Data))[..32];
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDb>();
        // Ids are content hashes: the same image uploaded twice (even at the same moment) is stored once.
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT OR IGNORE INTO Blobs (Id, ContentType, Data, Width, Height, UploaderIp, CreatedAt)
            VALUES ({id}, {image.ContentType}, {image.Data}, {image.Width}, {image.Height}, {uploaderIp}, {DateTime.UtcNow})
            """);
        return id;
    }
}
