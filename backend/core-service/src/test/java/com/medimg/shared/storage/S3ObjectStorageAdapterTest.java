package com.medimg.shared.storage;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import java.net.URI;
import java.time.Duration;

import org.junit.jupiter.api.Test;

class S3ObjectStorageAdapterTest {

    @Test
    void startupFailsWhenTheBucketCannotBeEnsured() {
        URI unreachable = URI.create("http://127.0.0.1:1");
        var props = new StorageProperties("medimg", unreachable, unreachable, "us-east-1", "key", "secret",
                Duration.ofMinutes(15));
        var adapter = new S3ObjectStorageAdapter(props, 2, Duration.ofMillis(10));

        assertTimeoutPreemptively(Duration.ofSeconds(30), () -> assertThatThrownBy(adapter::ensureBucket)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Bucket medimg is not available after 2 attempts"));
    }
}
