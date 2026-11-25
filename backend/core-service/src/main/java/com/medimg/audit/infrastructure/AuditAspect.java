package com.medimg.audit.infrastructure;

import java.lang.reflect.Method;
import java.util.Map;
import java.util.UUID;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;

import com.medimg.shared.audit.AuditEvent.Outcome;
import com.medimg.shared.audit.AuditEvents;
import com.medimg.shared.audit.Audited;

/** Writes an audit record for every {@link Audited} method, on success and on failure. */
@Aspect
@Component
class AuditAspect {

    private static final String[] ID_ACCESSORS = {"id", "jobId", "uploadId"};

    private final ApplicationEventPublisher events;

    AuditAspect(ApplicationEventPublisher events) {
        this.events = events;
    }

    @Around("@annotation(audited)")
    Object audit(ProceedingJoinPoint pjp, Audited audited) throws Throwable {
        Object resourceId = firstUuid(pjp.getArgs());
        try {
            Object result = pjp.proceed();
            if (resourceId == null) {
                resourceId = idOf(result);
            }
            events.publishEvent(AuditEvents.current(audited.action(), audited.resource(), resourceId, Outcome.SUCCESS, Map.of()));
            return result;
        } catch (Throwable t) {
            events.publishEvent(AuditEvents.current(audited.action(), audited.resource(), resourceId, Outcome.FAILURE,
                    Map.of("error", t.getClass().getSimpleName())));
            throw t;
        }
    }

    private static Object firstUuid(Object[] args) {
        for (Object a : args) {
            if (a instanceof UUID) {
                return a;
            }
        }
        return null;
    }

    private static Object idOf(Object result) {
        if (result == null) {
            return null;
        }
        for (String name : ID_ACCESSORS) {
            try {
                Method m = result.getClass().getMethod(name);
                return m.invoke(result);
            } catch (ReflectiveOperationException ignored) {
                // try next accessor
            }
        }
        return null;
    }
}
