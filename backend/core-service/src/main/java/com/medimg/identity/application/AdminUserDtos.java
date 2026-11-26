package com.medimg.identity.application;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import com.medimg.identity.domain.AppUser;
import com.medimg.identity.domain.Role;
import com.medimg.identity.domain.UserStatus;

/** Requests and views of the user administration. */
public final class AdminUserDtos {

    private AdminUserDtos() {
    }

    /** A user as an admin sees it; {@code version} is sent back with an update. Never holds a password or its hash. */
    public record AdminUserDto(UUID id, String username, String fullName, String email, List<String> roles,
                               String status, boolean passwordChangeRequired, Instant lastLoginAt, Instant lockedAt,
                               Instant createdAt, long version) {

        static AdminUserDto from(AppUser u) {
            return new AdminUserDto(u.getId(), u.getUsername(), u.getFullName(), u.getEmail(),
                    u.getRoles().stream().map(Enum::name).sorted().toList(), u.getStatus().name(),
                    u.isPasswordChangeRequired(), u.getLastLoginAt(), u.getLockedAt(), u.getCreatedAt(), u.getVersion());
        }
    }

    public record UserFilter(String q, Role role, UserStatus status) {
    }

    public record CreateUser(String username, String fullName, String email, Set<Role> roles) {
    }

    public record UpdateUser(String fullName, String email, Set<Role> roles, long version) {
    }

    /** The temporary password is shown once: it is stored only as a hash. */
    public record CreatedUser(AdminUserDto user, String temporaryPassword) {
    }

    public record TemporaryPassword(String temporaryPassword) {
    }
}
