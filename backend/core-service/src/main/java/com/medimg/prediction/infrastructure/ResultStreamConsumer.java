package com.medimg.prediction.infrastructure;

import java.util.Map;
import java.util.UUID;

import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.medimg.prediction.application.ResultHandler;
import com.medimg.prediction.application.WorkerResult;
import com.medimg.shared.messaging.StreamConsumer;

/** Consumes {@code ai.results} (ai-worker → core) with consumer group {@code core}. */
@Component
class ResultStreamConsumer extends StreamConsumer {

    static final String RESULTS_STREAM = "ai.results";
    static final String CORE_GROUP = "core";

    private final ResultHandler handler;

    ResultStreamConsumer(StringRedisTemplate redis, RedisConnectionFactory connectionFactory, ResultHandler handler,
                         ResultStreamProperties props) {
        super(redis, connectionFactory, RESULTS_STREAM, CORE_GROUP, props);
        this.handler = handler;
    }

    @Override
    protected void apply(Map<String, String> fields) {
        handler.handle(parse(fields));
    }

    @Override
    @Scheduled(initialDelayString = "${app.ai.result-stream.reclaim-interval}",
            fixedDelayString = "${app.ai.result-stream.reclaim-interval}")
    public void reclaim() {
        super.reclaim();
    }

    static WorkerResult parse(Map<String, String> f) {
        return new WorkerResult(
                UUID.fromString(required(f, "jobId")),
                Integer.parseInt(required(f, "attempt")),
                f.get("workerId"),
                WorkerResult.Type.valueOf(required(f, "type")),
                f.containsKey("progress") ? (int) Double.parseDouble(f.get("progress")) : 0,
                f.get("payload"),
                f.get("error"),
                Boolean.parseBoolean(f.getOrDefault("retryable", "false")));
    }
}
