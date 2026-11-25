package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

/**
 * The audited client address comes from X-Forwarded-For only as far as the hops are trusted proxies: a client
 * cannot put an arbitrary address into the audit log by sending the header itself.
 */
class ClientAddressIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void forgedForwardedForEntriesAreIgnored() {
        // The test client connects from loopback, i.e. it plays the reverse proxy. The proxy appended the real
        // client address (203.0.113.7) to a header that the client forged (198.51.100.1).
        call("POST", "/auth/login", null, Map.of("username", "xff-probe", "password", "x"),
                Map.of("X-Forwarded-For", "198.51.100.1, 203.0.113.7"));

        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'LOGIN_FAILED' and username = 'xff-probe'", Long.class) >= 1);
        String ip = jdbc.queryForObject(
                "select host(ip) from audit_log where action = 'LOGIN_FAILED' and username = 'xff-probe'", String.class);
        assertThat(ip).isEqualTo("203.0.113.7");
    }
}
