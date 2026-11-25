package com.medimg.prediction.infrastructure;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

import com.medimg.prediction.domain.Finding;

public interface FindingRepository extends JpaRepository<Finding, UUID> {

    List<Finding> findByResultIdInOrderByConfidenceDesc(Collection<UUID> resultIds);

    @Modifying
    @Query("delete from Finding f where f.resultId = :resultId")
    void deleteByResultId(UUID resultId);
}
