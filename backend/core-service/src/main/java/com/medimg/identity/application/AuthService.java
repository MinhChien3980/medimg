package com.medimg.identity.application;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.identity.domain.AppUser;
import com.medimg.identity.domain.PasswordPolicy;
import com.medimg.identity.domain.PasswordPolicy.Violation;
import com.medimg.identity.domain.RefreshToken;
import com.medimg.identity.domain.RefreshToken.RevokedReason;
import com.medimg.identity.domain.UserStatus;
import com.medimg.identity.infrastructure.AppUserRepository;
import com.medimg.identity.infrastructure.RefreshTokenRepository;
import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.audit.AuditEvents;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.security.JwtProperties;
import com.medimg.shared.web.ApiException;

@Service
public class AuthService {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String INVALID_CREDENTIALS = "Invalid username or password";

    private final AppUserRepository users;
    private final RefreshTokenRepository refreshTokens;
    private final PasswordEncoder passwordEncoder;
    private final JwtEncoder jwtEncoder;
    private final JwtProperties props;
    private final ApplicationEventPublisher events;
    private final Clock clock;
    /** Defence against username enumeration by timing: unknown users still cost one BCrypt check. */
    private final String dummyHash;

    AuthService(AppUserRepository users, RefreshTokenRepository refreshTokens, PasswordEncoder passwordEncoder,
                JwtEncoder jwtEncoder, JwtProperties props, ApplicationEventPublisher events, Clock clock) {
        this.users = users;
        this.refreshTokens = refreshTokens;
        this.passwordEncoder = passwordEncoder;
        this.jwtEncoder = jwtEncoder;
        this.props = props;
        this.events = events;
        this.clock = clock;
        this.dummyHash = passwordEncoder.encode(UUID.randomUUID().toString());
    }

    /**
     * A locked account gets the same answer as wrong credentials, so that the response does not tell whether an
     * account exists or is locked; the audit log records the real reason.
     */
    @Transactional
    public TokenResponse login(String username, String password) {
        AppUser user = users.findByUsernameIgnoreCase(username).orElse(null);
        boolean ok = matches(password, user == null ? dummyHash : user.getPasswordHash());
        if (user == null || !ok || user.isLocked()) {
            String reason = user == null ? "unknown_user" : user.isLocked() ? "locked" : "bad_password";
            events.publishEvent(AuditEvents.of("LOGIN_FAILED", "USER", user == null ? null : user.getId(),
                    Outcome.FAILURE, user == null ? null : user.getId(), username, Map.of("reason", reason)));
            throw ApiException.unauthorized(INVALID_CREDENTIALS);
        }
        Instant now = clock.instant();
        users.recordLogin(user.getId(), now);
        events.publishEvent(AuditEvents.of("LOGIN", "USER", user.getId(), Outcome.SUCCESS, user.getId(), user.getUsername(), null));
        return issue(user, now);
    }

    /**
     * Rotates the refresh token. Re-use of an already rotated token revokes every session of the user; a token revoked
     * for another reason (logout, lock, password reset or change) is just refused, as is any token of a locked user.
     */
    @Transactional(noRollbackFor = ApiException.class)
    public TokenResponse refresh(String rawRefreshToken) {
        Instant now = clock.instant();
        RefreshToken token = refreshTokens.findByTokenHash(sha256(rawRefreshToken))
                .orElseThrow(() -> ApiException.unauthorized("Invalid refresh token"));
        AppUser user = users.findById(token.getUserId())
                .orElseThrow(() -> ApiException.unauthorized("Invalid refresh token"));
        if (user.isLocked()) {
            token.revoke(now, RevokedReason.LOCKED);
            throw ApiException.unauthorized("Invalid refresh token");
        }
        if (token.wasRotated()) {
            refreshTokens.revokeAllForUser(token.getUserId(), now, RevokedReason.REUSE_DETECTED);
            events.publishEvent(AuditEvents.of("REFRESH_TOKEN_REUSE", "USER", token.getUserId(), Outcome.FAILURE,
                    token.getUserId(), user.getUsername(), null));
            throw ApiException.unauthorized("Refresh token already used");
        }
        if (token.isRevoked()) {
            throw ApiException.unauthorized("Refresh token revoked");
        }
        if (token.isExpired(now)) {
            throw ApiException.unauthorized("Refresh token expired");
        }
        token.revoke(now, RevokedReason.ROTATED);
        return issue(user, now);
    }

