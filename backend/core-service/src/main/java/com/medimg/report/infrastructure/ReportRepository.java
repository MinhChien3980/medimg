package com.medimg.report.infrastructure;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

import com.medimg.report.domain.Report;

import jakarta.persistence.LockModeType;

public interface ReportRepository extends JpaRepository<Report, UUID> {

    /** The versions of the study's report, latest first. */
    List<Report> findByStudyIdOrderByVersionDesc(UUID studyId);

    Optional<Report> findFirstByStudyIdOrderByVersionDesc(UUID studyId);

    boolean existsByStudyId(UUID studyId);

    /** Locks the report row, so that a report is signed (and its PDF written) by one request at a time. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from Report r where r.id = :id")
    Optional<Report> findForUpdate(UUID id);

    @Query("select count(r) > 0 from Report r join r.citedFindings f where f = :findingId")
    boolean citesFinding(UUID findingId);
}
