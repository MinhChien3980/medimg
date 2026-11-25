package com.medimg.prediction.infrastructure;

import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.Cursor;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import com.medimg.prediction.application.JobQueuePort;

/** Redis Streams implementation of {@link JobQueuePort}. Stream and key names are shared with the ai-worker. */
@Component
class RedisJobQueueAdapter implements JobQueuePort {

    static final String GPU_STREAM = "ai.jobs.gpu";
    static final String CPU_STREAM = "ai.jobs.cpu";
    static final String GPU_HEARTBEAT_PATTERN = "ai:worker:gpu:*";

    private static final Logger log = LoggerFactory.getLogger(RedisJobQueueAdapter.class);

    private final StringRedisTemplate redis;
    private final Clock clock;

    RedisJobQueueAdapter(StringRedisTemplate redis, Clock clock) {
        this.redis = redis;
        this.clock = clock;
    }

    @Override
    public String chooseQueue() {
        try (Cursor<String> cursor = redis.scan(ScanOptions.scanOptions().match(GPU_HEARTBEAT_PATTERN).count(100).build())) {
            return cursor.hasNext() ? GPU_STREAM : CPU_STREAM;
        }
    }

    @Override
    public void publish(String queue, JobMessage m) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("jobId", m.jobId().toString());
        fields.put("attempt", Integer.toString(m.attempt()));
        fields.put("modelCode", m.modelCode());
        fields.put("modelVersion", m.modelVersion());
        fields.put("task", m.task());
        fields.put("inputType", m.inputType());
        fields.put("inputUri", m.inputUri());
        fields.put("outputPrefix", m.outputPrefix());
        fields.put("params", m.paramsJson());
        fields.put("enqueuedAt", clock.instant().toString());
        var id = redis.opsForStream().add(queue, fields);
        log.info("Job {} attempt {} → {} ({})", m.jobId(), m.attempt(), queue, id);
    }

    @Override
    public void markCancelled(UUID jobId) {
        redis.opsForValue().set("ai:job:" + jobId + ":cancelled", "1", Duration.ofDays(1));
    }
}
