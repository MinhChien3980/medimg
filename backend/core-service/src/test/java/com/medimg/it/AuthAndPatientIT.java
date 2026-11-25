package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Year;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.medimg.support.IntegrationTest;

class AuthAndPatientIT extends IntegrationTest {

    @Test
    void loginRefreshRotationAndReuseDetection() {
        Response login = post("/auth/login", null, Map.of("username", "doctor", "password", "Demo@12345"));
        assertThat(login.status()).isEqualTo(200);
        assertThat(login.body().get("user").get("roles").get(0).asString()).isEqualTo("DOCTOR");
        String access = login.body().get("accessToken").asString();
        String refresh1 = login.body().get("refreshToken").asString();

        assertThat(get("/me", access).body().get("username").asString()).isEqualTo("doctor");

        Response rotated = post("/auth/refresh", null, Map.of("refreshToken", refresh1));
        assertThat(rotated.status()).isEqualTo(200);
        String refresh2 = rotated.body().get("refreshToken").asString();
        assertThat(refresh2).isNotEqualTo(refresh1);

        // re-using the rotated token is treated as theft: every session of the user is revoked
        assertThat(post("/auth/refresh", null, Map.of("refreshToken", refresh1)).status()).isEqualTo(401);
        assertThat(post("/auth/refresh", null, Map.of("refreshToken", refresh2)).status()).isEqualTo(401);
    }

    @Test
    void badCredentialsAndMissingTokenAreRejected() {
        Response bad = post("/auth/login", null, Map.of("username", "doctor", "password", "wrong"));
        assertThat(bad.status()).isEqualTo(401);
        assertThat(bad.body().get("detail").asString()).isEqualTo("Invalid username or password");
        assertThat(post("/auth/login", null, Map.of("username", "nobody", "password", "x")).status()).isEqualTo(401);
        assertThat(get("/patients", null).status()).isEqualTo(401);
        assertThat(get("/patients", "not-a-jwt").status()).isEqualTo(401);
    }

    @Test
    void logoutRevokesRefreshToken() {
        Response login = post("/auth/login", null, Map.of("username", "tech", "password", "Demo@12345"));
        String access = login.body().get("accessToken").asString();
        String refresh = login.body().get("refreshToken").asString();
        assertThat(post("/auth/logout", access, Map.of("refreshToken", refresh)).status()).isEqualTo(204);
        assertThat(post("/auth/refresh", null, Map.of("refreshToken", refresh)).status()).isEqualTo(401);
    }

    @Test
    void logoutWorksWithoutAValidAccessToken() {
        String refresh = post("/auth/login", null, Map.of("username", "tech", "password", "Demo@12345"))
                .body().get("refreshToken").asString();
        assertThat(post("/auth/logout", null, Map.of("refreshToken", refresh)).status()).isEqualTo(204);
        assertThat(post("/auth/refresh", null, Map.of("refreshToken", refresh)).status()).isEqualTo(401);

        String refresh2 = post("/auth/login", null, Map.of("username", "tech", "password", "Demo@12345"))
                .body().get("refreshToken").asString();
        assertThat(post("/auth/logout", "expired-or-garbage", Map.of("refreshToken", refresh2)).status()).isEqualTo(204);
        assertThat(post("/auth/refresh", null, Map.of("refreshToken", refresh2)).status()).isEqualTo(401);

        assertThat(post("/auth/logout", null, Map.of("refreshToken", "unknown-token")).status()).isEqualTo(204);
    }

    @Test
    void patientCrudSearchAndValidation() {
        String doctor = login("doctor");
        Response created = post("/patients", doctor, Map.of("birthYear", 1965, "sex", "F", "note", "crud-test lung"));
        assertThat(created.status()).isEqualTo(201);
        String id = created.body().get("id").asString();
        assertThat(created.body().get("code").asString()).startsWith("CASE-");

        Response search = get("/patients?q=crud-test", doctor);
        assertThat(search.body().get("totalElements").asLong()).isEqualTo(1);

        Response updated = call("PUT", "/patients/" + id, doctor, Map.of("birthYear", 1966, "sex", "F"), Map.of());
        assertThat(updated.body().get("birthYear").asInt()).isEqualTo(1966);

        Response invalid = post("/patients", doctor, Map.of("sex", "X", "birthYear", 1500));
        assertThat(invalid.status()).isEqualTo(400);
        assertThat(invalid.body().get("errors").size()).isEqualTo(2);

        Response dup = post("/patients", doctor, Map.of("code", created.body().get("code").asString()));
        assertThat(dup.status()).isEqualTo(409);

        assertThat(call("DELETE", "/patients/" + id, doctor, null, Map.of()).status()).isEqualTo(403);
        assertThat(call("DELETE", "/patients/" + id, login("admin"), null, Map.of()).status()).isEqualTo(204);
        assertThat(get("/patients/" + id, doctor).status()).isEqualTo(404);
    }

    @Test
    void caseFieldsAreLimited() {
        String doctor = login("doctor");
        int thisYear = Year.now(ZoneOffset.UTC).getValue();

        Response tooLong = post("/patients", doctor, Map.of("code", "A".repeat(33), "note", "n".repeat(501)));
        assertThat(tooLong.status()).isEqualTo(400);
        assertThat(fields(tooLong)).containsExactlyInAnyOrder("code", "note");

        Response future = post("/patients", doctor, Map.of("birthYear", thisYear + 1));
        assertThat(future.status()).isEqualTo(400);
        assertThat(future.body().get("title").asString()).isEqualTo("Bad request");
        assertThat(fields(future)).containsExactly("birthYear");
        assertThat(post("/patients", doctor, Map.of("birthYear", 1899)).status()).isEqualTo(400);

        Response ok = post("/patients", doctor, Map.of("code", "B".repeat(32), "birthYear", thisYear, "note", "n".repeat(500)));
        assertThat(ok.status()).isEqualTo(201);
        String id = ok.body().get("id").asString();
        assertThat(fields(call("PUT", "/patients/" + id, doctor, Map.of("birthYear", thisYear + 1), Map.of())))
                .containsExactly("birthYear");
    }

    private static List<String> fields(Response r) {
        List<String> out = new ArrayList<>();
        r.body().get("errors").forEach(e -> out.add(e.get("field").asString()));
        return out;
    }
}
