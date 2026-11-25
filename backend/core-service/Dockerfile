# Multi-arch (amd64 / arm64) image for core-service.
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY gradlew settings.gradle.kts build.gradle.kts ./
COPY gradle gradle
RUN chmod +x gradlew && ./gradlew --no-daemon dependencies > /dev/null
COPY src src
RUN ./gradlew --no-daemon bootJar -x test && java -Djarmode=tools -jar build/libs/*.jar extract --layers --launcher --destination /app

FROM eclipse-temurin:21-jre
RUN groupadd --system app && useradd --system --gid app --home /app app
WORKDIR /app
COPY --from=build /app/dependencies/ ./
COPY --from=build /app/spring-boot-loader/ ./
COPY --from=build /app/snapshot-dependencies/ ./
COPY --from=build /app/application/ ./
USER app
EXPOSE 8080
# curl ships with the eclipse-temurin (Ubuntu) runtime image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-8080}/actuator/health/readiness" || exit 1
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
