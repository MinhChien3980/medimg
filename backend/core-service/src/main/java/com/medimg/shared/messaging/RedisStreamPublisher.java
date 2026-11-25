package com.medimg.shared.messaging;

import java.util.Map;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

@Component
class RedisStreamPublisher implements StreamPublisher {

    private final StringRedisTemplate redis;

    RedisStreamPublisher(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    public void publish(String stream, Map<String, String> fields) {
        redis.opsForStream().add(stream, fields);
    }
}
