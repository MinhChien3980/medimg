package com.medimg.imaging.infrastructure;

import java.util.Map;
import java.util.UUID;

import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.medimg.imaging.application.IngestResult;
import com.medimg.imaging.application.IngestResultHandler;
import com.medimg.shared.messaging.StreamConsumer;

/** Consumes {@code imaging.results} (ingest worker → core) with consumer group {@code core-imaging}. */
@Component
class IngestResultConsumer extends StreamConsumer {

    static final String RESULTS_STREAM = "imaging.results";
    static final String GROUP = "core-imaging";

    private final IngestResultHandler handler;

    IngestResultConsumer(StringRedisTemplate redis, RedisConnectionFactory connectionFactory, IngestResultHandler handler,
                         IngestResultStreamProperties props) {
        super(redis, connectionFactory, RESULTS_STREAM, GROUP, props);
        this.handler = handler;
    }

    @Override
    protected void apply(Map<String, String> fields) {
        handler.handle(parse(fields));
    }

    @Override
    @Scheduled(initialDelayString = "${app.imaging.result-stream.reclaim-interval}",
            fixedDelayString = "${app.imaging.result-stream.reclaim-interval}")
    public void reclaim() {
        super.reclaim();
    }

    static IngestResult parse(Map<String, String> f) {
        return new IngestResult(
                UUID.fromString(required(f, "uploadId")),
                Integer.parseInt(required(f, "attempt")),
                f.get("workerId"),
                IngestResult.Type.valueOf(required(f, "type")),
                f.containsKey("progress") ? (int) Double.parseDouble(f.get("progress")) : 0,
                f.get("payload"),
                f.get("error"),
                Boolean.parseBoolean(f.getOrDefault("retryable", "false")));
    }
}
