package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

/** User administration: permissions, validation, search, optimistic locking and the rules that keep an admin. */
class AdminUserIT extends IntegrationTest {

    @Autowired
    JdbcTemplate jdbc; // connected as medimg_app

    private static String type(Response r) {
        return r.body().get("type").asString();
    }

    private Response update(String token, String id, String fullName, List<String> roles, long version) {
        return call("PUT", "/admin/users/" + id, token,
                Map.of("fullName", fullName, "roles", roles, "version", version), Map.of());
    }

    private List<String> usernames(Response page) {
        List<String> out = new ArrayList<>();
        page.body().get("content").forEach(u -> out.add(u.get("username").asString()));
        return out;
    }

    @Test
    void onlyAdminsAdministerUsers() {
        String doctor = login("doctor");
        String someone = createUser(uniqueUsername("target"), "DOCTOR").get("user").get("id").asString();
        assertThat(get("/admin/users", doctor).status()).isEqualTo(403);
        assertThat(get("/admin/users/" + someone, login("researcher")).status()).isEqualTo(403);
        assertThat(post("/admin/users", login("tech"), Map.of("username", "x-tech", "fullName", "X", "roles", List.of("DOCTOR")))
                .status()).isEqualTo(403);
        assertThat(post("/admin/users/" + someone + "/lock", doctor, null).status()).isEqualTo(403);
        assertThat(post("/admin/users/" + someone + "/reset-password", doctor, null).status()).isEqualTo(403);
        assertThat(update(doctor, someone, "X", List.of("ADMIN"), 0).status()).isEqualTo(403);
        assertThat(get("/admin/users", null).status()).isEqualTo(401);
    }

    @Test
    void createValidatesTheRequest() {
        String admin = login("admin");
        assertThat(post("/admin/users", admin, Map.of("username", "ab", "fullName", "X", "roles", List.of("DOCTOR"))).status())
                .isEqualTo(400);
        assertThat(post("/admin/users", admin, Map.of("username", "a".repeat(51), "fullName", "X", "roles", List.of("DOCTOR")))
                .status()).isEqualTo(400);
        assertThat(post("/admin/users", admin, Map.of("username", "bad name", "fullName", "X", "roles", List.of("DOCTOR")))
                .status()).isEqualTo(400);
        assertThat(post("/admin/users", admin, Map.of("username", "valid.name", "fullName", " ", "roles", List.of("DOCTOR")))
                .status()).isEqualTo(400);
        assertThat(post("/admin/users", admin, Map.of("username", "valid.name", "fullName", "X".repeat(101),
                "roles", List.of("DOCTOR"))).status()).isEqualTo(400);
        assertThat(post("/admin/users", admin, Map.of("username", "valid.name", "fullName", "X", "roles", List.of())).status())
                .isEqualTo(400);
        assertThat(post("/admin/users", admin, Map.of("username", "valid.name", "fullName", "X", "roles", List.of("GOD"))).status())
                .isEqualTo(400);
        assertThat(post("/admin/users", admin, Map.of("username", "valid.name", "fullName", "X", "email", "not-an-email",
                "roles", List.of("DOCTOR"))).status()).isEqualTo(400);
    }

    @Test
    void createReturnsTheTemporaryPasswordOnceAndUsernamesAreUniqueRegardlessOfCase() {
        String admin = login("admin");
        String name = uniqueUsername("Mixed.Case");
        Response created = post("/admin/users", admin, Map.of("username", name, "fullName", " Dr. Mixed ",
                "email", "mixed@example.org", "roles", List.of("DOCTOR", "RESEARCHER")));
        assertThat(created.status()).isEqualTo(201);
        JsonNode user = created.body().get("user");
        assertThat(user.get("username").asString()).isEqualTo(name.toLowerCase());
        assertThat(user.get("fullName").asString()).isEqualTo("Dr. Mixed");
        assertThat(user.get("roles").toString()).isEqualTo("[\"DOCTOR\",\"RESEARCHER\"]");
        assertThat(user.get("status").asString()).isEqualTo("ACTIVE");
        assertThat(user.get("passwordChangeRequired").asBoolean()).isTrue();
        assertThat(user.has("passwordHash")).isFalse();
        assertThat(created.body().get("temporaryPassword").asString()).hasSize(16);
        // the temporary password is not given again
        assertThat(get("/admin/users/" + user.get("id").asString(), admin).body().has("temporaryPassword")).isFalse();

        Response duplicate = post("/admin/users", admin, Map.of("username", name.toUpperCase(), "fullName", "X",
                "roles", List.of("DOCTOR")));
        assertThat(duplicate.status()).isEqualTo(409);
        assertThat(type(duplicate)).isEqualTo("/problems/username-taken");
        Response demo = post("/admin/users", admin, Map.of("username", "Doctor", "fullName", "X", "roles", List.of("DOCTOR")));
        assertThat(demo.status()).isEqualTo(409);
    }

