package com.medimg.identity.application;

import java.time.Clock;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.identity.domain.AppUser;
import com.medimg.identity.domain.Role;
import com.medimg.identity.infrastructure.AppUserRepository;

/** Creates the role-based demo accounts shown on the login screen (idempotent). */
@Component
class DemoUserSeeder implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DemoUserSeeder.class);

    private final AppUserRepository users;
    private final PasswordEncoder encoder;
    private final DemoProperties props;
    private final Clock clock;

    DemoUserSeeder(AppUserRepository users, PasswordEncoder encoder, DemoProperties props, Clock clock) {
        this.users = users;
        this.encoder = encoder;
        this.props = props;
        this.clock = clock;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        if (!props.seedUsers()) {
            return;
        }
        seed("admin", "Demo Admin", Set.of(Role.ADMIN));
        seed("doctor", "Demo Doctor", Set.of(Role.DOCTOR));
        seed("tech", "Demo Technician", Set.of(Role.TECHNICIAN));
        seed("researcher", "Demo Researcher", Set.of(Role.RESEARCHER));
    }

    private void seed(String username, String fullName, Set<Role> roles) {
        if (!users.existsByUsernameIgnoreCase(username)) {
            users.save(new AppUser(username, encoder.encode(props.password()), fullName, null, roles, clock.instant()));
            log.info("Seeded demo user '{}' {}", username, roles);
        }
    }
}
