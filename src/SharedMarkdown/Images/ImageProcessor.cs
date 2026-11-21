using SkiaSharp;

namespace SharedMarkdown;

public record ProcessedImage(byte[] Data, string ContentType, int Width, int Height);

/// Validates uploads by actually decoding them, scales large images down and re-encodes them.
/// Re-encoding drops all metadata (EXIF GPS position, camera serials, ...), which matters
/// because documents are shared by link.
public static class ImageProcessor
{
    const long MaxPixels = 50_000_000; // refuse decompression bombs before decoding

    public static ProcessedImage? Process(byte[] input, int maxDimension)
    {
        using var data = SKData.CreateCopy(input);
        using var codec = SKCodec.Create(data);
        if (codec is null) return null;
        var info = codec.Info;
        if (info.Width <= 0 || info.Height <= 0 || (long)info.Width * info.Height > MaxPixels) return null;

        // Animated GIFs can't be re-encoded by Skia; keep them as they are (GIF has no EXIF),
        // the upload size limit still applies.
        if (codec.EncodedFormat == SKEncodedImageFormat.Gif)
            return new ProcessedImage(input, "image/gif", info.Width, info.Height);

        using var decoded = SKBitmap.Decode(codec);
        if (decoded is null) return null;
        using var oriented = ApplyOrientation(decoded, codec.EncodedOrigin);

        var bitmap = oriented;
        SKBitmap? scaled = null;
        var longest = Math.Max(bitmap.Width, bitmap.Height);
        if (longest > maxDimension)
        {
            var f = (double)maxDimension / longest;
            var size = new SKImageInfo(Math.Max(1, (int)Math.Round(bitmap.Width * f)), Math.Max(1, (int)Math.Round(bitmap.Height * f)), bitmap.ColorType, bitmap.AlphaType);
            scaled = bitmap.Resize(size, new SKSamplingOptions(SKCubicResampler.Mitchell));
            if (scaled is null) return null;
            bitmap = scaled;
        }

        try
        {
            // PNG and WebP keep their format (transparency, screenshots); everything else becomes JPEG.
            var (format, type, quality) = codec.EncodedFormat switch
            {
                SKEncodedImageFormat.Webp => (SKEncodedImageFormat.Webp, "image/webp", 85),
                SKEncodedImageFormat.Png => (SKEncodedImageFormat.Png, "image/png", 100),
                _ => (SKEncodedImageFormat.Jpeg, "image/jpeg", 85),
            };
            using var image = SKImage.FromBitmap(bitmap);
            using var encoded = image.Encode(format, quality);
            if (encoded is null) return null;
            return new ProcessedImage(encoded.ToArray(), type, bitmap.Width, bitmap.Height);
        }
        finally { scaled?.Dispose(); }
    }

    /// Bakes the EXIF rotation into the pixels, since the EXIF data itself is dropped.
    /// Each case maps source (x, y) to destination (x', y'): x' = a*x + b*y + c, y' = d*x + e*y + f.
    static SKBitmap ApplyOrientation(SKBitmap src, SKEncodedOrigin origin)
    {
        float w = src.Width, h = src.Height;
        (float a, float b, float c, float d, float e, float f)? m = origin switch
        {
            SKEncodedOrigin.TopRight => (-1, 0, w, 0, 1, 0),     // mirrored
            SKEncodedOrigin.BottomRight => (-1, 0, w, 0, -1, h), // rotated 180
            SKEncodedOrigin.BottomLeft => (1, 0, 0, 0, -1, h),   // flipped vertically
            SKEncodedOrigin.LeftTop => (0, 1, 0, 1, 0, 0),       // transposed
            SKEncodedOrigin.RightTop => (0, -1, h, 1, 0, 0),     // rotated 90 clockwise
            SKEncodedOrigin.RightBottom => (0, -1, h, -1, 0, w), // transverse
            SKEncodedOrigin.LeftBottom => (0, 1, 0, -1, 0, w),   // rotated 90 counter-clockwise
            _ => null,
        };
        if (m is not { } t) return src.Copy();
        var swap = t.a == 0;
        var dst = new SKBitmap(new SKImageInfo(swap ? src.Height : src.Width, swap ? src.Width : src.Height, src.ColorType, src.AlphaType));
        using var canvas = new SKCanvas(dst);
        canvas.SetMatrix(new SKMatrix(t.a, t.b, t.c, t.d, t.e, t.f, 0, 0, 1));
        using var image = SKImage.FromBitmap(src);
        canvas.DrawImage(image, 0, 0, new SKSamplingOptions(SKFilterMode.Nearest)); // exact 90° steps: no resampling

        return dst;
    }
}
