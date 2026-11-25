package com.medimg.shared.messaging;

import java.util.Map;

/** Appends entries to Redis streams. The outbox relay is its only caller, so every entry is backed by an outbox row. */
public interface StreamPublisher {

    void publish(String stream, Map<String, String> fields);
}
