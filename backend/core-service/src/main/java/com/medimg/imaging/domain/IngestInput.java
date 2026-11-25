package com.medimg.imaging.domain;

import java.util.EnumSet;
import java.util.Set;

import com.medimg.imaging.domain.Study.InputType;

/** What the ingest worker is asked to read, and the study input types it may turn that into. */
public enum IngestInput {

    DICOM_2D(EnumSet.of(InputType.DICOM_2D)),
    /** A DICOM series or a stack of 2D images; the worker tells which. */
    ZIP(EnumSet.of(InputType.DICOM_SERIES, InputType.IMAGE_STACK)),
    NIFTI(EnumSet.of(InputType.NIFTI));

    private final Set<InputType> results;

    IngestInput(Set<InputType> results) {
        this.results = results;
    }

    public boolean canBecome(InputType inputType) {
        return results.contains(inputType);
    }

    /** The study input type, when it is known before the worker has read the file; null otherwise. */
    InputType knownInputType() {
        return results.size() == 1 ? results.iterator().next() : null;
    }
}
