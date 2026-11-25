package com.medimg.shared.storage;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.time.Duration;
import java.util.List;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CompletedPart;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.model.UploadPartRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest;
import software.amazon.awssdk.services.s3.presigner.model.UploadPartPresignRequest;

/**
 * S3 adapter. Two endpoints: {@code endpoint} for server-side calls, {@code publicEndpoint} for presigned URLs
 * handed to the browser (SigV4 signs the Host header, so URLs must be signed for the host the browser uses).
 */
@Component
class S3ObjectStorageAdapter implements ObjectStoragePort {

    private static final Logger log = LoggerFactory.getLogger(S3ObjectStorageAdapter.class);

    private static final Set<String> BUCKET_EXISTS_CODES = Set.of("BucketAlreadyOwnedByYou", "BucketAlreadyExists");
    private static final int BUCKET_ATTEMPTS = 10;
    private static final Duration BUCKET_RETRY_DELAY = Duration.ofSeconds(2);

    private final StorageProperties props;
    private final S3Client client;
    private final S3Presigner presigner;
    private final int bucketAttempts;
    private final Duration bucketRetryDelay;

    @Autowired
    S3ObjectStorageAdapter(StorageProperties props) {
        this(props, BUCKET_ATTEMPTS, BUCKET_RETRY_DELAY);
    }

    S3ObjectStorageAdapter(StorageProperties props, int bucketAttempts, Duration bucketRetryDelay) {
        this.props = props;
        this.bucketAttempts = bucketAttempts;
        this.bucketRetryDelay = bucketRetryDelay;
        var credentials = StaticCredentialsProvider.create(AwsBasicCredentials.create(props.accessKey(), props.secretKey()));
        var pathStyle = S3Configuration.builder().pathStyleAccessEnabled(true).build();
        this.client = S3Client.builder()
                .endpointOverride(props.endpoint())
                .region(Region.of(props.region()))
                .credentialsProvider(credentials)
                .serviceConfiguration(pathStyle)
                .httpClientBuilder(UrlConnectionHttpClient.builder())
                .build();
        this.presigner = S3Presigner.builder()
                .endpointOverride(props.publicEndpoint())
                .region(Region.of(props.region()))
                .credentialsProvider(credentials)
                .serviceConfiguration(pathStyle)
                .build();
    }

    /** Creates the bucket if needed. Startup fails if the object storage stays unreachable. */
    @EventListener(ApplicationReadyEvent.class)
    void ensureBucket() {
        for (int attempt = 1; attempt <= bucketAttempts; attempt++) {
            try {
                createBucketIfMissing();
                return;
            } catch (SdkException e) {
                log.warn("Object storage not ready (attempt {}/{}): {}", attempt, bucketAttempts, e.getMessage());
                if (attempt < bucketAttempts) {
                    sleep(bucketRetryDelay);
                }
            }
        }
        throw new IllegalStateException("Bucket " + props.bucket() + " is not available after " + bucketAttempts + " attempts");
    }

    private void createBucketIfMissing() {
        try {
            client.headBucket(b -> b.bucket(props.bucket()));
            return;
        } catch (S3Exception e) {
            if (e.statusCode() != 404) {
                throw e;
            }
        }
        try {
            client.createBucket(b -> b.bucket(props.bucket()));
            log.info("Created bucket {}", props.bucket());
        } catch (S3Exception e) {
            // created concurrently by another instance
            if (e.awsErrorDetails() == null || !BUCKET_EXISTS_CODES.contains(e.awsErrorDetails().errorCode())) {
                throw e;
            }
        }
    }

    @Override
    public PresignedUrl presignPut(String key, String contentType, long contentLength) {
        var put = PutObjectRequest.builder().bucket(props.bucket()).key(key)
                .contentType(contentType).contentLength(contentLength).build();
        var presigned = presigner.presignPutObject(PutObjectPresignRequest.builder()
                .signatureDuration(props.presignTtl()).putObjectRequest(put).build());
        return new PresignedUrl(toUri(presigned.url()), presigned.expiration());
    }

    @Override
    public String createMultipartUpload(String key, String contentType) {
        return client.createMultipartUpload(b -> b.bucket(props.bucket()).key(key).contentType(contentType)).uploadId();
    }

