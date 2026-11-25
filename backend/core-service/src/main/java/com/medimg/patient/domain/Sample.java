package com.medimg.patient.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

/** What makes a case a sample case: shown to every role on the samples page, with where its images come from. */
@Embeddable
public record Sample(
        @Column(name = "sample_title") String title,
        @Column(name = "sample_description") String description,
        @Column(name = "sample_source") String source) {

    public Sample {
        if (title == null || title.isBlank() || source == null || source.isBlank()) {
            throw new IllegalArgumentException("A sample case needs a title and a source");
        }
    }
}
