#pragma once

// Copy this file to romi_secrets.h and fill in local values. Never commit that copy.
static constexpr char ROMI_WIFI_SSID[] = "REPLACE_WITH_WIFI_NAME";
static constexpr char ROMI_WIFI_PASSWORD[] = "REPLACE_WITH_WIFI_PASSWORD";
static constexpr char ROMI_API_BASE_URL[] = "https://YOUR_DEPLOYED_HOST";
static constexpr char ROMI_DEVICE_TOKEN[] = "REPLACE_WITH_ROMI_DEVICE_TOKEN";

// Paste the trusted root CA PEM that validates the deployed ROMI app host.
// The core firmware does not connect to Gemini.
static constexpr char ROMI_ROOT_CA_BUNDLE[] = R"PEM(
REPLACE_WITH_TRUSTED_ROOT_CA_PEM_BUNDLE
)PEM";
