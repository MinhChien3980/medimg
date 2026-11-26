package com.medimg.identity.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import com.medimg.identity.application.AdminUserDtos.CreateUser;
import com.medimg.identity.application.AdminUserDtos.CreatedUser;
import com.medimg.identity.application.AdminUserDtos.UpdateUser;
import com.medimg.identity.domain.AppUser;
import com.medimg.identity.domain.PasswordPolicy;
import com.medimg.identity.domain.RefreshToken.RevokedReason;
import com.medimg.identity.domain.Role;
import com.medimg.identity.infrastructure.AppUserRepository;
import com.medimg.identity.infrastructure.RefreshTokenRepository;
import com.medimg.shared.audit.AuditEvent;
import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.web.ApiException;

class UserAdminServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-26T08:00:00Z");

    private final AppUserRepository users = mock(AppUserRepository.class);
    private final RefreshTokenRepository tokens = mock(RefreshTokenRepository.class);
    private final PasswordEncoder encoder = mock(PasswordEncoder.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private final UserAdminService service = new UserAdminService(users, tokens, encoder, events,
            Clock.fixed(NOW, ZoneOffset.UTC));

    private final AppUser actor = user("boss", Role.ADMIN);

    @BeforeEach
    void setUp() {
        Jwt jwt = Jwt.withTokenValue("t").header("alg", "none").subject(actor.getId().toString())
                .claim("preferred_username", "boss").build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));
        when(encoder.encode(anyString())).thenAnswer(i -> "bcrypt(" + i.getArgument(0) + ")");
        when(users.saveAndFlush(any())).thenAnswer(i -> i.getArgument(0));
        when(users.findById(actor.getId())).thenReturn(Optional.of(actor));
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    private AppUser user(String name, Role... roles) {
        AppUser u = new AppUser(name, "hash", name, null, Set.of(roles), NOW);
        when(users.findById(u.getId())).thenReturn(Optional.of(u));
        return u;
    }

    private static void assertProblem(Throwable e, HttpStatus status, String type) {
        assertThat(e).isInstanceOf(ApiException.class);
        ApiException api = (ApiException) e;
        assertThat(api.getStatusCode()).isEqualTo(status);
        assertThat(api.getBody().getType().toString()).isEqualTo("/problems/" + type);
    }

    private AuditEvent lastAudit() {
        ArgumentCaptor<AuditEvent> captor = ArgumentCaptor.forClass(AuditEvent.class);
        verify(events, org.mockito.Mockito.atLeastOnce()).publishEvent(captor.capture());
        return captor.getValue();
    }

    // --- create ------------------------------------------------------------------------------------------------------

    @Test
    void createStoresALowerCaseNameAndOnlyTheHashOfAPolicyCompliantTemporaryPassword() {
        CreatedUser created = service.create(new CreateUser("  New.User ", " New User ", " ", Set.of(Role.DOCTOR)));

        assertThat(created.user().username()).isEqualTo("new.user");
        assertThat(created.user().fullName()).isEqualTo("New User");
        assertThat(created.user().email()).isNull();
        assertThat(created.user().passwordChangeRequired()).isTrue();
        assertThat(created.user().status()).isEqualTo("ACTIVE");
        assertThat(PasswordPolicy.check(created.temporaryPassword(), "new.user")).isEmpty();
        ArgumentCaptor<AppUser> saved = ArgumentCaptor.forClass(AppUser.class);
        verify(users).saveAndFlush(saved.capture());
        assertThat(saved.getValue().getPasswordHash()).isEqualTo("bcrypt(" + created.temporaryPassword() + ")");

        AuditEvent audit = lastAudit();
        assertThat(audit.action()).isEqualTo("USER_CREATED");
        assertThat(audit.outcome()).isEqualTo(Outcome.SUCCESS);
        assertThat(audit.detail()).isEqualTo(Map.of("username", "new.user", "roles", List.of("DOCTOR")));
        assertThat(audit.toString()).doesNotContain(created.temporaryPassword());
    }

    @Test
    void createRefusesAUsernameTakenInAnyCase() {
        when(users.existsByUsernameIgnoreCase("doctor")).thenReturn(true);
        assertThatThrownBy(() -> service.create(new CreateUser("DOCTOR", "X", null, Set.of(Role.DOCTOR))))
                .satisfies(e -> assertProblem(e, HttpStatus.CONFLICT, "username-taken"));
        verify(users, never()).saveAndFlush(any());
    }

    @Test
    void createTurnsAConcurrentDuplicateIntoAConflict() {
        when(users.saveAndFlush(any())).thenThrow(new DataIntegrityViolationException("uq_app_user_username_lower"));
        assertThatThrownBy(() -> service.create(new CreateUser("twin", "Twin", null, Set.of(Role.DOCTOR))))
                .satisfies(e -> assertProblem(e, HttpStatus.CONFLICT, "username-taken"));
    }

    @Test
    void createRequiresARole() {
        assertThatThrownBy(() -> service.create(new CreateUser("norole", "X", null, Set.of())))
                .isInstanceOf(ApiException.class).hasMessageContaining("role");
    }

    // --- lock / unlock -----------------------------------------------------------------------------------------------

    @Test
    void anAdminCannotLockThemself() {
        assertThatThrownBy(() -> service.lock(actor.getId()))
                .satisfies(e -> assertProblem(e, HttpStatus.UNPROCESSABLE_CONTENT, "self-lock"));
        assertThat(actor.isLocked()).isFalse();
        assertThat(lastAudit().outcome()).isEqualTo(Outcome.FAILURE);
        assertThat(lastAudit().detail()).containsEntry("reason", "self_lock");
    }

    @Test
    void theLastActiveAdminCannotBeLocked() {
        AppUser other = user("other-admin", Role.ADMIN);
        when(users.lockActiveAdmins()).thenReturn(List.of(other.getId()));

        assertThatThrownBy(() -> service.lock(other.getId()))
                .satisfies(e -> assertProblem(e, HttpStatus.CONFLICT, "last-admin"));
        assertThat(other.isLocked()).isFalse();
        verify(tokens, never()).revokeAllForUser(any(), any(), any());
        assertThat(lastAudit().detail()).containsEntry("reason", "last_admin");
    }

    @Test
    void anAdminIsLockedWhenAnotherAdminStaysActiveAndAllTheirSessionsAreRevoked() {
        AppUser other = user("other-admin", Role.ADMIN);
        when(users.lockActiveAdmins()).thenReturn(List.of(other.getId(), actor.getId()));
        when(tokens.revokeAllForUser(other.getId(), NOW, RevokedReason.LOCKED)).thenReturn(2);

        var dto = service.lock(other.getId());

        assertThat(dto.status()).isEqualTo("LOCKED");
        assertThat(dto.lockedAt()).isEqualTo(NOW);
        assertThat(other.getLockedBy()).isEqualTo(actor.getId());
        verify(tokens).revokeAllForUser(other.getId(), NOW, RevokedReason.LOCKED);
        assertThat(lastAudit().action()).isEqualTo("USER_LOCKED");
        assertThat(lastAudit().detail()).containsEntry("sessionsRevoked", 2);
    }

    @Test
    void lockingANonAdminDoesNotLookAtTheAdmins() {
        AppUser doctor = user("doc", Role.DOCTOR);
        service.lock(doctor.getId());
        assertThat(doctor.isLocked()).isTrue();
        verify(users, never()).lockActiveAdmins();
    }

    @Test
    void lockingALockedUserChangesNothing() {
        AppUser doctor = user("doc", Role.DOCTOR);
        doctor.lock(UUID.randomUUID(), NOW.minusSeconds(60));

        assertThat(service.lock(doctor.getId()).lockedAt()).isEqualTo(NOW.minusSeconds(60));
        verify(users, never()).saveAndFlush(any());
        verify(tokens, never()).revokeAllForUser(any(), any(), any());
        verify(events, never()).publishEvent(any(Object.class));
    }

    @Test
    void unlockReactivatesAndUnlockingAnActiveUserChangesNothing() {
        AppUser doctor = user("doc", Role.DOCTOR);
        service.unlock(doctor.getId());
        verify(events, never()).publishEvent(any(Object.class));

        doctor.lock(actor.getId(), NOW);
        assertThat(service.unlock(doctor.getId()).status()).isEqualTo("ACTIVE");
        assertThat(lastAudit().action()).isEqualTo("USER_UNLOCKED");
    }

    @Test
    void unknownUserIsNotFound() {
        UUID id = UUID.randomUUID();
        assertThatThrownBy(() -> service.lock(id)).satisfies(e ->
                assertThat(((ApiException) e).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    // --- update ------------------------------------------------------------------------------------------------------

    @Test
    void anAdminCannotRemoveTheirOwnAdminRole() {
        assertThatThrownBy(() -> service.update(actor.getId(), new UpdateUser("Boss", null, Set.of(Role.DOCTOR), 0)))
                .satisfies(e -> assertProblem(e, HttpStatus.UNPROCESSABLE_CONTENT, "self-demote"));
        assertThat(actor.hasRole(Role.ADMIN)).isTrue();
    }

    @Test
    void anAdminMayEditTheirOwnNameKeepingTheAdminRole() {
        var dto = service.update(actor.getId(), new UpdateUser("The Boss", null, Set.of(Role.ADMIN, Role.DOCTOR), 0));
        assertThat(dto.fullName()).isEqualTo("The Boss");
        assertThat(dto.roles()).containsExactly("ADMIN", "DOCTOR");
    }

    @Test
    void theLastActiveAdminCannotBeDemoted() {
        AppUser other = user("other-admin", Role.ADMIN);
        when(users.lockActiveAdmins()).thenReturn(List.of(other.getId()));

        assertThatThrownBy(() -> service.update(other.getId(), new UpdateUser("x", null, Set.of(Role.DOCTOR), 0)))
                .satisfies(e -> assertProblem(e, HttpStatus.CONFLICT, "last-admin"));
        assertThat(other.hasRole(Role.ADMIN)).isTrue();
    }

    @Test
    void aLockedAdminCanBeDemotedWithoutLookingAtTheOthers() {
        AppUser other = user("other-admin", Role.ADMIN);
        other.lock(actor.getId(), NOW);
        service.update(other.getId(), new UpdateUser("x", null, Set.of(Role.DOCTOR), other.getVersion()));
        assertThat(other.hasRole(Role.ADMIN)).isFalse();
        verify(users, never()).lockActiveAdmins();
    }

    @Test
    void aStaleVersionIsRefused() {
        AppUser doctor = user("doc", Role.DOCTOR);
        assertThatThrownBy(() -> service.update(doctor.getId(), new UpdateUser("x", null, Set.of(Role.DOCTOR), 7)))
                .isInstanceOf(OptimisticLockingFailureException.class);
    }

    @Test
    void anUpdateAuditsTheRoleDiffButNotTheValues() {
        AppUser doctor = user("doc", Role.DOCTOR, Role.RESEARCHER);
        service.update(doctor.getId(), new UpdateUser("doc", "doc@example.org", Set.of(Role.DOCTOR, Role.TECHNICIAN), 0));

        AuditEvent audit = lastAudit();
        assertThat(audit.action()).isEqualTo("USER_UPDATED");
        assertThat(audit.detail()).containsEntry("rolesAdded", List.of("TECHNICIAN"))
                .containsEntry("rolesRemoved", List.of("RESEARCHER"))
                .containsEntry("fullNameChanged", false)
                .containsEntry("emailChanged", true);
        assertThat(audit.toString()).doesNotContain("doc@example.org");
    }

    @Test
    void anUpdateThatChangesNothingIsNeitherSavedNorAudited() {
        AppUser doctor = user("doc", Role.DOCTOR);
        service.update(doctor.getId(), new UpdateUser(" doc ", "", Set.of(Role.DOCTOR), 0));
        verify(users, never()).saveAndFlush(any());
        verify(events, never()).publishEvent(any(Object.class));
    }

    // --- reset password ----------------------------------------------------------------------------------------------

    @Test
    void resetGivesANewTemporaryPasswordRequiresAChangeAndRevokesAllSessions() {
        AppUser doctor = user("doc", Role.DOCTOR);
        var result = service.resetPassword(doctor.getId());

        assertThat(PasswordPolicy.check(result.temporaryPassword(), "doc")).isEmpty();
        assertThat(doctor.getPasswordHash()).isEqualTo("bcrypt(" + result.temporaryPassword() + ")");
        assertThat(doctor.isPasswordChangeRequired()).isTrue();
        verify(tokens).revokeAllForUser(doctor.getId(), NOW, RevokedReason.PASSWORD_RESET);
        assertThat(lastAudit().action()).isEqualTo("USER_PASSWORD_RESET");
        assertThat(lastAudit().toString()).doesNotContain(result.temporaryPassword());
    }

    @Test
    void anAdminCannotResetTheirOwnPassword() {
        assertThatThrownBy(() -> service.resetPassword(actor.getId()))
                .satisfies(e -> assertProblem(e, HttpStatus.UNPROCESSABLE_CONTENT, "self-reset"));
        verify(tokens, never()).revokeAllForUser(eq(actor.getId()), any(), any());
    }

    // --- search ------------------------------------------------------------------------------------------------------

    @Test
    void searchTextIsALiteralCaseInsensitiveSubstring() {
        assertThat(UserAdminService.likePattern(null)).isNull();
        assertThat(UserAdminService.likePattern("   ")).isNull();
        assertThat(UserAdminService.likePattern(" DoC ")).isEqualTo("%doc%");
        assertThat(UserAdminService.likePattern("50%_a!b")).isEqualTo("%50!%!_a!!b%");
    }
}
