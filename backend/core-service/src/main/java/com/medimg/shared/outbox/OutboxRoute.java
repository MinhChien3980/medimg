package com.medimg.shared.outbox;

/** Where the relay publishes the messages of one type. Implemented by the module that owns the type. */
public interface OutboxRoute {

    /** The message type this route serves, as given to {@link Outbox#enqueue}. */
    String type();

    /** Stream to publish to now; the relay asks once per relay pass, so the choice can follow live state. */
    String stream();
}
