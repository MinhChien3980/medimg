package com.medimg.imaging.application;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.zip.GZIPInputStream;

/**
 * File type from the first bytes of a file, never from its name. A gzip file is looked into: it counts as NIfTI when
 * its decompressed start is a NIfTI header.
 */
public final class FileTypeDetector {

    public enum FileType { PNG, JPEG, DICOM, ZIP, NIFTI, UNKNOWN }

    /** How much of a file {@link #detect(byte[])} needs. */
    public static final int HEAD_BYTES = 64 * 1024;

    private static final int NIFTI1_HEADER_SIZE = 348;
    private static final int NIFTI2_HEADER_SIZE = 540;
    /** Single-file magic; {@code ni1}/{@code ni2} mark a header whose voxels are in a separate .img file. */
    private static final byte[] NIFTI1_MAGIC = "n+1\0".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] NIFTI2_MAGIC = "n+2\0".getBytes(StandardCharsets.US_ASCII);

    private FileTypeDetector() {
    }

    public static FileType detect(byte[] head) {
        if (head.length >= 8 && (head[0] & 0xFF) == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G') {
            return FileType.PNG;
        }
        if (head.length >= 3 && (head[0] & 0xFF) == 0xFF && (head[1] & 0xFF) == 0xD8 && (head[2] & 0xFF) == 0xFF) {
            return FileType.JPEG;
        }
        if (head.length >= 132 && head[128] == 'D' && head[129] == 'I' && head[130] == 'C' && head[131] == 'M') {
            return FileType.DICOM;
        }
        if (head.length >= 4 && head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4) {
            return FileType.ZIP;
        }
        if (head.length >= 2 && (head[0] & 0xFF) == 0x1F && (head[1] & 0xFF) == 0x8B) {
            return isNiftiHeader(gunzipStart(head)) ? FileType.NIFTI : FileType.UNKNOWN;
        }
        return isNiftiHeader(head) ? FileType.NIFTI : FileType.UNKNOWN;
    }

    /** {@code sizeof_hdr} (either byte order) and the magic string of a NIfTI-1 or NIfTI-2 single-file header. */
    private static boolean isNiftiHeader(byte[] b) {
        if (b.length < 4) {
            return false;
        }
        int little = ByteBuffer.wrap(b, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
        int big = ByteBuffer.wrap(b, 0, 4).order(ByteOrder.BIG_ENDIAN).getInt();
        if (little == NIFTI1_HEADER_SIZE || big == NIFTI1_HEADER_SIZE) {
            return hasBytesAt(b, 344, NIFTI1_MAGIC);
        }
        if (little == NIFTI2_HEADER_SIZE || big == NIFTI2_HEADER_SIZE) {
            return hasBytesAt(b, 4, NIFTI2_MAGIC);
        }
        return false;
    }

    private static boolean hasBytesAt(byte[] b, int offset, byte[] expected) {
        return b.length >= offset + expected.length
                && Arrays.equals(b, offset, offset + expected.length, expected, 0, expected.length);
    }

    /** The decompressed start of a (possibly truncated) gzip stream; empty if it cannot be decompressed. */
    private static byte[] gunzipStart(byte[] gzip) {
        try (var in = new GZIPInputStream(new ByteArrayInputStream(gzip))) {
            return in.readNBytes(NIFTI2_HEADER_SIZE);
        } catch (IOException e) {
            return new byte[0];
        }
    }
}
