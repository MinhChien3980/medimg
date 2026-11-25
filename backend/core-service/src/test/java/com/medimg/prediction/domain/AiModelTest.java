package com.medimg.prediction.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class AiModelTest {

    @Test
    void inputTypesAndModalitiesAreCommaSeparatedLists() {
        AiModel model = model("NIFTI,DICOM_SERIES", "CR, DX");

        assertThat(model.accepts("DICOM_SERIES")).isTrue();
        assertThat(model.accepts("nifti")).isTrue();
        assertThat(model.accepts("IMAGE_2D")).isFalse();
        assertThat(model.supportsModality("DX")).isTrue();
        assertThat(model.supportsModality("CT")).isFalse();
        assertThat(model.supportsModality(null)).isFalse();
    }

    @Test
    void modelWithoutModalityTakesAny() {
        AiModel model = model("IMAGE_2D", null);

        assertThat(model.supportsModality("MR")).isTrue();
        assertThat(model.supportsModality(null)).isTrue();
    }

    private static AiModel model(String inputTypes, String modality) {
        AiModel model = new AiModel();
        ReflectionTestUtils.setField(model, "inputTypes", inputTypes);
        ReflectionTestUtils.setField(model, "modality", modality);
        return model;
    }
}
