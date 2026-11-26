package com.medimg.identity.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import com.medimg.identity.domain.AppUser;
import com.medimg.identity.domain.RefreshToken;
import com.medimg.identity.domain.RefreshToken.RevokedReason;
import com.medimg.identity.domain.Role;
import com.medimg.identity.infrastructure.AppUserRepository;
import com.medimg.identity.infrastructure.AppUserRepository.AccountState;
import com.medimg.identity.infrastructure.RefreshTokenRepository;
import com.medimg.shared.audit.AuditEvent;
import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.security.JwtProperties;
import com.medimg.shared.web.ApiException;

class AuthServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-26T08:00:00Z");

    private final AppUserRepository users = mock(AppUserRepository.class);
    private final RefreshTokenRepository tokens = mock(RefreshTokenRepository.class);
    private final PasswordEncoder encoder = mock(PasswordEncoder.class);
    private final JwtEncoder jwtEncoder = mock(JwtEncoder.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private AuthService service;

    private AppUser user;

    @BeforeEach
    void setUp() {
        when(encoder.encode(anyString())).thenAnswer(i -> "bcrypt(" + i.getArgument(0) + ")");
        when(encoder.matches(anyString(), anyString()))
                .thenAnswer(i -> ("bcrypt(" + i.getArgument(0) + ")").equals(i.getArgument(1)));
        when(jwtEncoder.encode(any(JwtEncoderParameters.class))).thenAnswer(i -> Jwt.withTokenValue("access")
                .header("alg", "RS256").claims(c -> c.putAll(((JwtEncoderParameters) i.getArgument(0)).getClaims().getClaims()))
                .build());
        when(tokens.save(any())).thenAnswer(i -> i.getArgument(0));
        service = new AuthService(users, tokens, encoder, jwtEncoder,
                new JwtProperties("medimg-core", Duration.ofMinutes(15), Duration.ofDays(7), null, null), events,
                Clock.fixed(NOW, ZoneOffset.UTC));

        user = new AppUser("doctor", "bcrypt(Old-password-1)", "Doctor", null, Set.of(Role.DOCTOR), NOW);
        when(users.findByUsernameIgnoreCase("doctor")).thenReturn(Optional.of(user));
        when(users.findById(user.getId())).thenReturn(Optional.of(user));
        when(users.saveAndFlush(any())).thenAnswer(i -> i.getArgument(0));
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    private void authenticate(UUID sessionId) {
        Jwt.Builder jwt = Jwt.withTokenValue("t").header("alg", "none").subject(user.getId().toString());
        if (sessionId != null) {
            jwt.claim("sid", sessionId.toString());
        }
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt.build()));
    }

    private AuditEvent lastAudit() {
        ArgumentCaptor<AuditEvent> captor = ArgumentCaptor.forClass(AuditEvent.class);
        verify(events, org.mockito.Mockito.atLeastOnce()).publishEvent(captor.capture());
        return captor.getValue();
    }

    private static void assertProblem(Throwable e, HttpStatus status, String type) {
        ApiException api = (ApiException) e;
        assertThat(api.getStatusCode()).isEqualTo(status);
        assertThat(api.getBody().getType().toString()).isEqualTo("/problems/" + type);
    }

    // --- login -------------------------------------------------------------------------------------------------------

    @Test
    void loginIssuesATokenNamingItsSessionAndRecordsTheLoginWithoutTouchingTheVersion() {
        TokenResponse response = service.login("doctor", "Old-password-1");

        ArgumentCaptor<RefreshToken> session = ArgumentCaptor.forClass(RefreshToken.class);
        verify(tokens).save(session.capture());
        ArgumentCaptor<JwtEncoderParameters> params = ArgumentCaptor.forClass(JwtEncoderParameters.class);
        verify(jwtEncoder).encode(params.capture());
        assertThat(params.getValue().getClaims().getClaimAsString("sid")).isEqualTo(session.getValue().getId().toString());
        assertThat(response.user().passwordChangeRequired()).isFalse();
        verify(users).recordLogin(user.getId(), NOW);
        verify(users, never()).saveAndFlush(any());
    }

    @Test
    void aLockedUserGetsTheAnswerOfWrongCredentialsAndTheAuditTellsWhy() {
        user.lock(UUID.randomUUID(), NOW);

        Throwable locked = org.assertj.core.api.Assertions.catchThrowable(() -> service.login("doctor", "Old-password-1"));
        Throwable wrong = org.assertj.core.api.Assertions.catchThrowable(() -> service.login("nobody", "whatever"));

        assertThat(((ApiException) locked).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(((ApiException) locked).getBody()).isEqualTo(((ApiException) wrong).getBody());
        verify(tokens, never()).save(any());
        ArgumentCaptor<AuditEvent> captor = ArgumentCaptor.forClass(AuditEvent.class);
        verify(events, org.mockito.Mockito.times(2)).publishEvent(captor.capture());
        assertThat(captor.getAllValues()).extracting(e -> e.detail().get("reason")).containsExactly("locked", "unknown_user");
        assertThat(captor.getAllValues().getFirst().action()).isEqualTo("LOGIN_FAILED");
    }

    @Test
    void aWrongPasswordIsAuditedAsSuch() {
        assertThatThrownBy(() -> service.login("doctor", "nope")).isInstanceOf(ApiException.class);
        assertThat(lastAudit().detail()).containsEntry("reason", "bad_password");
    }

    @Test
    void aPasswordLongerThanBcryptAcceptsNeverMatches() {
        String longPassword = "x".repeat(73);
        user.changePassword("bcrypt(" + longPassword + ")", NOW);
        assertThatThrownBy(() -> service.login("doctor", longPassword)).isInstanceOf(ApiException.class);
    }

    @Test
    void loginWithATemporaryPasswordStillIssuesTokensAndSaysAChangeIsRequired() {
        user.resetPassword("bcrypt(Temp-pass-2026)", NOW);
        assertThat(service.login("doctor", "Temp-pass-2026").user().passwordChangeRequired()).isTrue();
    }

    // --- refresh -----------------------------------------------------------------------------------------------------

    private RefreshToken stored(String raw) {
        RefreshToken t = new RefreshToken(user.getId(), AuthService.sha256(raw), NOW.plusSeconds(3600), NOW.minusSeconds(60));
        when(tokens.findByTokenHash(AuthService.sha256(raw))).thenReturn(Optional.of(t));
        return t;
    }

    @Test
    void refreshRotatesTheToken() {
        RefreshToken t = stored("r1");
        service.refresh("r1");
        assertThat(t.getRevokedReason()).isEqualTo(RevokedReason.ROTATED);
    }

    @Test
    void aLockedUserCannotRefreshAndThatIsNotTakenForTheft() {
        RefreshToken t = stored("r1");
        user.lock(UUID.randomUUID(), NOW);
        assertThatThrownBy(() -> service.refresh("r1")).satisfies(e ->
                assertThat(((ApiException) e).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));
        assertThat(t.getRevokedReason()).isEqualTo(RevokedReason.LOCKED);
        verify(tokens, never()).revokeAllForUser(any(), any(), any());
        verify(tokens, never()).save(any());
    }

    @Test
    void replayingARotatedTokenRevokesEverySession() {
        RefreshToken t = stored("r1");
        t.revoke(NOW.minusSeconds(10), RevokedReason.ROTATED);
        assertThatThrownBy(() -> service.refresh("r1")).isInstanceOf(ApiException.class);
        verify(tokens).revokeAllForUser(user.getId(), NOW, RevokedReason.REUSE_DETECTED);
        assertThat(lastAudit().action()).isEqualTo("REFRESH_TOKEN_REUSE");
    }

    @Test
    void aTokenRevokedByAPasswordChangeIsRefusedWithoutRevokingTheOtherSessions() {
        RefreshToken t = stored("r1");
        t.revoke(NOW.minusSeconds(10), RevokedReason.PASSWORD_CHANGED);
        assertThatThrownBy(() -> service.refresh("r1")).hasMessage("Refresh token revoked");
        verify(tokens, never()).revokeAllForUser(any(), any(), any());
    }

    @Test
    void anExpiredTokenIsRefused() {
        RefreshToken t = new RefreshToken(user.getId(), AuthService.sha256("old"), NOW.minusSeconds(1), NOW.minusSeconds(99));
        when(tokens.findByTokenHash(AuthService.sha256("old"))).thenReturn(Optional.of(t));
        assertThatThrownBy(() -> service.refresh("old")).hasMessage("Refresh token expired");
    }

    @Test
    void logoutRevokesTheTokenAsLoggedOut() {
        RefreshToken t = stored("r1");
        service.logout("r1");
        assertThat(t.getRevokedReason()).isEqualTo(RevokedReason.LOGOUT);
    }

    // --- access ------------------------------------------------------------------------------------------------------

    private static AccountState state(String status, boolean changeRequired) {
        return new AccountState() {
            @Override
            public String getStatus() {
                return status;
            }

            @Override
            public boolean getPasswordChangeRequired() {
                return changeRequired;
            }
        };
    }

    @Test
    void accessFollowsTheCurrentStateOfTheAccount() {
        UUID id = UUID.randomUUID();
        when(users.findAccountState(id)).thenReturn(Optional.of(state("ACTIVE", false)));
        assertThat(service.access(id)).isEqualTo(AccountAccess.FULL);
        when(users.findAccountState(id)).thenReturn(Optional.of(state("ACTIVE", true)));
        assertThat(service.access(id)).isEqualTo(AccountAccess.PASSWORD_CHANGE_ONLY);
        when(users.findAccountState(id)).thenReturn(Optional.of(state("LOCKED", true)));
        assertThat(service.access(id)).isEqualTo(AccountAccess.NONE);
        when(users.findAccountState(id)).thenReturn(Optional.empty());
        assertThat(service.access(id)).isEqualTo(AccountAccess.NONE);
    }

    // --- change password ---------------------------------------------------------------------------------------------

    @Test
    void aWrongCurrentPasswordIsA422NotA401() {
        authenticate(null);
        assertThatThrownBy(() -> service.changePassword(user.getId(), "wrong", "Brand-new-pass-1"))
                .satisfies(e -> assertProblem(e, HttpStatus.UNPROCESSABLE_CONTENT, "wrong-current-password"));
        assertThat(user.getPasswordHash()).isEqualTo("bcrypt(Old-password-1)");
        assertThat(lastAudit().outcome()).isEqualTo(Outcome.FAILURE);
        assertThat(lastAudit().detail()).containsEntry("reason", "wrong_current_password");
    }

    @Test
    void theNewPasswordMustMeetThePolicyAndEveryBrokenRuleIsListed() {
        authenticate(null);
        assertThatThrownBy(() -> service.changePassword(user.getId(), "Old-password-1", "doctor"))
                .satisfies(e -> {
                    assertProblem(e, HttpStatus.UNPROCESSABLE_CONTENT, "password-policy");
                    assertThat(((ApiException) e).getBody().getProperties())
                            .containsEntry("violations", List.of("TOO_SHORT", "NO_DIGIT", "CONTAINS_USERNAME"));
                });
        assertThat(lastAudit().toString()).doesNotContain("Old-password-1");
    }

    @Test
    void theNewPasswordMustDifferFromTheCurrentOne() {
        authenticate(null);
        assertThatThrownBy(() -> service.changePassword(user.getId(), "Old-password-1", "Old-password-1"))
                .satisfies(e -> assertThat(((ApiException) e).getBody().getProperties())
                        .containsEntry("violations", List.of("SAME_AS_CURRENT")));
    }

    @Test
    void aChangeKeepsTheCurrentSessionAndRevokesTheOthers() {
        UUID sid = UUID.randomUUID();
        authenticate(sid);
        user.resetPassword("bcrypt(Old-password-1)", NOW.minusSeconds(60));
        when(tokens.revokeOthersForUser(user.getId(), sid, NOW, RevokedReason.PASSWORD_CHANGED)).thenReturn(3);

        service.changePassword(user.getId(), "Old-password-1", "Brand-new-pass-1");

        assertThat(user.getPasswordHash()).isEqualTo("bcrypt(Brand-new-pass-1)");
        assertThat(user.isPasswordChangeRequired()).isFalse();
        verify(tokens, never()).revokeAllForUser(any(), any(), any());
        AuditEvent audit = lastAudit();
        assertThat(audit.action()).isEqualTo("PASSWORD_CHANGED");
        assertThat(audit.outcome()).isEqualTo(Outcome.SUCCESS);
        assertThat(audit.detail()).containsEntry("otherSessionsRevoked", 3);
        assertThat(audit.toString()).doesNotContain("Brand-new-pass-1").doesNotContain("bcrypt");
    }

    @Test
    void withoutASessionIdEverySessionIsRevoked() {
        authenticate(null);
        service.changePassword(user.getId(), "Old-password-1", "Brand-new-pass-1");
        verify(tokens).revokeAllForUser(user.getId(), NOW, RevokedReason.PASSWORD_CHANGED);
    }
}