    /**
     * Revokes a refresh token. The token itself is the credential, so no access token is needed (it has often
     * expired by the time the user logs out). Unknown tokens are ignored.
     */
    @Transactional
    public void logout(String rawRefreshToken) {
        refreshTokens.findByTokenHash(sha256(rawRefreshToken)).ifPresent(token -> {
            token.revoke(clock.instant(), RevokedReason.LOGOUT);
            String username = users.findById(token.getUserId()).map(AppUser::getUsername).orElse(null);
            events.publishEvent(AuditEvents.of("LOGOUT", "USER", token.getUserId(), Outcome.SUCCESS,
                    token.getUserId(), username, null));
        });
    }

    @Transactional(readOnly = true)
    public UserDto me(UUID userId) {
        return users.findById(userId).map(UserDto::from).orElseThrow(() -> ApiException.notFound("User", userId));
    }

    /** Checked on every request made with an access token: a lock or a password reset applies at once. */
    @Transactional(readOnly = true)
    public AccountAccess access(UUID userId) {
        return users.findAccountState(userId)
                .map(s -> UserStatus.LOCKED.name().equals(s.getStatus()) ? AccountAccess.NONE
                        : s.getPasswordChangeRequired() ? AccountAccess.PASSWORD_CHANGE_ONLY : AccountAccess.FULL)
                .orElse(AccountAccess.NONE);
    }

    /**
     * The user sets a password of their own (see {@link PasswordPolicy}; it must also differ from the current one).
     * A wrong current password is a 422, not a 401, so that the client does not take it for an expired session. The
     * session the request comes from stays logged in; every other session of the user is revoked.
     */
    @Transactional(noRollbackFor = ApiException.class)
    public void changePassword(UUID userId, String currentPassword, String newPassword) {
        AppUser user = users.findById(userId).orElseThrow(() -> ApiException.notFound("User", userId));
        if (!matches(currentPassword, user.getPasswordHash())) {
            auditPasswordChange(user, Outcome.FAILURE, Map.of("reason", "wrong_current_password"));
            throw ApiException.unprocessable("The current password is wrong").type("wrong-current-password");
        }
        List<Violation> violations = new ArrayList<>(PasswordPolicy.check(newPassword, user.getUsername()));
        if (!violations.contains(Violation.TOO_LONG) && passwordEncoder.matches(newPassword, user.getPasswordHash())) {
            violations.add(Violation.SAME_AS_CURRENT);
        }
        if (!violations.isEmpty()) {
            List<String> codes = violations.stream().map(Enum::name).toList();
            auditPasswordChange(user, Outcome.FAILURE, Map.of("reason", "policy", "violations", codes));
            throw ApiException.unprocessable("The new password does not meet the password policy")
                    .type("password-policy").property("violations", codes);
        }
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        user.changePassword(passwordEncoder.encode(newPassword), now);
        users.saveAndFlush(user);
        int revoked = CurrentUser.sessionId()
                .map(sid -> refreshTokens.revokeOthersForUser(userId, sid, now, RevokedReason.PASSWORD_CHANGED))
                .orElseGet(() -> refreshTokens.revokeAllForUser(userId, now, RevokedReason.PASSWORD_CHANGED));
        auditPasswordChange(user, Outcome.SUCCESS, Map.of("otherSessionsRevoked", revoked));
    }

    private void auditPasswordChange(AppUser user, Outcome outcome, Map<String, Object> detail) {
        events.publishEvent(AuditEvents.of("PASSWORD_CHANGED", "USER", user.getId(), outcome, user.getId(),
                user.getUsername(), detail));
    }

    /** BCrypt only looks at the first 72 bytes, and longer input is refused by the encoder: it never matches. */
    private boolean matches(String raw, String hash) {
        if (raw == null || raw.getBytes(StandardCharsets.UTF_8).length > PasswordPolicy.MAX_BYTES) {
            passwordEncoder.matches("", hash); // same cost as a real check
            return false;
        }
        return passwordEncoder.matches(raw, hash);
    }

    private TokenResponse issue(AppUser user, Instant now) {
        byte[] raw = new byte[32];
        RANDOM.nextBytes(raw);
        String refresh = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        RefreshToken session = refreshTokens.save(
                new RefreshToken(user.getId(), sha256(refresh), now.plus(props.refreshTokenTtl()), now));

        UserDto dto = UserDto.from(user);
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(props.issuer())
                .subject(user.getId().toString())
                .issuedAt(now)
                .expiresAt(now.plus(props.accessTokenTtl()))
                .claim("preferred_username", user.getUsername())
                .claim("roles", dto.roles())
                .claim(CurrentUser.SESSION_CLAIM, session.getId().toString())
                .build();
        JwsHeader header = JwsHeader.with(SignatureAlgorithm.RS256).build();
        String access = jwtEncoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();
        return new TokenResponse(access, refresh, props.accessTokenTtl().toSeconds(), dto);
    }

    static String sha256(String value) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
