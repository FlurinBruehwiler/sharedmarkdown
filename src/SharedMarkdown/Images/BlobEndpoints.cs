using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;

namespace SharedMarkdown;

public static class BlobEndpoints
{
    public static void MapBlobs(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/blobs", async (HttpContext ctx, ImageService images, IpGuard guard, LimitsService limits) =>
        {
            var ip = IpGuard.IpOf(ctx);
            var l = limits.Current;
            var mb = $"{l.MaxUploadBytes / 1024.0 / 1024:0.#} MB";
            if (guard.IsBlocked(ip)) return Results.Text("Uploads are blocked.", statusCode: 403);
            if (ctx.Request.ContentLength > l.MaxUploadBytes) return Results.Text($"Images can be at most {mb}.", statusCode: 413);
            if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } body) body.MaxRequestBodySize = l.MaxUploadBytes;
            if (!guard.TryTake("upload", ip, l.UploadsPerIpPerHour, TimeSpan.FromHours(1)))
                return Results.Text("Too many uploads, please try again later.", statusCode: 429);

            byte[] input;
            try
            {
                using var ms = new MemoryStream();
                await ctx.Request.Body.CopyToAsync(ms);
                input = ms.ToArray();
            }
            catch (BadHttpRequestException) { return Results.Text($"Images can be at most {mb}.", statusCode: 413); }
            if (input.Length == 0) return Results.Text("Empty upload.", statusCode: 400);
            if (input.Length > l.MaxUploadBytes) return Results.Text($"Images can be at most {mb}.", statusCode: 413);

            return await images.Store(input, ctx.Request.ContentType, l.MaxImageDimension, ip) is { } id
                ? Results.Ok(new { url = $"/b/{id}" })
                : Results.Text("This file isn't a supported image (PNG, JPEG, GIF or WebP).", statusCode: 400);
        });

        app.MapGet("/b/{id}", async (string id, HttpContext ctx, AppDb db) =>
        {
            var blob = await db.Blobs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == id);
            if (blob is null) return Results.NotFound();
            ctx.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
            ctx.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
            return Results.File(blob.Data, blob.ContentType);
        });
    }
}
