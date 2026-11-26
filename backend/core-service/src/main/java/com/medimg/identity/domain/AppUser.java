package com.medimg.identity.domain;

import java.time.Instant;
import java.util.EnumSet;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

import org.hibernate.annotations.BatchSize;
import org.springframework.data.domain.Persistable;

import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.PostLoad;
import jakarta.persistence.PostPersist;
import jakarta.persistence.Table;
import jakarta.persistence.Transient;
import jakarta.persistence.Version;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * A user account. It is never deleted, only locked. An account created by an admin, or whose password an admin reset,
 * holds a temporary password and must set its own one before using anything but its profile.
 * <p>
 * The id is assigned here, so the entity tells Spring Data itself whether it is new ({@link Persistable}): a new
 * account is persisted, not merged (a merge would insert a copy and count its roles as a change of version 0).
 */
@Entity
@Table(name = "app_user")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class AppUser implements Persistable<UUID> {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String username;

    @Column(name = "password_hash", nullable = false)
    private String passwordHash;

    @Column(name = "full_name")
    private String fullName;

    private String email;

    /** Written with a bulk update at login, so that logging in does not change {@link #version}. */
    @Column(name = "last_login_at")
    private Instant lastLoginAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "user_role", joinColumns = @JoinColumn(name = "user_id"))
    @Column(name = "role_code")
    @Enumerated(EnumType.STRING)
    @BatchSize(size = 100) // a page of users loads its roles in one query
    private Set<Role> roles = EnumSet.noneOf(Role.class);

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private UserStatus status = UserStatus.ACTIVE;

    @Column(name = "locked_at")
    private Instant lockedAt;

    @Column(name = "locked_by")
    private UUID lockedBy;

    @Column(name = "password_change_required", nullable = false)
    private boolean passwordChangeRequired;

    @Column(name = "password_changed_at")
    private Instant passwordChangedAt;

    @Version
    private long version;

    @Transient
    @Getter(AccessLevel.NONE)
    private boolean unsaved;

    /** An account with a password of its own, e.g. a demo account. */
    public AppUser(String username, String passwordHash, String fullName, String email, Set<Role> roles, Instant now) {
        this.id = UUID.randomUUID();
        this.username = username;
        this.passwordHash = passwordHash;
        this.fullName = fullName;
        this.email = email;
        this.createdAt = now;
        this.roles = roles.isEmpty() ? EnumSet.noneOf(Role.class) : EnumSet.copyOf(roles);
        this.unsaved = true;
    }

    @Override
    public boolean isNew() {
        return unsaved;
    }

    @PostPersist
    @PostLoad
    void markSaved() {
        unsaved = false;
    }

    /** An account created by an admin with a temporary password, to be changed at the first login. */
    public static AppUser withTemporaryPassword(String username, String temporaryPasswordHash, String fullName,
                                                String email, Set<Role> roles, Instant now) {
        AppUser user = new AppUser(username, Objects.requireNonNull(temporaryPasswordHash), fullName, email,
                requireRoles(roles), now);
        user.passwordChangeRequired = true;
        return user;
    }

    public boolean isLocked() {
        return status == UserStatus.LOCKED;
    }

    public boolean hasRole(Role role) {
        return roles.contains(role);
    }

    /** Changes what an admin edits. */
    public void update(String fullName, String email, Set<Role> roles) {
        this.fullName = fullName;
        this.email = email;
        this.roles = EnumSet.copyOf(requireRoles(roles));
    }

    /** @return false when the user was locked already (nothing changes) */
    public boolean lock(UUID by, Instant now) {
        if (isLocked()) {
            return false;
        }
        status = UserStatus.LOCKED;
        lockedAt = now;
        lockedBy = by;
        return true;
    }

    /** @return false when the user was not locked (nothing changes) */
    public boolean unlock() {
        if (!isLocked()) {
            return false;
        }
        status = UserStatus.ACTIVE;
        lockedAt = null;
        lockedBy = null;
        return true;
    }

    /** An admin gave the user a temporary password: it has to be changed at the next login. */
    public void resetPassword(String temporaryPasswordHash, Instant now) {
        this.passwordHash = Objects.requireNonNull(temporaryPasswordHash);
        this.passwordChangeRequired = true;
        this.passwordChangedAt = now;
    }

    /** The user chose a new password of their own. */
    public void changePassword(String newPasswordHash, Instant now) {
        this.passwordHash = Objects.requireNonNull(newPasswordHash);
        this.passwordChangeRequired = false;
        this.passwordChangedAt = now;
    }

    private static Set<Role> requireRoles(Set<Role> roles) {
        if (roles == null || roles.isEmpty()) {
            throw new IllegalArgumentException("A user has at least one role");
        }
        return roles;
    }
}
