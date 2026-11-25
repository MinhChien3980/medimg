package com.medimg.imaging.domain;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/** A study only exists once its images are stored and normalised, i.e. it is always ready for viewing and AI. */
@Entity
@Table(name = "study")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Study {

    public enum InputType { IMAGE_2D, DICOM_2D, DICOM_SERIES, NIFTI, IMAGE_STACK }

    @Id
    private UUID id;

    @Column(name = "patient_id", nullable = false)
    private UUID patientId;

    @Enumerated(EnumType.STRING)
    @Column(name = "input_type", nullable = false)
    private InputType inputType;

    private String modality;

    @Column(name = "body_part")
    private String bodyPart;

    @Column(name = "storage_prefix")
    private String storagePrefix;

    @Column(name = "created_by")
    private UUID createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    public Study(UUID patientId, InputType inputType, String modality, String bodyPart, UUID createdBy, Instant now) {
        this.id = UUID.randomUUID();
        this.patientId = patientId;
        this.inputType = inputType;
        this.modality = modality;
        this.bodyPart = bodyPart;
        this.storagePrefix = "studies/" + id + "/";
        this.createdBy = createdBy;
        this.createdAt = now;
    }
}
