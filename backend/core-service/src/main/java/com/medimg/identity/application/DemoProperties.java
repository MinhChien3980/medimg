package com.medimg.identity.application;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Demo accounts shown on the login screen; disable with {@code DEMO_SEED_USERS=false}. */
@ConfigurationProperties("app.demo")
public record DemoProperties(boolean seedUsers, String password) {
}
