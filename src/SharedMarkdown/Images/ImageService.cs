using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

public class ImageService(IServiceScopeFactory scopes, ILogger<ImageService> log)
{
    readonly SemaphoreSlim _slots = new(Math.Max(1, Environment.ProcessorCount / 2));

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
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT OR IGNORE INTO Blobs (Id, ContentType, Data, Width, Height, UploaderIp, CreatedAt)
            VALUES ({id}, {image.ContentType}, {image.Data}, {image.Width}, {image.Height}, {uploaderIp}, {DateTime.UtcNow})
            """);
        return id;
    }
}
