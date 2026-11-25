package com.medimg.identity.application;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
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
import com.medimg.identity.domain.RefreshToken;
import com.medimg.identity.infrastructure.AppUserRepository;
import com.medimg.identity.infrastructure.RefreshTokenRepository;
import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.audit.AuditEvents;
import com.medimg.shared.security.JwtProperties;
import com.medimg.shared.web.ApiException;

@Service
public class AuthService {

    private static final SecureRandom RANDOM = new SecureRandom();

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

    @Transactional
    public TokenResponse login(String username, String password) {
        AppUser user = users.findByUsernameIgnoreCase(username).orElse(null);
        boolean ok = passwordEncoder.matches(password, user == null ? dummyHash : user.getPasswordHash());
        if (user == null || !ok) {
            events.publishEvent(AuditEvents.of("LOGIN_FAILED", "USER", user == null ? null : user.getId(),
                    Outcome.FAILURE, user == null ? null : user.getId(), username,
                    Map.of("reason", user == null ? "unknown_user" : "bad_password")));
            throw ApiException.unauthorized("Invalid username or password");
        }
        Instant now = clock.instant();
        user.recordLogin(now);
        events.publishEvent(AuditEvents.of("LOGIN", "USER", user.getId(), Outcome.SUCCESS, user.getId(), user.getUsername(), null));
        return issue(user, now);
    }

    /** Rotates the refresh token. Re-use of an already rotated token revokes every session of the user. */
    @Transactional(noRollbackFor = ApiException.class)
    public TokenResponse refresh(String rawRefreshToken) {
        Instant now = clock.instant();
        RefreshToken token = refreshTokens.findByTokenHash(sha256(rawRefreshToken))
                .orElseThrow(() -> ApiException.unauthorized("Invalid refresh token"));
        if (token.isRevoked()) {
            refreshTokens.revokeAllForUser(token.getUserId(), now);
            events.publishEvent(AuditEvents.of("REFRESH_TOKEN_REUSE", "USER", token.getUserId(), Outcome.FAILURE,
                    token.getUserId(), null, null));
            throw ApiException.unauthorized("Refresh token already used");
        }
        if (token.isExpired(now)) {
            throw ApiException.unauthorized("Refresh token expired");
        }
        AppUser user = users.findById(token.getUserId())
                .orElseThrow(() -> ApiException.unauthorized("Invalid refresh token"));
        token.revoke(now);
        return issue(user, now);
    }

    /**
     * Revokes a refresh token. The token itself is the credential, so no access token is needed (it has often
     * expired by the time the user logs out). Unknown tokens are ignored.
     */
    @Transactional
    public void logout(String rawRefreshToken) {
        refreshTokens.findByTokenHash(sha256(rawRefreshToken)).ifPresent(token -> {
            token.revoke(clock.instant());
            String username = users.findById(token.getUserId()).map(AppUser::getUsername).orElse(null);
            events.publishEvent(AuditEvents.of("LOGOUT", "USER", token.getUserId(), Outcome.SUCCESS,
                    token.getUserId(), username, null));
        });
    }

    @Transactional(readOnly = true)
    public UserDto me(UUID userId) {
        return users.findById(userId).map(UserDto::from).orElseThrow(() -> ApiException.notFound("User", userId));
    }

    private TokenResponse issue(AppUser user, Instant now) {
        UserDto dto = UserDto.from(user);
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(props.issuer())
                .subject(user.getId().toString())
                .issuedAt(now)
                .expiresAt(now.plus(props.accessTokenTtl()))
                .claim("preferred_username", user.getUsername())
                .claim("roles", dto.roles())
                .build();
        JwsHeader header = JwsHeader.with(SignatureAlgorithm.RS256).build();
        String access = jwtEncoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();

        byte[] raw = new byte[32];
        RANDOM.nextBytes(raw);
        String refresh = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        refreshTokens.save(new RefreshToken(user.getId(), sha256(refresh), now.plus(props.refreshTokenTtl()), now));

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
