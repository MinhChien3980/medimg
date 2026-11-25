package com.medimg.prediction.infrastructure;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.medimg.prediction.domain.PredictionResult;

public interface PredictionResultRepository extends JpaRepository<PredictionResult, UUID> {

    Optional<PredictionResult> findByJobId(UUID jobId);

    List<PredictionResult> findByJobIdIn(Collection<UUID> jobIds);
}
