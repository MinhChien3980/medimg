package com.medimg.support;

import static org.awaitility.Awaitility.await;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;

import javax.imageio.ImageIO;

import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.web.client.RestClient;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.MountableFile;

import com.medimg.shared.messaging.StreamPublisher;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Full-stack integration test base: real PostgreSQL (with the same role script as docker-compose), Redis and
 * SeaweedFS S3. Containers are started once per JVM and shared by all integration tests.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public abstract class IntegrationTest {

    private static final Path DEPLOY = Path.of("..", "..", "deploy").toAbsolutePath().normalize();

    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine")
            .withCopyFileToContainer(MountableFile.forHostPath(DEPLOY.resolve("postgres/init/01-roles.sh"), 0755),
                    "/docker-entrypoint-initdb.d/01-roles.sh");

    @SuppressWarnings("resource")
    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    @SuppressWarnings("resource")
    static final GenericContainer<?> S3 = new GenericContainer<>("chrislusf/seaweedfs:4.54")
            .withCommand("server", "-dir=/data", "-s3", "-s3.port=8333", "-s3.config=/etc/seaweedfs/s3.json", "-volume.max=0")
            .withCopyFileToContainer(MountableFile.forHostPath(DEPLOY.resolve("seaweedfs/s3.json")), "/etc/seaweedfs/s3.json")
            .withExposedPorts(8333)
            .waitingFor(Wait.forListeningPort().withStartupTimeout(Duration.ofMinutes(2)));

    static {
        POSTGRES.start();
        REDIS.start();
        S3.start();
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "medimg_app");
        r.add("spring.datasource.password", () -> "medimg_app");
        r.add("spring.flyway.user", () -> "medimg_owner");
        r.add("spring.flyway.password", () -> "medimg_owner");
        r.add("spring.data.redis.host", REDIS::getHost);
        r.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
        String s3 = "http://" + S3.getHost() + ":" + S3.getMappedPort(8333);
        r.add("app.storage.endpoint", () -> s3);
        r.add("app.storage.public-endpoint", () -> s3);
        r.add("app.ai.retry-backoff", () -> "1s,1s");
        r.add("app.imaging.volume.retry-backoff", () -> "1s,1s");
        // small enough for a test file to go in parts; S3 parts other than the last are at least 5 MiB
        r.add("app.imaging.multipart.threshold", () -> "6MB");
        r.add("app.imaging.multipart.part-size", () -> "5MB");
        r.add("app.outbox.poll-interval", () -> "200ms");
        r.add("app.outbox.publish-backoff", () -> "200ms");
        r.add("app.outbox.max-publish-backoff", () -> "1s");
    }

    @LocalServerPort
    protected int port;

    @Autowired
    protected ObjectMapper json;

    @Autowired
    protected StringRedisTemplate redis;

    /** The real Redis publisher of the outbox relay; a test can make publishing fail. Stubbing is reset after each test. */
    @MockitoSpyBean
    protected StreamPublisher streams;

    protected RestClient http;

    protected final HttpClient raw = HttpClient.newHttpClient();

    @BeforeEach
    void setUpClient() {
        http = RestClient.builder()
                .baseUrl("http://localhost:" + port + "/api/v1")
                .defaultStatusHandler(HttpStatusCode::isError, (req, res) -> { }) // tests assert on status
                .build();
    }

    protected record Response(int status, JsonNode body) {
    }

    protected Response call(String method, String path, String token, Object body, Map<String, String> headers) {
        var spec = http.method(HttpMethod.valueOf(method)).uri(path);
        if (token != null) {
            spec = spec.header("Authorization", "Bearer " + token);
        }
        for (var h : headers.entrySet()) {
            spec = spec.header(h.getKey(), h.getValue());
        }
        if (body != null) {
            spec = spec.contentType(MediaType.APPLICATION_JSON).body(json.writeValueAsString(body));
        }
        return spec.exchange((req, res) -> {
            byte[] bytes = res.getBody().readAllBytes();
            return new Response(res.getStatusCode().value(), bytes.length == 0 ? null : json.readTree(bytes));
        });
    }

    protected Response get(String path, String token) {
        return call("GET", path, token, null, Map.of());
    }

    protected Response post(String path, String token, Object body) {
        return call("POST", path, token, body, Map.of());
    }

    protected String login(String username) {
        Response r = post("/auth/login", null, Map.of("username", username, "password", "Demo@12345"));
        if (r.status() != 200) {
            throw new IllegalStateException("login failed: " + r);
        }
        return r.body().get("accessToken").asString();
    }

    /** Password the helpers below give the accounts they create, once the temporary one is changed. */
    protected static final String OWN_PASSWORD = "Own-password-2026";

    /** A tokens pair and the user, as returned by login. */
    protected record Session(String accessToken, String refreshToken, JsonNode user) {
    }

    protected Session session(String username, String password) {
        Response r = post("/auth/login", null, Map.of("username", username, "password", password));
        if (r.status() != 200) {
            throw new IllegalStateException("login failed: " + r);
        }
        return new Session(r.body().get("accessToken").asString(), r.body().get("refreshToken").asString(),
                r.body().get("user"));
    }

    /** A username no other test uses. */
    protected static String uniqueUsername(String prefix) {
        return prefix + "-" + java.util.UUID.randomUUID().toString().substring(0, 8);
    }

    /** Creates an account as the demo admin; returns the response body {user, temporaryPassword}. */
    protected JsonNode createUser(String username, String... roles) {
        Response r = post("/admin/users", login("admin"),
                Map.of("username", username, "fullName", "Test " + username, "roles", List.of(roles)));
        if (r.status() != 201) {
            throw new IllegalStateException("create user failed: " + r);
        }
        return r.body();
    }

    /** Creates an account and sets its own password ({@link #OWN_PASSWORD}); returns a session of it. */
    protected Session createActiveUser(String username, String... roles) {
        String temporary = createUser(username, roles).get("temporaryPassword").asString();
        Session first = session(username, temporary);
        Response changed = post("/me/password", first.accessToken(),
                Map.of("currentPassword", temporary, "newPassword", OWN_PASSWORD));
        if (changed.status() != 204) {
            throw new IllegalStateException("password change failed: " + changed);
        }
        return session(username, OWN_PASSWORD);
    }

    /** A connection to the test database as its superuser, for checks the application role may not run. */
    protected static Connection superuserConnection() throws SQLException {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    protected String createCase(String token) {
        return post("/patients", token, Map.of()).body().get("id").asString();
    }

    /** Uploads a generated PNG for the case and waits until it is processed; returns {studyId, seriesId}. */
    protected String[] uploadStudy(String token, String patientId) throws IOException, InterruptedException {
        byte[] png = png(300, 300);
        Response init = post("/uploads/init", token, Map.of("patientId", patientId,
                "files", List.of(Map.of("name", "c.png", "size", png.length, "contentType", "image/png"))));
        String uploadId = init.body().get("uploadId").asString();
        putObject(init.body().get("files").get(0).get("putUrl").asString(), png);
        post("/uploads/" + uploadId + "/complete", token, null);
        await().atMost(Duration.ofSeconds(20))
                .until(() -> "DONE".equals(get("/uploads/" + uploadId, token).body().get("status").asString()));
        String studyId = get("/uploads/" + uploadId, token).body().get("studyId").asString();
        return new String[] {studyId, get("/studies/" + studyId, token).body().get("series").get(0).get("id").asString()};
    }

    protected HttpResponse<String> putObject(String presignedUrl, byte[] content) throws IOException, InterruptedException {
        return putObject(presignedUrl, content, "image/png");
    }

    /** The content type must be the one declared at init: it is part of the signature. */
    protected HttpResponse<String> putObject(String presignedUrl, byte[] content, String contentType)
            throws IOException, InterruptedException {
        return raw.send(HttpRequest.newBuilder(URI.create(presignedUrl)).header("Content-Type", contentType)
                .PUT(HttpRequest.BodyPublishers.ofByteArray(content)).build(), HttpResponse.BodyHandlers.ofString());
    }

    /** Inits, uploads and completes a volume file; returns the upload as returned by complete. */
    protected JsonNode startVolumeUpload(String token, String patientId, String name, byte[] content, String contentType)
            throws IOException, InterruptedException {
        Response init = post("/uploads/init", token, Map.of("patientId", patientId,
                "files", List.of(Map.of("name", name, "size", content.length, "contentType", contentType))));
        if (init.status() != 201) {
            throw new IllegalStateException("init failed: " + init);
        }
        putObject(init.body().get("files").get(0).get("putUrl").asString(), content, contentType);
        return post("/uploads/" + init.body().get("uploadId").asString() + "/complete", token, null).body();
    }

    /**
     * Uploads a NIfTI volume and plays the ingest worker until the upload is DONE; returns {studyId, seriesId}. The
     * worker would write the volume to the output prefix; presigned URLs do not need the objects to exist.
     */
    protected String[] uploadVolumeStudy(String token, String patientId) throws IOException, InterruptedException {
        String uploadId = startVolumeUpload(token, patientId, "ct.nii.gz", TestFiles.gzip(TestFiles.nifti1()),
                "application/gzip").get("uploadId").asString();
        String prefix = awaitIngestMessage(uploadId, 1).get("outputPrefix");
        ingestResult(uploadId, 1, "DONE", Map.of("payload", volumePayload(prefix, "NIFTI")));
        await().atMost(Duration.ofSeconds(10))
                .until(() -> "DONE".equals(get("/uploads/" + uploadId, token).body().get("status").asString()));
        String studyId = get("/uploads/" + uploadId, token).body().get("studyId").asString();
        return new String[] {studyId, get("/studies/" + studyId, token).body().get("series").get(0).get("id").asString()};
    }

    /**
     * Uploads a DICOM X-ray and plays the ingest worker until the upload is DONE: a 2048 x 2500 px image with a pixel
     * spacing of {@code pixelSpacingMm} in x and y. Returns {studyId, seriesId}.
     */
    protected String[] uploadDicomXray(String token, String patientId, double pixelSpacingMm)
            throws IOException, InterruptedException {
        String uploadId = startVolumeUpload(token, patientId, "cxr.dcm", TestFiles.dicom(), "application/dicom")
                .get("uploadId").asString();
        String prefix = awaitIngestMessage(uploadId, 1).get("outputPrefix");
        ingestResult(uploadId, 1, "DONE", Map.of("payload", """
                {"inputType":"DICOM_2D","imageUri":"%1$simage.png","thumbnailUri":"%1$sthumb.png","modality":"DX",
                 "dims":[2048,2500,1],"spacing":[%2$s,%2$s,null]}
                """.formatted(prefix, pixelSpacingMm)));
        await().atMost(Duration.ofSeconds(10))
                .until(() -> "DONE".equals(get("/uploads/" + uploadId, token).body().get("status").asString()));
        String studyId = get("/uploads/" + uploadId, token).body().get("studyId").asString();
        return new String[] {studyId, get("/studies/" + studyId, token).body().get("series").get(0).get("id").asString()};
    }

    /**
     * Runs a prediction of {@code modelCode} on the series and plays the worker until it is DONE with the given
     * findings (a JSON array of the worker payload); returns the job id.
     */
    protected String completedPrediction(String token, String[] study, String modelCode, String findingsJson) {
        String jobId = post("/predictions", token, Map.of("studyId", study[0], "seriesId", study[1], "modelCode", modelCode))
                .body().get("jobId").asString();
        workerResult(jobId, 1, "DONE", Map.of("payload", "{\"inferenceMs\":100,\"findings\":" + findingsJson + "}"));
        await().atMost(Duration.ofSeconds(10))
                .until(() -> "DONE".equals(get("/predictions/" + jobId, token).body().get("status").asString()));
        return jobId;
    }

    /** DONE payload of the ingest worker for a volume of {@code inputType} written under {@code outputPrefix}. */
    protected static String volumePayload(String outputPrefix, String inputType) {
        return """
                {"inputType":"%2$s","volumeUri":"%1$svolume.nii.gz","thumbnailUri":"%1$sthumb.png","modality":"CT",
                 "dims":[512,512,301],"spacing":[0.78,0.78,1.5],"spacingAssumed":false,"numSlices":301,
                 "huRange":[-1024,3071],"sourceSeries":{"slices":301,"seriesCount":2}}
                """.formatted(outputPrefix, inputType);
    }

    /** Simulates the ingest worker writing to {@code imaging.results}. */
    protected void ingestResult(String uploadId, Object attempt, String type, Map<String, String> extra) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("uploadId", uploadId);
        fields.put("attempt", attempt.toString());
        fields.put("workerId", "it-ingest");
        fields.put("type", type);
        fields.putAll(extra);
        redis.opsForStream().add("imaging.results", fields);
    }

    /** All messages published for the upload to {@code imaging.jobs}. */
    protected List<Map<String, String>> ingestMessages(String uploadId) {
        return redis.<String, String>opsForStream().range("imaging.jobs", Range.unbounded()).stream()
                .map(MapRecord::getValue)
                .filter(fields -> uploadId.equals(fields.get("uploadId")))
                .toList();
    }

    /** Waits until the outbox relay has published the given ingest attempt of the upload and returns that message. */
    protected Map<String, String> awaitIngestMessage(String uploadId, int attempt) {
        String expected = Integer.toString(attempt);
        return await().atMost(Duration.ofSeconds(10)).until(
                () -> ingestMessages(uploadId).stream().filter(m -> expected.equals(m.get("attempt"))).findFirst(),
                Optional::isPresent).orElseThrow();
    }

    /** Simulates the ai-worker writing to {@code ai.results}. */
    protected void workerResult(String jobId, Object attempt, String type, Map<String, String> extra) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("jobId", jobId);
        fields.put("attempt", attempt.toString());
        fields.put("workerId", "it-worker");
        fields.put("type", type);
        fields.putAll(extra);
        redis.opsForStream().add("ai.results", fields);
    }

    /** All messages published for the job, from both job streams. */
    protected List<Map<String, String>> jobMessages(String jobId) {
        return Stream.of("ai.jobs.gpu", "ai.jobs.cpu")
                .flatMap(stream -> redis.<String, String>opsForStream().range(stream, Range.unbounded()).stream())
                .map(MapRecord::getValue)
                .filter(fields -> jobId.equals(fields.get("jobId")))
                .toList();
    }

    /** Waits until the outbox relay has published the given attempt of the job and returns that message. */
    protected Map<String, String> awaitJobMessage(String jobId, int attempt) {
        String expected = Integer.toString(attempt);
        return await().atMost(Duration.ofSeconds(10)).until(
                () -> jobMessages(jobId).stream().filter(m -> expected.equals(m.get("attempt"))).findFirst(),
                Optional::isPresent).orElseThrow();
    }

    protected static byte[] png(int w, int h) throws IOException {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_BYTE_GRAY);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                img.getRaster().setSample(x, y, 0, (x + y) % 256);
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(img, "png", out);
        return out.toByteArray();
    }
}
