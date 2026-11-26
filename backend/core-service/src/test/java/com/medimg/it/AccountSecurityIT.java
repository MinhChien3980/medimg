package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

/** Temporary passwords, the forced password change, self-service change, locked accounts and their sessions. */
class AccountSecurityIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc;

    private static String type(Response r) {
        return r.body().get("type").asString();
    }

    private static List<String> violations(Response r) {
        List<String> out = new ArrayList<>();
        r.body().get("violations").forEach(v -> out.add(v.asString()));
        return out;
    }

    private Response changePassword(String token, String current, String next) {
        return post("/me/password", token, Map.of("currentPassword", current, "newPassword", next));
    }

    @Test
    void aNewAccountMustChangeItsTemporaryPasswordBeforeUsingTheApplication() {
        String username = uniqueUsername("newbie");
        String temporary = createUser(username, "DOCTOR").get("temporaryPassword").asString();

        Session s = session(username, temporary);
        assertThat(s.user().get("passwordChangeRequired").asBoolean()).isTrue();

        // gated: every API but /me, /me/password and /auth/*
        Response gated = get("/patients", s.accessToken());
        assertThat(gated.status()).isEqualTo(403);
        assertThat(type(gated)).isEqualTo("/problems/password-change-required");
        assertThat(get("/dashboard", s.accessToken()).status()).isEqualTo(403);
        assertThat(post("/patients", s.accessToken(), Map.of()).status()).isEqualTo(403);
        Response me = get("/me", s.accessToken());
        assertThat(me.status()).isEqualTo(200);
        assertThat(me.body().get("passwordChangeRequired").asBoolean()).isTrue();

        // the policy, each rule on its own
        Response wrongCurrent = changePassword(s.accessToken(), "not-the-password-1", "Good-password-123");
        assertThat(wrongCurrent.status()).isEqualTo(422); // not 401: the client must not take it for an expired session
        assertThat(type(wrongCurrent)).isEqualTo("/problems/wrong-current-password");
        Response tooShort = changePassword(s.accessToken(), temporary, "Short-1");
        assertThat(tooShort.status()).isEqualTo(422);
        assertThat(type(tooShort)).isEqualTo("/problems/password-policy");
        assertThat(violations(tooShort)).containsExactly("TOO_SHORT");
        assertThat(violations(changePassword(s.accessToken(), temporary, "no-digits-at-all"))).containsExactly("NO_DIGIT");
        assertThat(violations(changePassword(s.accessToken(), temporary, "1234567890123"))).containsExactly("NO_LETTER");
        assertThat(violations(changePassword(s.accessToken(), temporary, "x-" + username.toUpperCase() + "-2026")))
                .containsExactly("CONTAINS_USERNAME");
        assertThat(violations(changePassword(s.accessToken(), temporary, temporary))).containsExactly("SAME_AS_CURRENT");
        assertThat(changePassword(s.accessToken(), temporary, "").status()).isEqualTo(400);

        assertThat(changePassword(s.accessToken(), temporary, "Good-password-123").status()).isEqualTo(204);

        // the same access token works right away, the session it belongs to goes on
        assertThat(get("/patients", s.accessToken()).status()).isEqualTo(200);
        assertThat(get("/me", s.accessToken()).body().get("passwordChangeRequired").asBoolean()).isFalse();
        Response refreshed = post("/auth/refresh", null, Map.of("refreshToken", s.refreshToken()));
        assertThat(refreshed.status()).isEqualTo(200);
        assertThat(refreshed.body().get("user").get("passwordChangeRequired").asBoolean()).isFalse();

        assertThat(post("/auth/login", null, Map.of("username", username, "password", temporary)).status()).isEqualTo(401);
        assertThat(session(username, "Good-password-123").user().get("passwordChangeRequired").asBoolean()).isFalse();
    }

    @Test
    void changingThePasswordKeepsTheCurrentSessionAndEndsTheOthersWithoutTakingThemForTheft() {
        String username = uniqueUsername("multi");
        Session first = createActiveUser(username, "TECHNICIAN");
        Session second = session(username, OWN_PASSWORD);

        assertThat(changePassword(first.accessToken(), OWN_PASSWORD, "Another-password-9").status()).isEqualTo(204);

        assertThat(post("/auth/refresh", null, Map.of("refreshToken", second.refreshToken())).status()).isEqualTo(401);
        // the refused token of the other session did not revoke the current one
        assertThat(post("/auth/refresh", null, Map.of("refreshToken", first.refreshToken())).status()).isEqualTo(200);
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'PASSWORD_CHANGED' and username = ? and outcome = 'SUCCESS'",
                Long.class, username) == 2); // the first one set the password of the new account
        assertThat(jdbc.queryForObject("select count(*) from audit_log where action = 'REFRESH_TOKEN_REUSE' and username = ?",
                Long.class, username)).isZero();
    }

    @Test
    void aLockedUserIsLoggedOutEverywhereAndCannotLogInUntilUnlocked() {
        String username = uniqueUsername("locked");
        Session s = createActiveUser(username, "DOCTOR");
        String userId = s.user().get("id").asString();
        String admin = login("admin");

        assertThat(post("/admin/users/" + userId + "/lock", admin, null).body().get("status").asString()).isEqualTo("LOCKED");

        // the access token issued before the lock is refused at once, also for /me
        Response withOldToken = get("/patients", s.accessToken());
        assertThat(withOldToken.status()).isEqualTo(401);
        assertThat(type(withOldToken)).isEqualTo("/problems/session-revoked");
        assertThat(get("/me", s.accessToken()).status()).isEqualTo(401);
        // the old refresh token is dead
        assertThat(post("/auth/refresh", null, Map.of("refreshToken", s.refreshToken())).status()).isEqualTo(401);
        // logging in with the right password looks exactly like wrong credentials
        Response locked = post("/auth/login", null, Map.of("username", username, "password", OWN_PASSWORD));
        Response wrong = post("/auth/login", null, Map.of("username", username, "password", "Wrong-password-1"));
        assertThat(locked.status()).isEqualTo(401);
        assertThat(locked.body()).isEqualTo(wrong.body());
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'LOGIN_FAILED' and username = ? and detail ->> 'reason' = 'locked'",
                Long.class, username) == 2);

        post("/admin/users/" + userId + "/unlock", admin, null);
        assertThat(session(username, OWN_PASSWORD).accessToken()).isNotBlank();
        // the sessions ended by the lock stay ended
        assertThat(post("/auth/refresh", null, Map.of("refreshToken", s.refreshToken())).status()).isEqualTo(401);
    }

    @Test
    void aPasswordResetEndsEverySessionAndForcesAChange() {
        String username = uniqueUsername("reset");
        Session s = createActiveUser(username, "DOCTOR");
        String userId = s.user().get("id").asString();

        Response reset = post("/admin/users/" + userId + "/reset-password", login("admin"), null);
        assertThat(reset.status()).isEqualTo(200);
        String temporary = reset.body().get("temporaryPassword").asString();

        assertThat(post("/auth/refresh", null, Map.of("refreshToken", s.refreshToken())).status()).isEqualTo(401);
        // the access token still identifies the user, but the gate applies at once
        assertThat(type(get("/patients", s.accessToken()))).isEqualTo("/problems/password-change-required");
        assertThat(post("/auth/login", null, Map.of("username", username, "password", OWN_PASSWORD)).status()).isEqualTo(401);

        Session afterReset = session(username, temporary);
        assertThat(afterReset.user().get("passwordChangeRequired").asBoolean()).isTrue();
        assertThat(changePassword(afterReset.accessToken(), temporary, "Fresh-password-77").status()).isEqualTo(204);
        assertThat(get("/patients", afterReset.accessToken()).status()).isEqualTo(200);

        // neither the temporary nor the chosen password is ever written to the audit log
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'PASSWORD_CHANGED' and username = ? and outcome = 'SUCCESS'",
                Long.class, username) == 2);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where detail::text like ? or detail::text like ?"
                + " or detail::text like ?", Long.class, "%" + temporary + "%", "%Fresh-password-77%", "%" + OWN_PASSWORD + "%"))
                .isZero();
    }

    @Test
    void theDemoSeederDoesNotOverwriteExistingAccounts() {
        // the demo admin exists since startup; its password, roles and state are those of the seed
        Session admin = session("admin", "Demo@12345");
        assertThat(admin.user().get("passwordChangeRequired").asBoolean()).isFalse();
        assertThat(jdbc.queryForObject("select count(*) from app_user where lower(username) = 'admin'", Long.class)).isEqualTo(1);
    }
}
