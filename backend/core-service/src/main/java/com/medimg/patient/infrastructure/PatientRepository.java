package com.medimg.patient.infrastructure;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import com.medimg.patient.domain.Patient;

public interface PatientRepository extends JpaRepository<Patient, UUID> {

    @Query("""
            select p from Patient p
            where p.deletedAt is null
              and (:q = '' or lower(p.code) like lower(concat('%', :q, '%'))
                   or lower(coalesce(p.note, '')) like lower(concat('%', :q, '%')))
            """)
    Page<Patient> search(String q, Pageable pageable);

    Optional<Patient> findByIdAndDeletedAtIsNull(UUID id);

    boolean existsByCode(String code);
}
