package com.medimg.identity.domain;

/** A LOCKED user can neither log in, refresh a session nor use an access token issued before the lock. */
public enum UserStatus {
    ACTIVE, LOCKED
}