    @Test
    void searchFiltersByTextRoleAndStatusAndPages() {
        String admin = login("admin");
        String tag = uniqueUsername("srch");
        String a = createUser(tag + "-a", "DOCTOR").get("user").get("id").asString();
        createUser(tag + "-b", "TECHNICIAN");
        createUser(tag + "-c", "TECHNICIAN", "RESEARCHER");
        post("/admin/users/" + a + "/lock", admin, null);

        assertThat(usernames(get("/admin/users?q=" + tag.toUpperCase(), admin)))
                .containsExactly(tag + "-a", tag + "-b", tag + "-c");
        assertThat(usernames(get("/admin/users?q=" + tag + "&role=TECHNICIAN", admin))).containsExactly(tag + "-b", tag + "-c");
        assertThat(usernames(get("/admin/users?q=" + tag + "&status=LOCKED", admin))).containsExactly(tag + "-a");
        assertThat(usernames(get("/admin/users?q=" + tag + "&status=ACTIVE&role=RESEARCHER", admin))).containsExactly(tag + "-c");
        // matches the full name as well; LIKE wildcards are literal
        assertThat(usernames(get("/admin/users?q=Test " + tag + "-b", admin))).containsExactly(tag + "-b");
        assertThat(get("/admin/users?q=%", admin).body().get("totalElements").asLong()).isZero();
        assertThat(get("/admin/users?q=_", admin).body().get("totalElements").asLong()).isZero();

        Response page = get("/admin/users?q=" + tag + "&size=2&page=1", admin);
        assertThat(usernames(page)).containsExactly(tag + "-c");
        assertThat(page.body().get("totalElements").asLong()).isEqualTo(3);
        assertThat(page.body().get("totalPages").asInt()).isEqualTo(2);

        assertThat(get("/admin/users?size=101", admin).status()).isEqualTo(400);
        assertThat(get("/admin/users?role=GOD", admin).status()).isEqualTo(400);
        assertThat(get("/admin/users?status=GONE", admin).status()).isEqualTo(400);
    }

    @Test
    void updateUsesOptimisticLockingAndAuditsTheRoleChange() {
        String admin = login("admin");
        JsonNode user = createUser(uniqueUsername("edit"), "DOCTOR").get("user");
        String id = user.get("id").asString();
        long v0 = user.get("version").asLong();

        Response updated = update(admin, id, "New Name", List.of("DOCTOR", "TECHNICIAN"), v0);
        assertThat(updated.status()).as(updated.toString()).isEqualTo(200);
        assertThat(updated.body().get("fullName").asString()).isEqualTo("New Name");
        assertThat(updated.body().get("roles").toString()).isEqualTo("[\"DOCTOR\",\"TECHNICIAN\"]");
        assertThat(updated.body().get("version").asLong()).isGreaterThan(v0);

        Response stale = update(admin, id, "Other Name", List.of("DOCTOR"), v0);
        assertThat(stale.status()).isEqualTo(409);
        assertThat(get("/admin/users/" + id, admin).body().get("fullName").asString()).isEqualTo("New Name");

        assertThat(call("PUT", "/admin/users/" + id, admin, Map.of("fullName", "X", "roles", List.of("DOCTOR")), Map.of())
                .status()).isEqualTo(400); // version is required
        assertThat(update(admin, java.util.UUID.randomUUID().toString(), "X", List.of("DOCTOR"), 0).status()).isEqualTo(404);

        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action = 'USER_UPDATED' and resource_id = ?", Long.class, id) == 1);
        String detail = jdbc.queryForObject(
                "select detail::text from audit_log where action = 'USER_UPDATED' and resource_id = ?", String.class, id);
        assertThat(detail).contains("\"rolesAdded\": [\"TECHNICIAN\"]").contains("\"rolesRemoved\": []");
    }

