package com.medimg.imaging.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.zip.CRC32;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageTypeSpecifier;
import javax.imageio.ImageWriter;
import javax.imageio.metadata.IIOMetadata;
import javax.imageio.metadata.IIOMetadataNode;

import org.junit.jupiter.api.Test;

import com.medimg.imaging.application.ImageNormalizer.FileType;
import com.medimg.imaging.application.ImageNormalizer.InvalidImageException;
import com.medimg.imaging.application.ImageNormalizer.Normalized;

class ImageNormalizerTest {

    @Test
    void detectsTypesByMagicBytes() {
        assertThat(ImageNormalizer.detect(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})).isEqualTo(FileType.PNG);
        assertThat(ImageNormalizer.detect(new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, 0x00})).isEqualTo(FileType.JPEG);
        byte[] dicom = new byte[200];
        dicom[128] = 'D';
        dicom[129] = 'I';
        dicom[130] = 'C';
        dicom[131] = 'M';
        assertThat(ImageNormalizer.detect(dicom)).isEqualTo(FileType.DICOM);
        assertThat(ImageNormalizer.detect(new byte[] {'P', 'K', 3, 4})).isEqualTo(FileType.ZIP);
        assertThat(ImageNormalizer.detect(new byte[] {0x5C, 0x01, 0, 0})).isEqualTo(FileType.NIFTI); // 348 LE
        assertThat(ImageNormalizer.detect("hello world".getBytes(StandardCharsets.UTF_8))).isEqualTo(FileType.UNKNOWN);
    }

    @Test
    void normalisesPngToGrayscaleWithoutMetadataAndMakesThumbnail() throws IOException {
        byte[] original = pngWithText(rgb(800, 600), "PatientName", "John Doe");
        assertThat(contains(original, "John Doe")).isTrue();

        Normalized n = ImageNormalizer.normalize2d(original, 256);

        assertThat(n.width()).isEqualTo(800);
        assertThat(n.height()).isEqualTo(600);
        assertThat(n.sourceType()).isEqualTo(FileType.PNG);
        assertThat(contains(n.png(), "John Doe")).as("metadata stripped").isFalse();
        BufferedImage out = ImageIO.read(new ByteArrayInputStream(n.png()));
        assertThat(out.getType()).isEqualTo(BufferedImage.TYPE_BYTE_GRAY);
        BufferedImage thumb = ImageIO.read(new ByteArrayInputStream(n.thumbnailPng()));
        assertThat(thumb.getWidth()).isEqualTo(256);
        assertThat(thumb.getHeight()).isEqualTo(192);
        assertThat(n.sha256Original()).hasSize(64);
    }

    @Test
    void keeps16BitGrayscale() throws IOException {
        BufferedImage img = new BufferedImage(300, 300, BufferedImage.TYPE_USHORT_GRAY);
        img.getRaster().setSample(10, 10, 0, 40000);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(img, "png", out);

        Normalized n = ImageNormalizer.normalize2d(out.toByteArray(), 256);

        BufferedImage back = ImageIO.read(new ByteArrayInputStream(n.png()));
        assertThat(back.getType()).isEqualTo(BufferedImage.TYPE_USHORT_GRAY);
        assertThat(back.getRaster().getSample(10, 10, 0)).isEqualTo(40000);
    }

    @Test
    void rejectsTooSmallUnsupportedAndCorruptFiles() throws IOException {
        ByteArrayOutputStream small = new ByteArrayOutputStream();
        ImageIO.write(rgb(100, 400), "png", small);
        assertThatThrownBy(() -> ImageNormalizer.normalize2d(small.toByteArray(), 256))
                .isInstanceOf(InvalidImageException.class).hasMessageContaining("too small");

        byte[] dicom = new byte[300];
        System.arraycopy("DICM".getBytes(StandardCharsets.US_ASCII), 0, dicom, 128, 4);
        assertThatThrownBy(() -> ImageNormalizer.normalize2d(dicom, 256))
                .isInstanceOf(InvalidImageException.class).hasMessageContaining("not supported yet");

        byte[] truncated = Arrays.copyOf(small.toByteArray(), 40);
        assertThatThrownBy(() -> ImageNormalizer.normalize2d(truncated, 256)).isInstanceOf(InvalidImageException.class);

        assertThatThrownBy(() -> ImageNormalizer.normalize2d("not an image".getBytes(StandardCharsets.UTF_8), 256))
                .isInstanceOf(InvalidImageException.class).hasMessageContaining("not a PNG or JPEG");
    }

    @Test
    void rejectsImagesOverFiftyMegapixelsBeforeDecodingPixels() {
        // header only: decoding the (missing) pixel data would fail with a different message
        assertThatThrownBy(() -> ImageNormalizer.normalize2d(pngHeaderOnly(10_000, 5_001), 256))
                .isInstanceOf(InvalidImageException.class)
                .hasMessage("Image is too large (10000x5001); the maximum is 50 megapixels");
        assertThatThrownBy(() -> ImageNormalizer.normalize2d(pngHeaderOnly(10_000, 5_000), 256))
                .isInstanceOf(InvalidImageException.class)
                .hasMessageContaining("could not be decoded");
    }

    /** A PNG signature, a valid IHDR chunk for an 8-bit grayscale image of the given size, and IEND. */
    private static byte[] pngHeaderOnly(int width, int height) {
        ByteBuffer ihdr = ByteBuffer.allocate(13).putInt(width).putInt(height)
                .put((byte) 8).put((byte) 0).put((byte) 0).put((byte) 0).put((byte) 0);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A});
        out.writeBytes(chunk("IHDR", ihdr.array()));
        out.writeBytes(chunk("IEND", new byte[0]));
        return out.toByteArray();
    }

    private static byte[] chunk(String type, byte[] data) {
        byte[] typeBytes = type.getBytes(StandardCharsets.US_ASCII);
        CRC32 crc = new CRC32();
        crc.update(typeBytes);
        crc.update(data);
        return ByteBuffer.allocate(12 + data.length).putInt(data.length).put(typeBytes).put(data)
                .putInt((int) crc.getValue()).array();
    }

    private static BufferedImage rgb(int w, int h) {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                img.setRGB(x, y, (x * 255 / w) << 16 | (y * 255 / h) << 8);
            }
        }
        return img;
    }

    private static byte[] pngWithText(BufferedImage img, String key, String value) throws IOException {
        ImageWriter writer = ImageIO.getImageWritersByFormatName("png").next();
        IIOMetadata meta = writer.getDefaultImageMetadata(ImageTypeSpecifier.createFromRenderedImage(img), null);
        IIOMetadataNode text = new IIOMetadataNode("tEXt");
        IIOMetadataNode entry = new IIOMetadataNode("tEXtEntry");
        entry.setAttribute("keyword", key);
        entry.setAttribute("value", value);
        text.appendChild(entry);
        IIOMetadataNode root = new IIOMetadataNode("javax_imageio_png_1.0");
        root.appendChild(text);
        meta.mergeTree("javax_imageio_png_1.0", root);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (var ios = ImageIO.createImageOutputStream(out)) {
            writer.setOutput(ios);
            writer.write(new IIOImage(img, null, meta));
        }
        writer.dispose();
        return out.toByteArray();
    }

    private static boolean contains(byte[] haystack, String needle) {
        return new String(haystack, StandardCharsets.ISO_8859_1).contains(needle);
    }
}
