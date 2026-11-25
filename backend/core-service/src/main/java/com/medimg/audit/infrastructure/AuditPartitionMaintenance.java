package com.medimg.audit.infrastructure;

import java.time.Clock;
import java.time.LocalDate;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Keeps next month's audit_log partition in place (via the owner-privileged SQL function). */
@Component
class AuditPartitionMaintenance {

    private static final Logger log = LoggerFactory.getLogger(AuditPartitionMaintenance.class);

    private final JdbcTemplate jdbc;
    private final Clock clock;

    AuditPartitionMaintenance(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @EventListener(ApplicationReadyEvent.class)
    @Scheduled(cron = "0 15 3 * * *")
    void ensurePartitions() {
        LocalDate today = LocalDate.now(clock);
        for (LocalDate month : new LocalDate[] {today, today.plusMonths(1)}) {
            String name = jdbc.queryForObject("SELECT ensure_audit_partition(?)", String.class, month);
            log.debug("Audit partition {} ensured", name);
        }
    }
}
