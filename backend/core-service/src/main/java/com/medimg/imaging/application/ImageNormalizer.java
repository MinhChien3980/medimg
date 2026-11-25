package com.medimg.imaging.application;

import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Iterator;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;

/**
 * Validates and normalises a 2D image upload. Pure function (no I/O besides in-memory codecs) so it is unit-testable.
 * <ul>
 *   <li>file type from magic bytes, never from the extension</li>
 *   <li>at most {@value #MAX_PIXELS} pixels, checked from the header before decoding</li>
 *   <li>re-encoded as grayscale PNG → every EXIF/XMP/text chunk is dropped (de-identification)</li>
 *   <li>16-bit grayscale PNGs keep their bit depth</li>
 * </ul>
 */
public final class ImageNormalizer {

    public enum FileType { PNG, JPEG, DICOM, NIFTI, ZIP, UNKNOWN }

    public record Normalized(byte[] png, byte[] thumbnailPng, int width, int height, String sha256Original, FileType sourceType) {
    }

    public static class InvalidImageException extends RuntimeException {
        public InvalidImageException(String message) {
            super(message);
        }
    }

    static final int THUMB_SIZE = 256;

    /** Larger images are rejected: decoding one would need hundreds of MB of heap. */
    static final long MAX_PIXELS = 50_000_000L;

    private ImageNormalizer() {
    }

    public static FileType detect(byte[] b) {
        if (b.length >= 8 && (b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') {
            return FileType.PNG;
        }
        if (b.length >= 3 && (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF) {
            return FileType.JPEG;
        }
        if (b.length >= 132 && b[128] == 'D' && b[129] == 'I' && b[130] == 'C' && b[131] == 'M') {
            return FileType.DICOM;
        }
        if (b.length >= 4 && b[0] == 'P' && b[1] == 'K' && b[2] == 3 && b[3] == 4) {
            return FileType.ZIP;
        }
        if (b.length >= 4 && (littleEndianInt(b) == 348 || littleEndianInt(b) == 540)) {
            return FileType.NIFTI;
        }
        return FileType.UNKNOWN;
    }

    public static Normalized normalize2d(byte[] original, int minDimension) {
        FileType type = detect(original);
        if (type != FileType.PNG && type != FileType.JPEG) {
            throw new InvalidImageException(switch (type) {
                case DICOM, NIFTI, ZIP -> type + " files are not supported yet (coming with 3D support); upload a PNG or JPEG";
                default -> "File is not a PNG or JPEG image";
            });
        }
        BufferedImage src = decode(original, minDimension);
        BufferedImage gray = src.getType() == BufferedImage.TYPE_USHORT_GRAY || src.getType() == BufferedImage.TYPE_BYTE_GRAY
                ? src : toGray(src, src.getWidth(), src.getHeight());
        BufferedImage thumb = toGray(src, thumbWidth(src), thumbHeight(src));
        return new Normalized(png(gray), png(thumb), src.getWidth(), src.getHeight(), sha256(original), type);
    }

    /** Reads the dimensions from the image header and rejects the image before any pixel buffer is allocated. */
    private static BufferedImage decode(byte[] original, int minDimension) {
        try (ImageInputStream in = ImageIO.createImageInputStream(new ByteArrayInputStream(original))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(in);
            if (!readers.hasNext()) {
                throw new InvalidImageException("Image could not be decoded");
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(in, true, true);
                checkDimensions(reader.getWidth(0), reader.getHeight(0), minDimension);
                return reader.read(0);
            } finally {
                reader.dispose();
            }
        } catch (InvalidImageException e) {
            throw e;
        } catch (IOException | RuntimeException e) {
            throw new InvalidImageException("Image could not be decoded: " + e.getMessage());
        }
    }

    private static void checkDimensions(int width, int height, int minDimension) {
        if ((long) width * height > MAX_PIXELS) {
            throw new InvalidImageException("Image is too large (" + width + "x" + height + "); the maximum is "
                    + MAX_PIXELS / 1_000_000 + " megapixels");
        }
        if (Math.min(width, height) < minDimension) {
            throw new InvalidImageException("Image is too small (" + width + "x" + height
                    + "); the shorter side must be at least " + minDimension + " px");
        }
    }

    private static int thumbWidth(BufferedImage src) {
        return src.getWidth() >= src.getHeight() ? THUMB_SIZE : Math.max(1, src.getWidth() * THUMB_SIZE / src.getHeight());
    }

    private static int thumbHeight(BufferedImage src) {
        return src.getHeight() >= src.getWidth() ? THUMB_SIZE : Math.max(1, src.getHeight() * THUMB_SIZE / src.getWidth());
    }

    private static BufferedImage toGray(BufferedImage src, int w, int h) {
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_BYTE_GRAY);
        Graphics2D g = out.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g.drawImage(src, 0, 0, w, h, null);
        } finally {
            g.dispose();
        }
        return out;
    }

    private static byte[] png(BufferedImage img) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (!ImageIO.write(img, "png", out)) {
                throw new IllegalStateException("No PNG writer available");
            }
            return out.toByteArray();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static String sha256(byte[] data) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static int littleEndianInt(byte[] b) {
        return (b[0] & 0xFF) | (b[1] & 0xFF) << 8 | (b[2] & 0xFF) << 16 | (b[3] & 0xFF) << 24;
    }
}
