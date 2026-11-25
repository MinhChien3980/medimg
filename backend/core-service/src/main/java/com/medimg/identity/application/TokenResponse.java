package com.medimg.identity.application;

public record TokenResponse(String accessToken, String refreshToken, long expiresIn, UserDto user) {
}