    /** The content length is signed, so each part must have exactly its expected size. */
    @Override
    public PresignedUrl presignUploadPart(String key, String uploadId, int partNumber, long contentLength,
                                          Duration validity) {
        var part = UploadPartRequest.builder().bucket(props.bucket()).key(key).uploadId(uploadId)
                .partNumber(partNumber).contentLength(contentLength).build();
        var presigned = presigner.presignUploadPart(UploadPartPresignRequest.builder()
                .signatureDuration(validity).uploadPartRequest(part).build());
        return new PresignedUrl(toUri(presigned.url()), presigned.expiration());
    }

    /** A 4xx answer means the parts or the upload id are wrong; anything else (5xx, network) is left to the caller. */
    @Override
    public void completeMultipartUpload(String key, String uploadId, List<UploadedPart> parts) {
        List<CompletedPart> completed = parts.stream()
                .map(p -> CompletedPart.builder().partNumber(p.partNumber()).eTag(p.etag()).build())
                .toList();
        try {
            client.completeMultipartUpload(b -> b.bucket(props.bucket()).key(key).uploadId(uploadId)
                    .multipartUpload(m -> m.parts(completed)));
        } catch (S3Exception e) {
            if (e.statusCode() >= 400 && e.statusCode() < 500) {
                throw new MultipartUploadRejectedException(key, e.awsErrorDetails() == null
                        ? "HTTP " + e.statusCode() : e.awsErrorDetails().errorCode());
            }
            throw e;
        }
    }

    @Override
    public void abortMultipartUpload(String key, String uploadId) {
        client.abortMultipartUpload(b -> b.bucket(props.bucket()).key(key).uploadId(uploadId));
    }

    @Override
    public PresignedUrl presignGet(String key) {
        var get = GetObjectRequest.builder().bucket(props.bucket()).key(key).build();
        var presigned = presigner.presignGetObject(GetObjectPresignRequest.builder()
                .signatureDuration(props.presignTtl()).getObjectRequest(get).build());
        return new PresignedUrl(toUri(presigned.url()), presigned.expiration());
    }

    @Override
    public byte[] get(String key) {
        try {
            return client.getObjectAsBytes(b -> b.bucket(props.bucket()).key(key)).asByteArray();
        } catch (NoSuchKeyException e) {
            throw new ObjectNotFoundException(key);
        }
    }

    @Override
    public byte[] getFirstBytes(String key, int maxBytes) {
        try (var in = client.getObject(b -> b.bucket(props.bucket()).key(key).range("bytes=0-" + (maxBytes - 1)))) {
            return in.readNBytes(maxBytes); // bounded even if the server ignores the range
        } catch (NoSuchKeyException e) {
            throw new ObjectNotFoundException(key);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public void put(String key, byte[] content, String contentType) {
        client.putObject(b -> b.bucket(props.bucket()).key(key).contentType(contentType), RequestBody.fromBytes(content));
    }

    @Override
    public long size(String key) {
        try {
            return client.headObject(b -> b.bucket(props.bucket()).key(key)).contentLength();
        } catch (NoSuchKeyException e) {
            throw new ObjectNotFoundException(key);
        } catch (S3Exception e) {
            if (e.statusCode() == 404) {
                throw new ObjectNotFoundException(key);
            }
            throw e;
        }
    }

    @Override
    public void copy(String sourceKey, String targetKey) {
        try {
            client.copyObject(b -> b.sourceBucket(props.bucket()).sourceKey(sourceKey)
                    .destinationBucket(props.bucket()).destinationKey(targetKey));
        } catch (NoSuchKeyException e) {
            throw new ObjectNotFoundException(sourceKey);
        }
    }

    @Override
    public void delete(String key) {
        client.deleteObject(b -> b.bucket(props.bucket()).key(key));
    }

    @Override
    public String uri(String key) {
        return "s3://" + props.bucket() + "/" + key;
    }

    @Override
    public String keyOf(String uri) {
        String prefix = "s3://" + props.bucket() + "/";
        if (uri == null || !uri.startsWith(prefix)) {
            throw new IllegalArgumentException("Not an object of bucket " + props.bucket() + ": " + uri);
        }
        return uri.substring(prefix.length());
    }

    private static URI toUri(URL url) {
        try {
            return url.toURI();
        } catch (URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void sleep(Duration d) {
        try {
            Thread.sleep(d);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
