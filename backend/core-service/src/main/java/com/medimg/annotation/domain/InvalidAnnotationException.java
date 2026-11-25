package com.medimg.annotation.domain;

/** The shape or the measurement of an annotation does not fit its kind or the image it is drawn on. */
public class InvalidAnnotationException extends RuntimeException {

    public InvalidAnnotationException(String message) {
        super(message);
    }
}
