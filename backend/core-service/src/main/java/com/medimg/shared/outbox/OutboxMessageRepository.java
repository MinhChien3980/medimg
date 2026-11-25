package com.medimg.shared.outbox;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

interface OutboxMessageRepository extends JpaRepository<OutboxMessage, Long> {

    /**
     * Locks up to {@code limit} due, unpublished messages, oldest first. Rows locked by another relay are skipped, so
     * concurrent relays (one per core-service instance) never claim the same message.
     */
    @Query(value = """
            SELECT * FROM outbox_message
            WHERE published_at IS NULL AND available_at <= :now
            ORDER BY available_at, id
            LIMIT :limit
            FOR UPDATE SKIP LOCKED
            """, nativeQuery = true)
    List<OutboxMessage> lockDue(Instant now, int limit);

    @Modifying
    @Query("delete from OutboxMessage m where m.type = :type and m.aggregateId = :aggregateId and m.publishedAt is null")
    int deletePending(String type, UUID aggregateId);

    @Modifying
    @Query("delete from OutboxMessage m where m.publishedAt < :before")
    int deletePublishedBefore(Instant before);
}
