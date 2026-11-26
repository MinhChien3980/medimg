package com.medimg.identity.application;

import java.util.List;
import java.util.UUID;

import com.medimg.identity.domain.AppUser;

/**
 * The logged-in user. While {@code passwordChangeRequired} is true (temporary password given by an admin) every API
 * but {@code /me}, {@code /me/password} and {@code /auth/*} answers 403 with the problem type
 * {@code /problems/password-change-required}.
 */
public record UserDto(UUID id, String username, String fullName, List<String> roles, boolean passwordChangeRequired) {

    static UserDto from(AppUser u) {
        return new UserDto(u.getId(), u.getUsername(), u.getFullName(),
                u.getRoles().stream().map(Enum::name).sorted().toList(), u.isPasswordChangeRequired());
    }
}
