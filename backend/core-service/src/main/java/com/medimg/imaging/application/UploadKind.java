package com.medimg.imaging.application;

import java.util.EnumSet;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

import com.medimg.imaging.application.FileTypeDetector.FileType;
import com.medimg.imaging.domain.IngestInput;

/**
 * What a file is declared to be at init, from its name and content type: it sets the size limit and who processes the
 * file. When the upload is completed, the file content (magic bytes) must match the declaration.
 */
enum UploadKind {

    /** Processed in this service. */
    IMAGE_2D(null, EnumSet.of(FileType.PNG, FileType.JPEG), "File is not a PNG or JPEG image"),
    DICOM_2D(IngestInput.DICOM_2D, EnumSet.of(FileType.DICOM), "File is not a DICOM file"),
    ZIP(IngestInput.ZIP, EnumSet.of(FileType.ZIP), "File is not a ZIP archive"),
    NIFTI(IngestInput.NIFTI, EnumSet.of(FileType.NIFTI), "File is not a NIfTI volume");

    static final String UNSUPPORTED = "Unsupported file; upload a PNG or JPEG image (image/png, image/jpeg), a DICOM "
            + "X-ray (.dcm, application/dicom), a ZIP of DICOM files or of PNG/JPEG slices (.zip) or a NIfTI volume "
            + "(.nii, .nii.gz)";

    private static final Set<String> IMAGE_TYPES = Set.of("image/png", "image/jpeg");
    private static final String DICOM_TYPE = "application/dicom";
    private static final String OCTET_STREAM = "application/octet-stream";
    private static final Set<String> ZIP_TYPES = Set.of("application/zip", "application/x-zip-compressed");
    private static final Set<String> NIFTI_TYPES = Set.of(OCTET_STREAM, "application/gzip", "application/x-gzip");

    private final IngestInput ingestInput;
    private final Set<FileType> contents;
    private final String mismatch;

    UploadKind(IngestInput ingestInput, Set<FileType> contents, String mismatch) {
        this.ingestInput = ingestInput;
        this.contents = contents;
        this.mismatch = mismatch;
    }

    static Optional<UploadKind> of(String fileName, String contentType) {
        String name = fileName.toLowerCase(Locale.ROOT);
        if (IMAGE_TYPES.contains(contentType)) {
            return Optional.of(IMAGE_2D);
        }
        if (DICOM_TYPE.equals(contentType) || (name.endsWith(".dcm") && OCTET_STREAM.equals(contentType))) {
            return Optional.of(DICOM_2D);
        }
        if (name.endsWith(".zip") && ZIP_TYPES.contains(contentType)) {
            return Optional.of(ZIP);
        }
        if ((name.endsWith(".nii") || name.endsWith(".nii.gz")) && NIFTI_TYPES.contains(contentType)) {
            return Optional.of(NIFTI);
        }
        return Optional.empty();
    }

    boolean isVolume() {
        return this == ZIP || this == NIFTI;
    }

    long maxBytes(ImagingProperties props) {
        return isVolume() ? props.volume().maxUploadBytes() : props.maxUploadBytes();
    }

    /** What the ingest worker reads for a file of this kind; empty for a kind processed in this service. */
    Optional<IngestInput> ingestInput() {
        return Optional.ofNullable(ingestInput);
    }

    boolean matches(FileType detected) {
        return contents.contains(detected);
    }

    /** Why a file of this kind was rejected when its content does not match. */
    String mismatchMessage() {
        return mismatch;
    }
}
