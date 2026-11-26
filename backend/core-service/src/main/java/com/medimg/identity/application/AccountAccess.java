package com.medimg.identity.application;

/** What the holder of a valid access token may do, according to the current state of the account. */
public enum AccountAccess {
    /** Everything the roles of the token allow. */
    FULL,
    /** Only their profile and changing their password: an admin gave them a temporary password. */
    PASSWORD_CHANGE_ONLY,
    /** Nothing: the account was locked (or no longer exists) after the token was issued. */
    NONE
}
