package com.medimg.identity.application;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Pageable;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.identity.application.AdminUserDtos.AdminUserDto;
import com.medimg.identity.application.AdminUserDtos.CreateUser;
import com.medimg.identity.application.AdminUserDtos.CreatedUser;
import com.medimg.identity.application.AdminUserDtos.TemporaryPassword;
import com.medimg.identity.application.AdminUserDtos.UpdateUser;
import com.medimg.identity.application.AdminUserDtos.UserFilter;
import com.medimg.identity.domain.AppUser;
import com.medimg.identity.domain.RefreshToken.RevokedReason;
import com.medimg.identity.domain.Role;
import com.medimg.identity.domain.TemporaryPasswords;
import com.medimg.identity.infrastructure.AppUserRepository;
import com.medimg.identity.infrastructure.RefreshTokenRepository;
import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.audit.AuditEvents;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.web.ApiException;
import com.medimg.shared.web.ExpectedVersion;
import com.medimg.shared.web.PageResponse;

/**
 * User administration. Accounts are never deleted, only locked. Two rules keep the system administrable:
 * <ul>
 * <li>an admin cannot lock, demote (remove ADMIN from) or reset the password of their own account (422);</li>
 * <li>the last ACTIVE admin cannot be locked or demoted (409), also when two admins act on each other at once.</li>
 * </ul>
 * Every change is audited (USER_CREATED, USER_UPDATED, USER_LOCKED, USER_UNLOCKED, USER_PASSWORD_RESET), refused
 * ones with outcome FAILURE; no password or hash ever goes into the audit log.
 */
@Service
public class UserAdminService {

    private final AppUserRepository users;
    private final RefreshTokenRepository refreshTokens;
    private final PasswordEncoder passwordEncoder;
    private final ApplicationEventPublisher events;
    private final Clock clock;

    UserAdminService(AppUserRepository users, RefreshTokenRepository refreshTokens, PasswordEncoder passwordEncoder,
                     ApplicationEventPublisher events, Clock clock) {
        this.users = users;
        this.refreshTokens = refreshTokens;
        this.passwordEncoder = passwordEncoder;
        this.events = events;
        this.clock = clock;
    }

    /** {@code q} matches part of the username, full name or e-mail, ignoring case; LIKE wildcards in it are literal. */
    @Transactional(readOnly = true)
    public PageResponse<AdminUserDto> search(UserFilter filter, Pageable pageable) {
        return PageResponse.of(users.search(likePattern(filter.q()),
                filter.status() == null ? null : filter.status().name(),
                filter.role() == null ? null : filter.role().name(), pageable), AdminUserDto::from);
    }

    @Transactional(readOnly = true)
    public AdminUserDto get(UUID id) {
        return AdminUserDto.from(require(id));
    }

    /** Usernames are stored in lower case, so that two accounts never differ only by case (409). */
    @Transactional
    public CreatedUser create(CreateUser cmd) {
        String username = cmd.username().trim().toLowerCase(Locale.ROOT);
        if (users.existsByUsernameIgnoreCase(username)) {
            throw usernameTaken(username);
        }
        String temporary = TemporaryPasswords.generate(username);
        AppUser user = AppUser.withTemporaryPassword(username, passwordEncoder.encode(temporary), cmd.fullName().trim(),
                blankToNull(cmd.email()), requireRoles(cmd.roles()), now());
        try {
            users.saveAndFlush(user); // a concurrent insert of the same name fails here (unique index on lower(username))
        } catch (DataIntegrityViolationException e) {
            throw usernameTaken(username);
        }
        audit("USER_CREATED", user.getId(), Outcome.SUCCESS,
                Map.of("username", username, "roles", sortedNames(user.getRoles())));
        return new CreatedUser(AdminUserDto.from(user), temporary);
    }

    /** 409 when the user changed since the admin read {@code version}. An update that changes nothing is not audited. */
    @Transactional
    public AdminUserDto update(UUID id, UpdateUser cmd) {
        AppUser user = require(id);
        ExpectedVersion.check("User", id, cmd.version(), user.getVersion());
        Set<Role> roles = requireRoles(cmd.roles());
        if (user.hasRole(Role.ADMIN) && !roles.contains(Role.ADMIN)) {
            if (id.equals(CurrentUser.id())) {
                throw refused("USER_UPDATED", id, "self_demote", ApiException.unprocessable(
                        "You cannot remove the ADMIN role from your own account").type("self-demote"));
            }
            if (!user.isLocked()) {
                requireAnotherActiveAdmin("USER_UPDATED", id);
            }
        }
        Set<Role> added = EnumSet.copyOf(roles);
        added.removeAll(user.getRoles());
        Set<Role> removed = EnumSet.noneOf(Role.class);
        removed.addAll(user.getRoles());
        removed.removeAll(roles);
        String fullName = cmd.fullName().trim();
        String email = blankToNull(cmd.email());
        boolean fullNameChanged = !fullName.equals(user.getFullName());
        boolean emailChanged = !Objects.equals(email, user.getEmail());
        if (added.isEmpty() && removed.isEmpty() && !fullNameChanged && !emailChanged) {
            return AdminUserDto.from(user);
        }
        user.update(fullName, email, roles);
        users.saveAndFlush(user);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("rolesAdded", sortedNames(added));
        detail.put("rolesRemoved", sortedNames(removed));
        detail.put("fullNameChanged", fullNameChanged);
        detail.put("emailChanged", emailChanged);
        audit("USER_UPDATED", id, Outcome.SUCCESS, detail);
        return AdminUserDto.from(user);
    }

