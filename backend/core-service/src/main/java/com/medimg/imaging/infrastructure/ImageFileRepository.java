package com.medimg.imaging.infrastructure;

import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.medimg.imaging.domain.ImageFile;

public interface ImageFileRepository extends JpaRepository<ImageFile, UUID> {
}
