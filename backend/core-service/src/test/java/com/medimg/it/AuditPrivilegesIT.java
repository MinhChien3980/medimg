package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

/** The application role (medimg_app) can append to audit_log but never rewrite or erase it. */
class AuditPrivilegesIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc; // connected as medimg_app

    @Test
    void auditLogIsAppendOnlyForTheApplication() {
        post("/auth/login", null, Map.of("username", "admin", "password", "wrong-password"));
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'LOGIN_FAILED' and username = 'admin'", Long.class) >= 1);

        assertThat(jdbc.queryForObject("select current_user", String.class)).isEqualTo("medimg_app");
        String partition = "audit_log_" + LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
        assertThatThrownBy(() -> jdbc.update("update audit_log set action = 'TAMPERED'")).rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> jdbc.update("delete from audit_log")).rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> jdbc.update("delete from " + partition)).rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> jdbc.execute("truncate audit_log")).rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> jdbc.execute("drop table patient")).rootCause().hasMessageContaining("must be owner");
    }

    @Test
    void applicationCanCreateFuturePartitionsThroughDefinerFunction() {
        String name = jdbc.queryForObject("select ensure_audit_partition(?)", String.class, LocalDate.now().plusMonths(3));
        assertThat(name).startsWith("audit_log_");
        assertThatThrownBy(() -> jdbc.update("delete from " + name)).rootCause().hasMessageContaining("permission denied");
    }
}
