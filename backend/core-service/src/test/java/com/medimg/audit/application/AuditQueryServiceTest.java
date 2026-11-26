package com.medimg.audit.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;

import com.medimg.audit.domain.AuditFilter;
import com.medimg.audit.domain.AuditRange;
import com.medimg.audit.infrastructure.AuditLogQueries;
import com.medimg.audit.infrastructure.AuditLogQueries.AuditRow;
import com.medimg.shared.audit.AuditEvent;
import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.web.ApiException;

import tools.jackson.databind.json.JsonMapper;

class AuditQueryServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-26T08:00:00Z");

    private final AuditLogQueries queries = mock(AuditLogQueries.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private final AuditQueryService service = new AuditQueryService(queries, JsonMapper.builder().build(), events,
            new AuditProperties(ZoneId.of("Asia/Ho_Chi_Minh")), Clock.fixed(NOW, ZoneOffset.UTC));
    private final AuditRange range = new AuditRange(NOW.minusSeconds(3600), NOW);
    private final AuditFilter filter = new AuditFilter(null, null, "LOGIN", null, null, null);

    private static AuditRow row(long id) {
        return new AuditRow(id, NOW, null, "admin", "LOGIN", "USER", "x", "SUCCESS", "127.0.0.1", "curl", "{}");
    }

    private AuditEvent audit() {
        ArgumentCaptor<AuditEvent> captor = ArgumentCaptor.forClass(AuditEvent.class);
        verify(events).publishEvent(captor.capture());
        return captor.getValue();
    }

    @Test
    void aBadRangeIsA400() {
        assertThatThrownBy(() -> service.range("2026-11-27", "2026-11-26")).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(e.getBody().getType().toString()).isEqualTo("/problems/invalid-date-range");
        });
        assertThat(service.range(null, null)).isEqualTo(new AuditRange(NOW.minusSeconds(7 * 86400), NOW));
    }

    @Test
    void aPageHoldsTheDetailAsJsonAndCountsThePages() {
        when(queries.count(filter, range)).thenReturn(201L);
        when(queries.page(filter, range, 1, 100)).thenReturn(List.of(
                new AuditRow(5, NOW, null, "admin", "LOGIN", "USER", "x", "SUCCESS", null, null, "{\"reason\": \"x\"}")));

        var page = service.search(filter, range, 1, 100);

        assertThat(page.totalElements()).isEqualTo(201);
        assertThat(page.totalPages()).isEqualTo(3);
        assertThat(page.content().getFirst().detail().get("reason").asString()).isEqualTo("x");
        assertThatThrownBy(() -> service.search(filter, range, 0, 201)).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> service.search(filter, range, -1, 10)).isInstanceOf(ApiException.class);
    }

    @Test
    void anExportAboveTheCapIsRefusedBeforeAnythingIsWritten() {
        when(queries.count(filter, range)).thenReturn(100_001L);
        boolean[] opened = {false};

        assertThatThrownBy(() -> service.exportCsv(filter, range, r -> {
            opened[0] = true;
            return new ByteArrayOutputStream();
        })).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
            assertThat(e.getBody().getType().toString()).isEqualTo("/problems/export-too-large");
            assertThat(e.getBody().getProperties()).containsEntry("rowCount", 100_001L).containsEntry("maxRows", 100_000);
        });
        assertThat(opened[0]).isFalse();
        AuditEvent audit = audit();
        assertThat(audit.action()).isEqualTo("AUDIT_EXPORTED");
        assertThat(audit.outcome()).isEqualTo(Outcome.FAILURE);
        assertThat(audit.detail()).containsEntry("reason", "too_many_rows");
    }

    @Test
    @SuppressWarnings("unchecked")
    void anExportOfExactlyTheCapStreamsEveryRowAndIsAudited() {
        when(queries.count(filter, range)).thenReturn(100_000L);
        doAnswer(i -> {
            Consumer<AuditRow> sink = i.getArgument(3);
            sink.accept(row(1));
            sink.accept(row(2));
            return null;
        }).when(queries).stream(eq(filter), eq(range), eq(100_000), any(Consumer.class));
        ByteArrayOutputStream body = new ByteArrayOutputStream();

        assertThat(service.exportCsv(filter, range, r -> body)).isEqualTo(2);

        String csv = body.toString(StandardCharsets.UTF_8);
        assertThat(body.toByteArray()).startsWith(0xEF, 0xBB, 0xBF);
        assertThat(csv.split("\r\n")).hasSize(3);
        AuditEvent audit = audit();
        assertThat(audit.outcome()).isEqualTo(Outcome.SUCCESS);
        assertThat(audit.detail()).containsEntry("rowCount", 2L).containsEntry("filters", Map.of("action", "LOGIN"))
                .containsEntry("from", range.from().toString()).containsEntry("to", range.to().toString());
    }

    @Test
    @SuppressWarnings("unchecked")
    void anAbortedDownloadIsAuditedAsAFailure() {
        when(queries.count(filter, range)).thenReturn(5L);
        doAnswer(i -> {
            Consumer<AuditRow> sink = i.getArgument(3);
            for (int n = 0; n < 5; n++) {
                sink.accept(row(n));
            }
            return null;
        }).when(queries).stream(any(), any(), anyInt(), any(Consumer.class));
        OutputStream broken = new OutputStream() {
            @Override
            public void write(int b) throws IOException {
                throw new IOException("client went away");
            }
        };

        assertThatThrownBy(() -> service.exportCsv(filter, range, r -> broken)).isInstanceOf(UncheckedIOException.class);
        assertThat(audit().detail()).containsEntry("reason", "aborted");
    }
}
