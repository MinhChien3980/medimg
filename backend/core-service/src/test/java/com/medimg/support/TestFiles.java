package com.medimg.support;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Minimal files of the supported upload formats, built in memory. */
public final class TestFiles {

    private TestFiles() {
    }

    /** A single-file NIfTI-1 volume ({@code n+1}) with a few voxels, in the given byte order. */
    public static byte[] nifti1(ByteOrder order) {
        ByteBuffer b = ByteBuffer.allocate(352 + 64).order(order);
        b.putInt(0, 348);
        b.putShort(40, (short) 3).putShort(42, (short) 4).putShort(44, (short) 4).putShort(46, (short) 2);
        b.putShort(70, (short) 4).putShort(72, (short) 16); // int16
        b.putFloat(108, 352f);
        b.put(344, "n+1\0".getBytes(StandardCharsets.US_ASCII));
        return b.array();
    }

    public static byte[] nifti1() {
        return nifti1(ByteOrder.LITTLE_ENDIAN);
    }

    /** A NIfTI-2 header ({@code n+2}) followed by a little voxel data. */
    public static byte[] nifti2() {
        ByteBuffer b = ByteBuffer.allocate(544 + 64).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(0, 540);
        b.put(4, "n+2\0\r\n\032\n".getBytes(StandardCharsets.US_ASCII));
        return b.array();
    }

    public static byte[] gzip(byte[] content) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (GZIPOutputStream gz = new GZIPOutputStream(out)) {
            gz.write(content);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return out.toByteArray();
    }

    /** A ZIP archive with one (fake) DICOM file. */
    public static byte[] zip() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out)) {
            zip.putNextEntry(new ZipEntry("series/IM0001.dcm"));
            byte[] dicom = new byte[200];
            System.arraycopy("DICM".getBytes(StandardCharsets.US_ASCII), 0, dicom, 128, 4);
            zip.write(dicom);
            zip.closeEntry();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return out.toByteArray();
    }
}