    @Test
    void aLoginDoesNotMakeTheAdminFormStale() {
        String admin = login("admin");
        String username = uniqueUsername("busy");
        createActiveUser(username, "DOCTOR");
        JsonNode user = get("/admin/users?q=" + username, admin).body().get("content").get(0);
        long version = user.get("version").asLong();

        session(username, OWN_PASSWORD);
        JsonNode after = get("/admin/users/" + user.get("id").asString(), admin).body();
        assertThat(after.get("lastLoginAt").isNull()).isFalse();
        assertThat(after.get("version").asLong()).isEqualTo(version);
        assertThat(update(admin, user.get("id").asString(), "Renamed", List.of("DOCTOR"), version).status()).isEqualTo(200);
    }

    @Test
    void anAdminCannotLockDemoteOrResetThemself() {
        Session self = createActiveUser(uniqueUsername("selfadm"), "ADMIN");
        String id = self.user().get("id").asString();

        Response lock = post("/admin/users/" + id + "/lock", self.accessToken(), null);
        assertThat(lock.status()).isEqualTo(422);
        assertThat(type(lock)).isEqualTo("/problems/self-lock");
        JsonNode me = get("/admin/users/" + id, self.accessToken()).body();
        Response demote = update(self.accessToken(), id, "Me", List.of("DOCTOR"), me.get("version").asLong());
        assertThat(demote.status()).isEqualTo(422);
        assertThat(type(demote)).isEqualTo("/problems/self-demote");
        Response reset = post("/admin/users/" + id + "/reset-password", self.accessToken(), null);
        assertThat(reset.status()).isEqualTo(422);
        assertThat(type(reset)).isEqualTo("/problems/self-reset");

        // still an active admin, and may edit their own name
        assertThat(update(self.accessToken(), id, "Me Myself", List.of("ADMIN", "DOCTOR"), me.get("version").asLong())
                .status()).isEqualTo(200);
        assertThat(get("/admin/users/" + id, self.accessToken()).body().get("status").asString()).isEqualTo("ACTIVE");
        post("/admin/users/" + id + "/lock", login("admin"), null); // leave the demo admin as the only extra admin
    }

