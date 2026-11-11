package com.maestro.fuelorder;

import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;

import java.util.List;

@Configuration
public class WebConfig {

    /**
     * Dev-only CORS for the Vite portal (any localhost port). Registered ahead of the auth
     * filter so 401 responses also carry CORS headers; in production the gateway owns this.
     */
    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilter(
            @org.springframework.beans.factory.annotation.Value("${maestro.cors.allowed-origins:}") List<String> extraOrigins) {
        CorsConfiguration config = new CorsConfiguration();
        List<String> origins = new java.util.ArrayList<>(List.of("http://localhost:*", "http://127.0.0.1:*"));
        extraOrigins.stream().map(String::trim).filter(o -> !o.isEmpty()).forEach(origins::add);
        config.setAllowedOriginPatterns(origins);
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);

        FilterRegistrationBean<CorsFilter> registration = new FilterRegistrationBean<>(new CorsFilter(source));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return registration;
    }
}
