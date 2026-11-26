package com.medimg.patient.infrastructure;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import com.medimg.patient.domain.Patient;

public interface PatientRepository extends JpaRepository<Patient, UUID> {

    /**
     * Live cases whose code or note contains the search text; {@code :pattern} comes from
     * {@link com.medimg.shared.persistence.LikePatterns#contains}. Each condition is the expression of a trigram index
     * (V9), so the search does not scan the table.
     */
    String SEARCH = """
            FROM patient p
            WHERE p.deleted_at IS NULL
              AND (lower(p.code) LIKE cast(:pattern AS text) ESCAPE '!'
                   OR lower(coalesce(p.note, '')) LIKE cast(:pattern AS text) ESCAPE '!')
            """;

    /** Cases matching {@link #SEARCH}, newest first. */
    @Query(value = "SELECT p.* " + SEARCH + " ORDER BY p.created_at DESC, p.id",
            countQuery = "SELECT count(*) " + SEARCH, nativeQuery = true)
    Page<Patient> search(String pattern, Pageable pageable);

    /** Every live case, newest first. */
    @Query(value = "select p from Patient p where p.deletedAt is null order by p.createdAt desc, p.id",
            countQuery = "select count(p) from Patient p where p.deletedAt is null")
    Page<Patient> findLive(Pageable pageable);

    @Query("select p from Patient p where p.deletedAt is null and p.sample.title is not null order by p.sample.title")
    List<Patient> findSamples();

    Optional<Patient> findByIdAndDeletedAtIsNull(UUID id);

    boolean existsByCode(String code);
}
