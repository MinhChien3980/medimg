package com.medimg.imaging.infrastructure;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.medimg.imaging.application.IngestResult;

class IngestResultConsumerTest {

    private final UUID uploadId = UUID.randomUUID();

    @Test
    void parsesTheStreamFields() {
        IngestResult r = IngestResultConsumer.parse(Map.of("uploadId", uploadId.toString(), "attempt", "2",
                "workerId", "ingest-1", "type", "FAILED", "progress", "55.0", "error", "Not a CT", "retryable", "true"));

        assertThat(r).isEqualTo(new IngestResult(uploadId, 2, "ingest-1", IngestResult.Type.FAILED, 55, null, "Not a CT", true));
    }

    @Test
    void optionalFieldsDefault() {
        IngestResult r = IngestResultConsumer.parse(Map.of("uploadId", uploadId.toString(), "attempt", "1",
                "type", "DONE", "payload", "{}"));

        assertThat(r.progress()).isZero();
        assertThat(r.retryable()).isFalse();
        assertThat(r.payloadJson()).isEqualTo("{}");
    }

    @Test
    void malformedMessagesAreRejected() {
        assertThatThrownBy(() -> IngestResultConsumer.parse(Map.of("attempt", "1", "type", "DONE")))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("missing field uploadId");
        assertThatThrownBy(() -> IngestResultConsumer.parse(Map.of("uploadId", uploadId.toString(), "attempt", "1",
                "type", "FINISHED"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> IngestResultConsumer.parse(Map.of("uploadId", uploadId.toString(), "attempt", "one",
                "type", "DONE"))).isInstanceOf(IllegalArgumentException.class);
    }
}
