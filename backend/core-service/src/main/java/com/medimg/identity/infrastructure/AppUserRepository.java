package com.medimg.identity.infrastructure;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

import com.medimg.identity.domain.AppUser;

public interface AppUserRepository extends JpaRepository<AppUser, UUID> {

    /** What an access token is checked against on every request. */
    interface AccountState {
        String getStatus();

        boolean getPasswordChangeRequired();
    }

    String SEARCH_WHERE = """
            where (cast(:pattern as text) is null
                   or lower(u.username) like cast(:pattern as text) escape '!'
                   or lower(coalesce(u.full_name, '')) like cast(:pattern as text) escape '!'
                   or lower(coalesce(u.email, '')) like cast(:pattern as text) escape '!')
              and (cast(:status as text) is null or u.status = cast(:status as text))
              and (cast(:role as text) is null
                   or exists (select 1 from user_role r where r.user_id = u.id and r.role_code = cast(:role as text)))
            """;

    Optional<AppUser> findByUsernameIgnoreCase(String username);

    boolean existsByUsernameIgnoreCase(String username);

    @Query(value = """
            select status as "status", password_change_required as "passwordChangeRequired" from app_user where id = :id
            """, nativeQuery = true)
    Optional<AccountState> findAccountState(UUID id);

    /** Bulk update: a login does not change the version an admin edits against. */
    @Modifying
    @Query("update AppUser u set u.lastLoginAt = :at where u.id = :id")
    void recordLogin(UUID id, Instant at);

    /**
     * Users matching the filters, by username. {@code pattern} is a lower-case LIKE pattern whose wildcards in the
     * search text are escaped with {@code !}, or null; {@code status} and {@code role} are enum names or null.
     */
    @Query(value = "select u.* from app_user u " + SEARCH_WHERE + " order by u.username",
            countQuery = "select count(*) from app_user u " + SEARCH_WHERE,
            nativeQuery = true)
    Page<AppUser> search(String pattern, String status, String role, Pageable pageable);

    /**
     * Ids of the ACTIVE users with the ADMIN role, their rows locked until the end of the transaction. Two admins
     * locking or demoting each other at the same time are thus serialised: the second one sees the change of the first
     * one and cannot leave the system without an active admin.
     */
    @Query(value = """
            select u.id from app_user u
            where u.status = 'ACTIVE'
              and exists (select 1 from user_role r where r.user_id = u.id and r.role_code = 'ADMIN')
            for update of u
            """, nativeQuery = true)
    List<UUID> lockActiveAdmins();
}