    @Test
    void lockAndUnlockAreIdempotent() {
        String admin = login("admin");
        String id = createUser(uniqueUsername("idem"), "DOCTOR").get("user").get("id").asString();
        JsonNode first = post("/admin/users/" + id + "/lock", admin, null).body();
        JsonNode second = post("/admin/users/" + id + "/lock", admin, null).body();
        assertThat(second.get("lockedAt")).isEqualTo(first.get("lockedAt"));
        assertThat(second.get("version")).isEqualTo(first.get("version"));
        assertThat(post("/admin/users/" + id + "/unlock", admin, null).body().get("status").asString()).isEqualTo("ACTIVE");
        assertThat(post("/admin/users/" + id + "/unlock", admin, null).status()).isEqualTo(200);
        assertThat(post("/admin/users/" + java.util.UUID.randomUUID() + "/lock", admin, null).status()).isEqualTo(404);
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where action in ('USER_LOCKED', 'USER_UNLOCKED') and resource_id = ?",
                Long.class, id) == 2);
    }

    /**
     * Roles live in the access token until it is refreshed: an admin demoted a minute ago still holds an ADMIN token. The
     * last active admin is protected from such a token as well.
     */
    @Test
    void theLastActiveAdminCanBeNeitherLockedNorDemoted() {
        String admin = login("admin");
        String adminId = get("/me", admin).body().get("id").asString();
        lockOtherActiveAdmins(admin, adminId);
        Session demoted = createActiveUser(uniqueUsername("exadmin"), "ADMIN");
        String demotedId = demoted.user().get("id").asString();
        long version = get("/admin/users/" + demotedId, admin).body().get("version").asLong();
        assertThat(update(admin, demotedId, "Ex Admin", List.of("DOCTOR"), version).status()).isEqualTo(200);

        Response lock = post("/admin/users/" + adminId + "/lock", demoted.accessToken(), null);
        assertThat(lock.status()).isEqualTo(409);
        assertThat(type(lock)).isEqualTo("/problems/last-admin");
        long adminVersion = get("/admin/users/" + adminId, admin).body().get("version").asLong();
        Response demote = update(demoted.accessToken(), adminId, "Demo Admin", List.of("DOCTOR"), adminVersion);
        assertThat(demote.status()).isEqualTo(409);
        assertThat(type(demote)).isEqualTo("/problems/last-admin");

        JsonNode still = get("/admin/users/" + adminId, admin).body();
        assertThat(still.get("status").asString()).isEqualTo("ACTIVE");
        assertThat(still.get("roles").toString()).contains("ADMIN");
        await().atMost(Duration.ofSeconds(5)).until(() -> jdbc.queryForObject(
                "select count(*) from audit_log where resource_id = ? and outcome = 'FAILURE' and detail ->> 'reason' = 'last_admin'",
                Long.class, adminId) == 2);
    }

    /** Two admins locking each other at the same moment: one of them wins, never both. */
    @Test
    void twoAdminsLockingEachOtherAtOnceLeaveOneActiveAdmin() throws Exception {
        String admin = login("admin");
        String adminId = get("/me", admin).body().get("id").asString();
        lockOtherActiveAdmins(admin, adminId);
        Session x = createActiveUser(uniqueUsername("adm-x"), "ADMIN");
        Session y = createActiveUser(uniqueUsername("adm-y"), "ADMIN");
        String xId = x.user().get("id").asString();
        String yId = y.user().get("id").asString();
        try {
            // x and y are now the only active admins
            post("/admin/users/" + adminId + "/lock", x.accessToken(), null);
            Session[] admins = {x, y};
            String[] ids = {xId, yId};
            for (int round = 0; round < 5; round++) {
                CountDownLatch start = new CountDownLatch(1);
                List<CompletableFuture<Integer>> calls = new ArrayList<>();
                for (int i = 0; i < 2; i++) {
                    String actorToken = admins[i].accessToken();
                    String targetId = ids[1 - i];
                    calls.add(CompletableFuture.supplyAsync(() -> {
                        awaitLatch(start);
                        return post("/admin/users/" + targetId + "/lock", actorToken, null).status();
                    }));
                }
                start.countDown();
                List<Integer> statuses = List.of(calls.get(0).get(), calls.get(1).get());

                assertThat(statuses).containsOnlyOnce(200);
                assertThat(statuses).containsAnyOf(409, 401); // 401: the loser was already locked when its request came in
                assertThat(activeAdmins()).isEqualTo(1);
                // the winner unlocks the loser, who logs in again (the lock ended its sessions), for the next round
                int winner = statuses.get(0) == 200 ? 0 : 1;
                int loser = 1 - winner;
                post("/admin/users/" + ids[loser] + "/unlock", admins[winner].accessToken(), null);
                admins[loser] = session(admins[loser].user().get("username").asString(), OWN_PASSWORD);
            }
        } finally {
            jdbc.update("update app_user set status = 'ACTIVE', locked_at = null, locked_by = null where id = ?::uuid", adminId);
            jdbc.update("update app_user set status = 'LOCKED', locked_at = now() where id in (?::uuid, ?::uuid)", xId, yId);
        }
        assertThat(get("/me", login("admin")).status()).isEqualTo(200);
    }

    private long activeAdmins() {
        return jdbc.queryForObject("""
                select count(*) from app_user u where u.status = 'ACTIVE'
                  and exists (select 1 from user_role r where r.user_id = u.id and r.role_code = 'ADMIN')
                """, Long.class);
    }

    /** Admins created by other tests are locked, so that the demo admin is the only active one. */
    private void lockOtherActiveAdmins(String admin, String adminId) {
        get("/admin/users?role=ADMIN&status=ACTIVE&size=100", admin).body().get("content").forEach(u -> {
            if (!u.get("id").asString().equals(adminId)) {
                assertThat(post("/admin/users/" + u.get("id").asString() + "/lock", admin, null).status()).isEqualTo(200);
            }
        });
        assertThat(activeAdmins()).isEqualTo(1);
    }

    private static void awaitLatch(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }
}
