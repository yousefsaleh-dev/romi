#pragma once

// Copy to romi_secrets.h or use romi.ps1 configure. The owner requested repository storage.
static constexpr char ROMI_WIFI_SSID[] = "REPLACE_WITH_WIFI_NAME";
static constexpr char ROMI_WIFI_PASSWORD[] = "REPLACE_WITH_WIFI_PASSWORD";
static constexpr char ROMI_API_BASE_URL[] = "https://YOUR_DEPLOYED_HOST";
static constexpr char ROMI_DEVICE_TOKEN[] = "REPLACE_WITH_ROMI_DEVICE_TOKEN";

// Paste the trusted root CA PEM that validates the deployed ROMI app host.
// Gemini uses its separate public Google root bundle; no server API key belongs here.
static constexpr char ROMI_ROOT_CA_BUNDLE[] = R"PEM(
REPLACE_WITH_TRUSTED_ROOT_CA_PEM_BUNDLE
)PEM";
