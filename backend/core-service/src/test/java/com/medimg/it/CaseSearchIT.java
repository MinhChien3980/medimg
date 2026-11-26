package com.medimg.it;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.medimg.patient.infrastructure.PatientRepository;
import com.medimg.support.IntegrationTest;

import tools.jackson.databind.JsonNode;

class CaseSearchIT extends IntegrationTest {

    @Test
    void searchMatchesCodeOrNoteIgnoringCaseTakesWildcardsLiterallyAndSkipsDeletedCases() {
        String doctor = login("doctor");
        String tag = "srch" + UUID.randomUUID().toString().substring(0, 6);
        String a = create(doctor, tag + "_A", "lung NODULE " + tag + "zz");
        String b = create(doctor, tag + "xB", "liver");
        String c = create(doctor, tag + "-C", null);
        assertThat(call("DELETE", "/patients/" + id(doctor, c), login("admin"), null, Map.of()).status()).isEqualTo(204);

        // code, any case, newest first; the deleted case is left out
        assertThat(codes("/patients?q=" + tag, doctor)).containsExactly(b, a);
        // "_" is a literal underscore, not "any character"
        assertThat(codes("/patients?q=" + tag + "_", doctor)).containsExactly(a);
        // note, any case
        assertThat(codes("/patients?q=" + tag.toUpperCase() + "ZZ", doctor)).containsExactly(a);
        assertThat(codes("/patients?q=" + tag + "nothing", doctor)).isEmpty();

        // without text: every live case, newest first
        List<String> all = codes("/patients?size=100", doctor);
        assertThat(all).startsWith(b).doesNotContain(c);
    }

    /**
     * The search conditions must be the very expressions of the trigram indexes, or the planner cannot use them. On
     * the few rows of a test database it rightly prefers another index, so that one is dropped (and restored by the
     * rollback) and sequential scans are off: what remains is the trigram indexes, if they match.
     */
    @Test
    void searchCanUseTheTrigramIndexes() throws SQLException {
        try (Connection c = superuserConnection()) {
            c.setAutoCommit(false);
            try (Statement st = c.createStatement()) {
                st.execute("SET LOCAL search_path = medimg");
                st.execute("DROP INDEX idx_patient_created");
                st.execute("SET LOCAL enable_seqscan = off");
            }
            StringBuilder plan = new StringBuilder();
            String sql = "EXPLAIN SELECT p.* " + PatientRepository.SEARCH.replace(":pattern", "?");
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                ps.setString(1, "%abc%");
                ps.setString(2, "%abc%");
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        plan.append(rs.getString(1)).append(System.lineSeparator());
                    }
                }
            } finally {
                c.rollback();
            }
            assertThat(plan.toString()).contains("idx_patient_code_trgm", "idx_patient_note_trgm")
                    .doesNotContain("Seq Scan");
        }
    }

    private String create(String token, String code, String note) {
        Map<String, Object> body = new HashMap<>();
        body.put("code", code);
        if (note != null) {
            body.put("note", note);
        }
        Response created = post("/patients", token, body);
        assertThat(created.status()).isEqualTo(201);
        return created.body().get("code").asString(); // codes are stored upper-case
    }

    private String id(String token, String code) {
        return get("/patients?q=" + code, token).body().get("content").get(0).get("id").asString();
    }

    private List<String> codes(String path, String token) {
        Response r = get(path, token);
        assertThat(r.status()).isEqualTo(200);
        List<String> out = new ArrayList<>();
        for (JsonNode p : r.body().get("content")) {
            out.add(p.get("code").asString());
        }
        return out;
    }
}
