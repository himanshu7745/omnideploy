package com.example.smoke;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class SmokeApplication {
  public static void main(String[] args) {
    SpringApplication.run(SmokeApplication.class, args);
  }

  @GetMapping("/")
  String root() {
    return "omnideploy smoke: spring-boot";
  }
}
