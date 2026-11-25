package com.medimg.identity.application;

import java.util.Collection;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.identity.infrastructure.AppUserRepository;

/** Names of users for other modules, looked up in one query per batch. */
@Service
public class UserDirectory {

    private final AppUserRepository users;

    UserDirectory(AppUserRepository users) {
        this.users = users;
    }

    /** The known users among {@code ids}; unknown ids are left out. */
    @Transactional(readOnly = true)
    public Map<UUID, UserRef> find(Collection<UUID> ids) {
        if (ids.isEmpty()) {
            return Map.of();
        }
        return users.findAllById(ids.stream().distinct().toList()).stream()
                .map(u -> new UserRef(u.getId(), u.getFullName() == null || u.getFullName().isBlank()
                        ? u.getUsername() : u.getFullName()))
                .collect(Collectors.toMap(UserRef::id, Function.identity()));
    }
}
