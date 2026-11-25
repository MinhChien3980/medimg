package com.medimg.identity.application;

import java.util.List;
import java.util.UUID;

import com.medimg.identity.domain.AppUser;

public record UserDto(UUID id, String username, String fullName, List<String> roles) {

    static UserDto from(AppUser u) {
        return new UserDto(u.getId(), u.getUsername(), u.getFullName(),
                u.getRoles().stream().map(Enum::name).sorted().toList());
    }
}
