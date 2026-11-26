package com.medimg.audit.application;

import java.io.IOException;
import java.io.Writer;
import java.util.Arrays;
import java.util.List;

import com.medimg.audit.infrastructure.AuditLogQueries.AuditRow;

/**
 * CSV of audit entries as spreadsheets read it: RFC 4180 quoting, CRLF line ends, and a UTF-8 byte order mark that
 * the caller writes first so that Excel detects the encoding. Against CSV (formula) injection a cell starting with
 * {@code = + - @}, a tab or a carriage return is prefixed with {@code '}, so that a spreadsheet shows it as text
 * instead of evaluating it (OWASP recommendation).
 */
final class AuditCsv {

    static final char BOM = '﻿';
    static final List<String> HEADER = List.of("id", "occurredAt", "userId", "username", "action", "entityType",
            "entityId", "outcome", "clientIp", "userAgent", "detail");
    private static final String CRLF = "\r\n";

    private AuditCsv() {
    }

    static void writeHeader(Writer out) throws IOException {
        out.write(BOM);
        writeRow(out, HEADER);
    }

    static void writeEntry(Writer out, AuditRow r) throws IOException {
        writeRow(out, Arrays.asList(Long.toString(r.id()), r.occurredAt().toString(), str(r.userId()), r.username(),
                r.action(), r.resourceType(), r.resourceId(), r.outcome(), r.ip(), r.userAgent(), r.detailJson()));
    }

    static void writeRow(Writer out, List<String> cells) throws IOException {
        for (int i = 0; i < cells.size(); i++) {
            if (i > 0) {
                out.write(',');
            }
            out.write(cell(cells.get(i)));
        }
        out.write(CRLF);
    }

    /** One cell: neutralised against formula injection, then quoted if it holds a comma, a quote or a line break. */
    static String cell(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        String text = value;
        char first = text.charAt(0);
        if (first == '=' || first == '+' || first == '-' || first == '@' || first == '\t' || first == '\r') {
            text = "'" + text;
        }
        if (text.indexOf(',') >= 0 || text.indexOf('"') >= 0 || text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0) {
            return '"' + text.replace("\"", "\"\"") + '"';
        }
        return text;
    }

    private static String str(Object value) {
        return value == null ? null : value.toString();
    }
}
