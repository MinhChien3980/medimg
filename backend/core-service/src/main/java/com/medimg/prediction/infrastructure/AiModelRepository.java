package com.medimg.prediction.infrastructure;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.medimg.prediction.domain.AiModel;

public interface AiModelRepository extends JpaRepository<AiModel, UUID> {

    List<AiModel> findByStatusOrderByCodeAsc(AiModel.Status status);

    Optional<AiModel> findFirstByCodeAndStatusOrderByCreatedAtDesc(String code, AiModel.Status status);

    boolean existsByCodeAndStatus(String code, AiModel.Status status);

    List<AiModel> findAllByOrderByCodeAscVersionAsc();
}
