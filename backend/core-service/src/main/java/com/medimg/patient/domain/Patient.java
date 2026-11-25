package com.medimg.patient.domain;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/** A case. Demo data is anonymised: only a pseudonymous code, birth year and sex are kept. */
@Entity
@Table(name = "patient")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Patient {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String code;

    @Column(name = "birth_year")
    private Short birthYear;

    @Column(columnDefinition = "bpchar(1)")
    private String sex;

    private String note;

    @Column(name = "is_anonymized", nullable = false)
    private boolean anonymized = true;

    @Column(name = "created_by")
    private UUID createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at")
    private Instant updatedAt;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    public Patient(String code, Short birthYear, String sex, String note, UUID createdBy, Instant now) {
        this.id = UUID.randomUUID();
        this.code = code;
        this.birthYear = birthYear;
        this.sex = sex;
        this.note = note;
        this.createdBy = createdBy;
        this.createdAt = now;
    }

    public void update(Short birthYear, String sex, String note, Instant now) {
        this.birthYear = birthYear;
        this.sex = sex;
        this.note = note;
        this.updatedAt = now;
    }

    public void softDelete(Instant now) {
        this.deletedAt = now;
    }
}