    /**
     * Locks the account and revokes all its sessions; its access tokens are refused from the next request on.
     * Locking a locked account changes nothing.
     */
    @Transactional
    public AdminUserDto lock(UUID id) {
        UUID actor = CurrentUser.id();
        AppUser user = require(id);
        if (id.equals(actor)) {
            throw refused("USER_LOCKED", id, "self_lock",
                    ApiException.unprocessable("You cannot lock your own account").type("self-lock"));
        }
        if (user.isLocked()) {
            return AdminUserDto.from(user);
        }
        if (user.hasRole(Role.ADMIN)) {
            requireAnotherActiveAdmin("USER_LOCKED", id);
        }
        Instant now = now();
        user.lock(actor, now);
        users.saveAndFlush(user);
        int revoked = refreshTokens.revokeAllForUser(id, now, RevokedReason.LOCKED);
        audit("USER_LOCKED", id, Outcome.SUCCESS, Map.of("username", user.getUsername(), "sessionsRevoked", revoked));
        return AdminUserDto.from(user);
    }

    /** Unlocking an active account changes nothing. The user logs in again: their sessions were revoked by the lock. */
    @Transactional
    public AdminUserDto unlock(UUID id) {
        AppUser user = require(id);
        if (user.unlock()) {
            users.saveAndFlush(user);
            audit("USER_UNLOCKED", id, Outcome.SUCCESS, Map.of("username", user.getUsername()));
        }
        return AdminUserDto.from(user);
    }

    /**
     * Gives the user a new temporary password (returned once), to be changed at the next login, and revokes all their
     * sessions. A locked user stays locked. Admins change their own password with {@code /me/password}.
     */
    @Transactional
    public TemporaryPassword resetPassword(UUID id) {
        AppUser user = require(id);
        if (id.equals(CurrentUser.id())) {
            throw refused("USER_PASSWORD_RESET", id, "self_reset",
                    ApiException.unprocessable("Change your own password with /me/password").type("self-reset"));
        }
        Instant now = now();
        String temporary = TemporaryPasswords.generate(user.getUsername());
        user.resetPassword(passwordEncoder.encode(temporary), now);
        users.saveAndFlush(user);
        int revoked = refreshTokens.revokeAllForUser(id, now, RevokedReason.PASSWORD_RESET);
        audit("USER_PASSWORD_RESET", id, Outcome.SUCCESS,
                Map.of("username", user.getUsername(), "sessionsRevoked", revoked));
        return new TemporaryPassword(temporary);
    }

    /** Locks the rows of the active admins (see {@link AppUserRepository#lockActiveAdmins()}) and looks for another one. */
    private void requireAnotherActiveAdmin(String action, UUID target) {
        if (users.lockActiveAdmins().stream().allMatch(target::equals)) {
            throw refused(action, target, "last_admin", ApiException.conflict(
                    "This is the last active admin: make another account an active admin first").type("last-admin"));
        }
    }

    private ApiException refused(String action, UUID target, String reason, ApiException e) {
        audit(action, target, Outcome.FAILURE, Map.of("reason", reason));
        return e;
    }

    private void audit(String action, UUID target, Outcome outcome, Map<String, Object> detail) {
        events.publishEvent(AuditEvents.current(action, "USER", target, outcome, detail));
    }

    /** PostgreSQL keeps microseconds: what is returned is then what a later read returns. */
    private Instant now() {
        return clock.instant().truncatedTo(ChronoUnit.MICROS);
    }

    private AppUser require(UUID id) {
        return users.findById(id).orElseThrow(() -> ApiException.notFound("User", id));
    }

    static String likePattern(String q) {
        String text = q == null ? "" : q.trim().toLowerCase(Locale.ROOT);
        if (text.isEmpty()) {
            return null;
        }
        return "%" + text.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
    }

    private static ApiException usernameTaken(String username) {
        return ApiException.conflict("The username " + username + " is already taken").type("username-taken");
    }

    private static Set<Role> requireRoles(Set<Role> roles) {
        if (roles == null || roles.isEmpty() || roles.stream().anyMatch(Objects::isNull)) {
            throw ApiException.badRequest("At least one role is required");
        }
        return EnumSet.copyOf(roles);
    }

    private static List<String> sortedNames(Set<Role> roles) {
        return roles.stream().map(Enum::name).sorted().toList();
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
