package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/** The audit log for admins: filters, paging, actions, the CSV export and its cap. */
class AuditLogIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc;

    private static String enc(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private HttpResponse<byte[]> download(String query, String token) throws IOException, InterruptedException {
        return raw.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/admin/audit/export.csv?" + query))
                .header("Authorization", "Bearer " + token).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    /** Failed logins of a made-up user whose name starts with a formula; the username is what the client typed. */
    private String failedLogins(String marker, int n) {
        for (int i = 0; i < n; i++) {
            call("POST", "/auth/login", null, Map.of("username", "=" + marker, "password", "x"),
                    Map.of("User-Agent", "Probe/1.0 (\"quoted\", comma)"));
        }
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where username = ?", Long.class, "=" + marker) == n);
        return "=" + marker;
    }

    @Test
    void onlyAdminsReadTheAuditLog() throws Exception {
        String doctor = login("doctor");
        assertThat(get("/admin/audit", doctor).status()).isEqualTo(403);
        assertThat(get("/admin/audit/actions", login("researcher")).status()).isEqualTo(403);
        assertThat(download("", doctor).statusCode()).isEqualTo(403);
        assertThat(get("/admin/audit", null).status()).isEqualTo(401);
    }

    @Test
    void filtersPagingAndOrder() {
        String admin = login("admin");
        String marker = uniqueUsername("probe");
        String username = failedLogins(marker, 3);

        Response page = get("/admin/audit?username=" + enc(marker.toUpperCase()) + "&size=2", admin);
        assertThat(page.status()).isEqualTo(200);
        assertThat(page.body().get("totalElements").asLong()).isEqualTo(3);
        assertThat(page.body().get("totalPages").asInt()).isEqualTo(2);
        JsonNode first = page.body().get("content").get(0);
        JsonNode second = page.body().get("content").get(1);
        assertThat(Instant.parse(first.get("occurredAt").asString()))
                .isAfterOrEqualTo(Instant.parse(second.get("occurredAt").asString()));
        assertThat(first.get("id").asLong()).isGreaterThan(second.get("id").asLong());
        assertThat(first.get("username").asString()).isEqualTo(username);
        assertThat(first.get("action").asString()).isEqualTo("LOGIN_FAILED");
        assertThat(first.get("entityType").asString()).isEqualTo("USER");
        assertThat(first.get("outcome").asString()).isEqualTo("FAILURE");
        assertThat(first.get("clientIp").asString()).isEqualTo("127.0.0.1");
        assertThat(first.get("userAgent").asString()).isEqualTo("Probe/1.0 (\"quoted\", comma)");
        assertThat(first.get("detail").get("reason").asString()).isEqualTo("unknown_user");
        assertThat(get("/admin/audit?username=" + enc(marker) + "&page=1&size=2", admin).body().get("content").size()).isEqualTo(1);

        assertThat(count(admin, "username=" + enc(marker) + "&action=LOGIN_FAILED&outcome=FAILURE")).isEqualTo(3);
        assertThat(count(admin, "username=" + enc(marker) + "&action=LOGIN")).isZero();
        assertThat(count(admin, "username=" + enc(marker) + "&outcome=SUCCESS")).isZero();
        assertThat(count(admin, "username=" + enc(marker) + "&entityType=PATIENT")).isZero();

        // a known user: by user id, entity type and id
        String doctorToken = login("doctor");
        String doctorId = get("/me", doctorToken).body().get("id").asString();
        await().atMost(Duration.ofSeconds(5)).until(() -> count(admin, "userId=" + doctorId + "&action=LOGIN") >= 1);
        JsonNode login = get("/admin/audit?userId=" + doctorId + "&action=LOGIN&entityType=USER&entityId=" + doctorId, admin)
                .body().get("content").get(0);
        assertThat(login.get("userId").asString()).isEqualTo(doctorId);
        assertThat(login.get("entityId").asString()).isEqualTo(doctorId);
        assertThat(login.get("outcome").asString()).isEqualTo("SUCCESS");
    }

    private long count(String admin, String query) {
        return get("/admin/audit?" + query, admin).body().get("totalElements").asLong();
    }

    @Test
    void theRangeIsBoundedAndValidated() {
        String admin = login("admin");
        assertThat(get("/admin/audit?size=201", admin).status()).isEqualTo(400);
        assertThat(get("/admin/audit?size=200", admin).status()).isEqualTo(200);
        assertThat(get("/admin/audit?page=-1", admin).status()).isEqualTo(400);
        Response tooLong = get("/admin/audit?from=2026-01-01&to=2026-04-30", admin);
        assertThat(tooLong.status()).isEqualTo(400);
        assertThat(tooLong.body().get("type").asString()).isEqualTo("/problems/invalid-date-range");
        assertThat(get("/admin/audit?from=2026-11-02&to=2026-11-01", admin).status()).isEqualTo(400);
        assertThat(get("/admin/audit?from=yesterday", admin).status()).isEqualTo(400);
        assertThat(get("/admin/audit?outcome=MAYBE", admin).status()).isEqualTo(400);
        assertThat(get("/admin/audit?userId=not-a-uuid", admin).status()).isEqualTo(400);
        assertThat(get("/admin/audit/actions?from=2026-01-01&to=2026-12-31", admin).status()).isEqualTo(400);
        // 93 days, and a range far in the past that holds nothing
        assertThat(get("/admin/audit?from=2019-01-01&to=2019-04-03", admin).body().get("totalElements").asLong()).isZero();
        assertThat(get("/admin/audit?from=2019-01-01T00:00:00Z&to=2019-01-02T00:00:00Z", admin).status()).isEqualTo(200);
    }

    @Test
    void actionsOfTheRangeAreDistinctAndSorted() {
        String admin = login("admin");
        failedLogins(uniqueUsername("act"), 1);
        List<String> actions = new ArrayList<>();
        get("/admin/audit/actions", admin).body().forEach(a -> actions.add(a.asString()));
        assertThat(actions).contains("LOGIN", "LOGIN_FAILED").doesNotHaveDuplicates().isSorted();
        assertThat(get("/admin/audit/actions?from=2019-01-01&to=2019-01-31", admin).body().size()).isZero();
    }

    @Test
    void theExportIsASafeUtf8CsvOfTheFilteredEntriesAndIsAuditedWhileBrowsingIsNot() throws Exception {
        String admin = login("admin");
        String adminId = get("/me", admin).body().get("id").asString();
        String marker = uniqueUsername("csv");
        String username = failedLogins(marker, 2);
        Instant before = Instant.now();

        // browsing leaves no trace
        get("/admin/audit?username=" + enc(marker), admin);
        get("/admin/audit/actions", admin);

        HttpResponse<byte[]> csv = download("username=" + enc(marker) + "&action=LOGIN_FAILED", admin);
        assertThat(csv.statusCode()).isEqualTo(200);
        assertThat(csv.headers().firstValue("Content-Type").orElseThrow()).isEqualToIgnoringCase("text/csv;charset=UTF-8");
        assertThat(csv.headers().firstValue("Content-Disposition").orElseThrow()).startsWith("attachment; filename=\"audit-log-");
        byte[] body = csv.body();
        assertThat(body).startsWith(0xEF, 0xBB, 0xBF);
        String text = new String(body, 3, body.length - 3, StandardCharsets.UTF_8);
        String[] lines = text.split("\r\n");
        assertThat(lines).hasSize(3);
        assertThat(lines[0]).isEqualTo("id,occurredAt,userId,username,action,entityType,entityId,outcome,clientIp,userAgent,detail");
        // the typed username starts with '=': written as text, not as a formula; quotes and commas are escaped
        assertThat(lines[1]).contains(",'" + username + ",LOGIN_FAILED,USER,,FAILURE,127.0.0.1,"
                + "\"Probe/1.0 (\"\"quoted\"\", comma)\",\"{\"\"reason\"\": \"\"unknown_user\"\"}\"");

        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'AUDIT_EXPORTED' and user_id = ?::uuid and occurred_at >= ?",
                Long.class, adminId, java.sql.Timestamp.from(before)) == 1);
        String detail = jdbc.queryForObject("select detail::text from audit_log where action = 'AUDIT_EXPORTED'"
                + " and user_id = ?::uuid and occurred_at >= ?", String.class, adminId, java.sql.Timestamp.from(before));
        assertThat(detail).contains("\"rowCount\": 2").contains("\"username\": \"" + marker + "\"")
                .contains("\"action\": \"LOGIN_FAILED\"");
        assertThat(jdbc.queryForObject("select count(*) from audit_log where user_id = ?::uuid and occurred_at >= ?"
                + " and action <> 'AUDIT_EXPORTED'", Long.class, adminId, java.sql.Timestamp.from(before))).isZero();
    }

    /**
     * 100 000 rows are exported (streamed, read here line by line), 100 001 are refused before anything is written. The
     * rows are written straight into January 2020, which no other test uses.
     */
    @Test
    void theExportIsCappedAtOneHundredThousandRows() throws Exception {
        jdbc.update("""
                insert into audit_log (occurred_at, username, action, resource_type, outcome, detail)
                select timestamptz '2020-01-10T00:00:00Z' + n * interval '1 millisecond', 'bulk', 'IT_BULK', 'TEST',
                       'SUCCESS', '{}'::jsonb
                from generate_series(1, 100000) n
                """);
        jdbc.update("""
                insert into audit_log (occurred_at, username, action, resource_type, outcome, detail)
                values ('2020-01-20T00:00:00Z', 'bulk', 'IT_BULK', 'TEST', 'SUCCESS', '{}')
                """);
        String admin = login("admin");

        HttpResponse<byte[]> refused = download("action=IT_BULK&from=2020-01-01&to=2020-01-31", admin);
        assertThat(refused.statusCode()).isEqualTo(422);
        JsonNode problem = json.readTree(refused.body());
        assertThat(problem.get("type").asString()).isEqualTo("/problems/export-too-large");
        assertThat(problem.get("rowCount").asLong()).isEqualTo(100_001);
        assertThat(problem.get("maxRows").asLong()).isEqualTo(100_000);

        HttpResponse<InputStream> full = raw.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port
                        + "/api/v1/admin/audit/export.csv?action=IT_BULK&from=2020-01-01&to=2020-01-15"))
                .header("Authorization", "Bearer " + admin).GET().build(), HttpResponse.BodyHandlers.ofInputStream());
        assertThat(full.statusCode()).isEqualTo(200);
        long lines = 0;
        String last = null;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(full.body(), StandardCharsets.UTF_8))) {
            for (String line = reader.readLine(); line != null; line = reader.readLine()) {
                lines++;
                last = line;
            }
        }
        assertThat(lines).isEqualTo(100_001); // header + 100 000 rows
        assertThat(last).contains(",bulk,IT_BULK,TEST,,SUCCESS,"); // newest first: the oldest row comes last
        assertThat(last).contains("2020-01-10T00:00:00.001Z");
    }
}
