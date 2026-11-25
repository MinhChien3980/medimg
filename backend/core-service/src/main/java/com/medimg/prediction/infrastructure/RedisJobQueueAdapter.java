package com.medimg.prediction.infrastructure;

import java.time.Duration;
import java.util.UUID;

import org.springframework.data.redis.core.Cursor;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import com.medimg.prediction.application.JobOutbox;
import com.medimg.prediction.application.JobQueuePort;
import com.medimg.shared.outbox.OutboxRoute;

/**
 * Redis side of AI jobs: the stream a job dispatch is published to, and the cancel flag. Stream and key names are
 * shared with the ai-worker.
 */
@Component
class RedisJobQueueAdapter implements JobQueuePort, OutboxRoute {

    static final String GPU_STREAM = "ai.jobs.gpu";
    static final String CPU_STREAM = "ai.jobs.cpu";
    static final String GPU_HEARTBEAT_PATTERN = "ai:worker:gpu:*";

    private final StringRedisTemplate redis;

    RedisJobQueueAdapter(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    public String type() {
        return JobOutbox.MESSAGE_TYPE;
    }

    /** GPU stream when a GPU worker is alive (heartbeat), otherwise the CPU stream. */
    @Override
    public String stream() {
        try (Cursor<String> cursor = redis.scan(ScanOptions.scanOptions().match(GPU_HEARTBEAT_PATTERN).count(100).build())) {
            return cursor.hasNext() ? GPU_STREAM : CPU_STREAM;
        }
    }

    @Override
    public void markCancelled(UUID jobId) {
        redis.opsForValue().set("ai:job:" + jobId + ":cancelled", "1", Duration.ofDays(1));
    }
}
