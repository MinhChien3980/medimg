package com.medimg.imaging.application;

import java.util.Locale;
import java.util.Optional;
import java.util.Set;

import com.medimg.imaging.application.FileTypeDetector.FileType;
import com.medimg.imaging.domain.Study.InputType;

/**
 * What a file is declared to be at init, from its name and content type: it sets the size limit. When the upload is
 * completed, the file content (magic bytes) must match the declaration.
 */
enum UploadKind {

    IMAGE_2D("File is not a PNG or JPEG image"),
    VOLUME("File is neither a ZIP archive of DICOM files nor a NIfTI volume");

    static final String UNSUPPORTED = "Unsupported file; upload a PNG or JPEG image (image/png, image/jpeg), a ZIP "
            + "of DICOM files (.zip) or a NIfTI volume (.nii, .nii.gz)";

    private static final Set<String> IMAGE_TYPES = Set.of("image/png", "image/jpeg");
    private static final Set<String> ZIP_TYPES = Set.of("application/zip", "application/x-zip-compressed");
    private static final Set<String> NIFTI_TYPES = Set.of("application/octet-stream", "application/gzip", "application/x-gzip");

    private final String mismatch;

    UploadKind(String mismatch) {
        this.mismatch = mismatch;
    }

    static Optional<UploadKind> of(String fileName, String contentType) {
        String name = fileName.toLowerCase(Locale.ROOT);
        if (IMAGE_TYPES.contains(contentType)) {
            return Optional.of(IMAGE_2D);
        }
        if (name.endsWith(".zip") && ZIP_TYPES.contains(contentType)) {
            return Optional.of(VOLUME);
        }
        if ((name.endsWith(".nii") || name.endsWith(".nii.gz")) && NIFTI_TYPES.contains(contentType)) {
            return Optional.of(VOLUME);
        }
        return Optional.empty();
    }

    long maxBytes(ImagingProperties props) {
        return this == IMAGE_2D ? props.maxUploadBytes() : props.volume().maxUploadBytes();
    }

    /** The input type of a file of this kind with the detected content, if the content matches the kind. */
    Optional<InputType> inputType(FileType detected) {
        return Optional.ofNullable(switch (this) {
            case IMAGE_2D -> detected == FileType.PNG || detected == FileType.JPEG ? InputType.IMAGE_2D : null;
            case VOLUME -> switch (detected) {
                case ZIP -> InputType.DICOM_SERIES;
                case NIFTI -> InputType.NIFTI;
                default -> null;
            };
        });
    }

    /** Why a file of this kind was rejected when its content does not match. */
    String mismatchMessage() {
        return mismatch;
    }
}
