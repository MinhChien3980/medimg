package com.medimg.shared.web;

import java.net.URI;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/** Domain/application error rendered as an RFC 7807 problem detail. */
public class ApiException extends ErrorResponseException {

    /** Relative base of the problem types this API defines. */
    public static final String PROBLEM_TYPE_BASE = "/problems/";

    private ApiException(HttpStatus status, String title, String detail) {
        super(status, problem(status, title, detail), null);
    }

    private static ProblemDetail problem(HttpStatus status, String title, String detail) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setTitle(title);
        return pd;
    }

    public static ApiException notFound(String resource, Object id) {
        return new ApiException(HttpStatus.NOT_FOUND, "Not found", resource + " " + id + " not found");
    }

    public static ApiException badRequest(String detail) {
        return new ApiException(HttpStatus.BAD_REQUEST, "Bad request", detail);
    }

    public static ApiException conflict(String detail) {
        return new ApiException(HttpStatus.CONFLICT, "Conflict", detail);
    }

    public static ApiException unauthorized(String detail) {
        return new ApiException(HttpStatus.UNAUTHORIZED, "Unauthorized", detail);
    }

    /** The caller's role allows the action in general but not on this resource, e.g. someone else's annotation. */
    public static ApiException forbidden(String detail) {
        return new ApiException(HttpStatus.FORBIDDEN, "Forbidden", detail);
    }

    public static ApiException unprocessable(String detail) {
        return new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "Unprocessable", detail);
    }

    /**
     * Sets the problem {@code type} to {@code /problems/<slug>}, so that clients can tell apart errors of the same
     * status (e.g. which rule a request broke) and show their own wording.
     */
    public ApiException type(String slug) {
        getBody().setType(URI.create(PROBLEM_TYPE_BASE + slug));
        return this;
    }

    /** Adds a property (an RFC 7807 extension member) to the problem detail. */
    public ApiException property(String name, Object value) {
        getBody().setProperty(name, value);
        return this;
    }

    @Override
    public String getMessage() {
        return getBody().getDetail();
    }
}
