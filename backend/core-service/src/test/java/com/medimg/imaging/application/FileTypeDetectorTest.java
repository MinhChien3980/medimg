package com.medimg.imaging.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Random;

import org.junit.jupiter.api.Test;

import com.medimg.imaging.application.FileTypeDetector.FileType;
import com.medimg.support.TestFiles;

class FileTypeDetectorTest {

    @Test
    void detectsTypesByMagicBytes() {
        assertThat(FileTypeDetector.detect(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})).isEqualTo(FileType.PNG);
        assertThat(FileTypeDetector.detect(new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, 0x00})).isEqualTo(FileType.JPEG);
        byte[] dicom = new byte[200];
        dicom[128] = 'D';
        dicom[129] = 'I';
        dicom[130] = 'C';
        dicom[131] = 'M';
        assertThat(FileTypeDetector.detect(dicom)).isEqualTo(FileType.DICOM);
        assertThat(FileTypeDetector.detect(TestFiles.zip())).isEqualTo(FileType.ZIP);
        assertThat(FileTypeDetector.detect("hello world".getBytes(StandardCharsets.UTF_8))).isEqualTo(FileType.UNKNOWN);
        assertThat(FileTypeDetector.detect(new byte[0])).isEqualTo(FileType.UNKNOWN);
    }

    @Test
    void detectsNiftiFromHeaderSizeAndMagicInEitherByteOrder() {
        assertThat(FileTypeDetector.detect(TestFiles.nifti1(ByteOrder.LITTLE_ENDIAN))).isEqualTo(FileType.NIFTI);
        assertThat(FileTypeDetector.detect(TestFiles.nifti1(ByteOrder.BIG_ENDIAN))).isEqualTo(FileType.NIFTI);
        assertThat(FileTypeDetector.detect(TestFiles.nifti2())).isEqualTo(FileType.NIFTI);
    }

    @Test
    void headerSizeAloneIsNotANiftiFile() {
        assertThat(FileTypeDetector.detect(new byte[] {0x5C, 0x01, 0, 0})).isEqualTo(FileType.UNKNOWN); // 348, no magic
        byte[] pairHeader = TestFiles.nifti1();
        pairHeader[345] = 'i'; // "ni1": voxels in a separate .img file
        assertThat(FileTypeDetector.detect(pairHeader)).isEqualTo(FileType.UNKNOWN);
    }

    @Test
    void looksIntoGzipForANiftiHeader() {
        assertThat(FileTypeDetector.detect(TestFiles.gzip(TestFiles.nifti1()))).isEqualTo(FileType.NIFTI);
        assertThat(FileTypeDetector.detect(TestFiles.gzip("plain text".getBytes(StandardCharsets.UTF_8))))
                .isEqualTo(FileType.UNKNOWN);
    }

    @Test
    void readsOnlyTheStartOfALargeGzipVolume() {
        byte[] voxels = new byte[2_000_000];
        new Random(42).nextBytes(voxels); // incompressible, so the gzip is much longer than the head read
        byte[] volume = Arrays.copyOf(TestFiles.nifti1(), 352 + voxels.length);
        System.arraycopy(voxels, 0, volume, 352, voxels.length);
        byte[] head = Arrays.copyOf(TestFiles.gzip(volume), FileTypeDetector.HEAD_BYTES);

        assertThat(FileTypeDetector.detect(head)).isEqualTo(FileType.NIFTI);
    }

    @Test
    void truncatedGzipIsUnknown() {
        byte[] gz = TestFiles.gzip(TestFiles.nifti1());
        assertThat(FileTypeDetector.detect(Arrays.copyOf(gz, 12))).isEqualTo(FileType.UNKNOWN);
        assertThat(FileTypeDetector.detect(new byte[] {0x1F, (byte) 0x8B, 0x08})).isEqualTo(FileType.UNKNOWN);
    }
}
