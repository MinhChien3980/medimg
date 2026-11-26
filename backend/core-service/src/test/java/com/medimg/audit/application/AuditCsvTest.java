package com.medimg.audit.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.StringWriter;
import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.medimg.audit.infrastructure.AuditLogQueries.AuditRow;

class AuditCsvTest {

    @Test
    void plainValuesAreWrittenAsTheyAre() {
        assertThat(AuditCsv.cell("LOGIN")).isEqualTo("LOGIN");
        assertThat(AuditCsv.cell("Nguyễn Văn A")).isEqualTo("Nguyễn Văn A");
        assertThat(AuditCsv.cell(null)).isEmpty();
        assertThat(AuditCsv.cell("")).isEmpty();
    }

    @Test
    void commasQuotesAndLineBreaksAreQuoted() {
        assertThat(AuditCsv.cell("a,b")).isEqualTo("\"a,b\"");
        assertThat(AuditCsv.cell("say \"hi\"")).isEqualTo("\"say \"\"hi\"\"\"");
        assertThat(AuditCsv.cell("line1\nline2")).isEqualTo("\"line1\nline2\"");
        assertThat(AuditCsv.cell("line1\r\nline2")).isEqualTo("\"line1\r\nline2\"");
        assertThat(AuditCsv.cell("{\"reason\":\"locked\",\"n\":2}")).isEqualTo("\"{\"\"reason\"\":\"\"locked\"\",\"\"n\"\":2}\"");
    }

    @Test
    void formulaTriggersAreNeutralised() {
        assertThat(AuditCsv.cell("=1+1")).isEqualTo("'=1+1");
        assertThat(AuditCsv.cell("+SUM(A1)")).isEqualTo("'+SUM(A1)");
        assertThat(AuditCsv.cell("-2+3")).isEqualTo("'-2+3");
        assertThat(AuditCsv.cell("@cmd")).isEqualTo("'@cmd");
        assertThat(AuditCsv.cell("\tx")).isEqualTo("'\tx");
        assertThat(AuditCsv.cell("\rx")).isEqualTo("\"'\rx\"");
        // neutralised first, then quoted
        assertThat(AuditCsv.cell("=HYPERLINK(\"http://x\",\"y\")")).isEqualTo("\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\"");
        // only the first character matters
        assertThat(AuditCsv.cell("a=b")).isEqualTo("a=b");
    }

    @Test
    void aFileStartsWithTheBomAndTheHeaderAndUsesCrlf() throws IOException {
        StringWriter out = new StringWriter();
        AuditCsv.writeHeader(out);
        UUID user = UUID.fromString("00000000-0000-0000-0000-000000000001");
        AuditCsv.writeEntry(out, new AuditRow(7, Instant.parse("2026-11-26T08:00:00Z"), user, "=evil", "LOGIN_FAILED",
                "USER", null, "FAILURE", "203.0.113.7", "Mozilla/5.0 (X11, Linux)", "{\"reason\": \"locked\"}"));

        assertThat(out.toString()).isEqualTo("﻿"
                + "id,occurredAt,userId,username,action,entityType,entityId,outcome,clientIp,userAgent,detail\r\n"
                + "7,2026-11-26T08:00:00Z,00000000-0000-0000-0000-000000000001,'=evil,LOGIN_FAILED,USER,,FAILURE,"
                + "203.0.113.7,\"Mozilla/5.0 (X11, Linux)\",\"{\"\"reason\"\": \"\"locked\"\"}\"\r\n");
    }
}
