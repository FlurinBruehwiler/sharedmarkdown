using SkiaSharp;

namespace SharedMarkdown;

public record ProcessedImage(byte[] Data, string ContentType, int Width, int Height);

public static class ImageProcessor
{
    const long MaxPixels = 50_000_000; // refuses decompression bombs before decoding

    public static ProcessedImage? Process(byte[] input, int maxDimension)
    {
        using var data = SKData.CreateCopy(input);
        using var codec = SKCodec.Create(data);
        if (codec is null) return null;
        var info = codec.Info;
        if (info.Width <= 0 || info.Height <= 0 || (long)info.Width * info.Height > MaxPixels) return null;

        // Re-encoding drops all metadata (EXIF GPS etc.). Skia can't encode GIF, but GIF carries no EXIF.
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
            // Browsers paste copied photos as PNG, ~10x larger than JPEG.
            var photoAsPng = codec.EncodedFormat == SKEncodedImageFormat.Png
                && (double)input.Length / ((long)info.Width * info.Height) > 1.0
                && IsOpaque(bitmap);
            var (format, type, quality) = codec.EncodedFormat switch
            {
                SKEncodedImageFormat.Webp => (SKEncodedImageFormat.Webp, "image/webp", 85),
                SKEncodedImageFormat.Png when !photoAsPng => (SKEncodedImageFormat.Png, "image/png", 100),
                _ => (SKEncodedImageFormat.Jpeg, "image/jpeg", 85),
            };
            using var image = SKImage.FromBitmap(bitmap);
            using var encoded = image.Encode(format, quality);
            if (encoded is null) return null;
            return new ProcessedImage(encoded.ToArray(), type, bitmap.Width, bitmap.Height);
        }
        finally { scaled?.Dispose(); }
    }

    static bool IsOpaque(SKBitmap bitmap)
    {
        if (bitmap.AlphaType == SKAlphaType.Opaque) return true;
        if (bitmap.ColorType is not (SKColorType.Rgba8888 or SKColorType.Bgra8888)) return false;
        var pixels = bitmap.GetPixelSpan();
        for (int i = 3; i < pixels.Length; i += 4)
            if (pixels[i] != 255) return false;
        return true;
    }

    static SKBitmap ApplyOrientation(SKBitmap src, SKEncodedOrigin origin)
    {
        float w = src.Width, h = src.Height;
        // x' = a*x + b*y + c, y' = d*x + e*y + f
        (float a, float b, float c, float d, float e, float f)? m = origin switch
        {
            SKEncodedOrigin.TopRight => (-1, 0, w, 0, 1, 0),
            SKEncodedOrigin.BottomRight => (-1, 0, w, 0, -1, h),
            SKEncodedOrigin.BottomLeft => (1, 0, 0, 0, -1, h),
            SKEncodedOrigin.LeftTop => (0, 1, 0, 1, 0, 0),
            SKEncodedOrigin.RightTop => (0, -1, h, 1, 0, 0),
            SKEncodedOrigin.RightBottom => (0, -1, h, -1, 0, w),
            SKEncodedOrigin.LeftBottom => (0, 1, 0, -1, 0, w),
            _ => null,
        };
        if (m is not { } t) return src.Copy();
        var swap = t.a == 0;
        var dst = new SKBitmap(new SKImageInfo(swap ? src.Height : src.Width, swap ? src.Width : src.Height, src.ColorType, src.AlphaType));
        using var canvas = new SKCanvas(dst);
        canvas.SetMatrix(new SKMatrix(t.a, t.b, t.c, t.d, t.e, t.f, 0, 0, 1));
        using var image = SKImage.FromBitmap(src);
        canvas.DrawImage(image, 0, 0, new SKSamplingOptions(SKFilterMode.Nearest));

        return dst;
    }
}
