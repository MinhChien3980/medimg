package com.medimg.identity.infrastructure;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.medimg.identity.domain.AppUser;

public interface AppUserRepository extends JpaRepository<AppUser, UUID> {

    Optional<AppUser> findByUsernameIgnoreCase(String username);

    boolean existsByUsernameIgnoreCase(String username);
}
