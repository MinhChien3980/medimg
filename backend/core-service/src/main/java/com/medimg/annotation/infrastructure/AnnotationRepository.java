package com.medimg.annotation.infrastructure;

import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.medimg.annotation.domain.Annotation;

public interface AnnotationRepository extends JpaRepository<Annotation, UUID> {

    List<Annotation> findByStudyIdOrderByCreatedAtAsc(UUID studyId);
}
