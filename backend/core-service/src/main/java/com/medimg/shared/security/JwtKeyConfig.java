package com.medimg.shared.security;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.util.StringUtils;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;

/** RS256 key material for signing (identity) and verifying (resource server) access tokens. */
@Configuration(proxyBeanMethods = false)
class JwtKeyConfig {

    private static final Logger log = LoggerFactory.getLogger(JwtKeyConfig.class);

    record RsaKeys(RSAPublicKey publicKey, RSAPrivateKey privateKey) {
    }

    @Bean
    RsaKeys rsaKeys(JwtProperties props) throws GeneralSecurityException, IOException {
        if (StringUtils.hasText(props.privateKeyLocation()) && StringUtils.hasText(props.publicKeyLocation())) {
            KeyFactory kf = KeyFactory.getInstance("RSA");
            var pub = (RSAPublicKey) kf.generatePublic(new X509EncodedKeySpec(pem(props.publicKeyLocation())));
            var priv = (RSAPrivateKey) kf.generatePrivate(new PKCS8EncodedKeySpec(pem(props.privateKeyLocation())));
            return new RsaKeys(pub, priv);
        }
        log.warn("No JWT key pair configured – generating an ephemeral RSA key (tokens are invalidated on restart)");
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        KeyPair kp = gen.generateKeyPair();
        return new RsaKeys((RSAPublicKey) kp.getPublic(), (RSAPrivateKey) kp.getPrivate());
    }

    private static byte[] pem(String location) throws IOException {
        String text = Files.readString(Path.of(location.replaceFirst("^file:", "")))
                .replaceAll("-----(BEGIN|END) [A-Z ]+-----", "")
                .replaceAll("\\s", "");
        return Base64.getDecoder().decode(text);
    }

    @Bean
    JwtEncoder jwtEncoder(RsaKeys keys) {
        RSAKey jwk = new RSAKey.Builder(keys.publicKey()).privateKey(keys.privateKey()).keyID("medimg-1").build();
        return new NimbusJwtEncoder(new ImmutableJWKSet<>(new JWKSet(jwk)));
    }

    @Bean
    JwtDecoder jwtDecoder(RsaKeys keys, JwtProperties props) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withPublicKey(keys.publicKey()).build();
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(props.issuer()));
        return decoder;
    }
}
