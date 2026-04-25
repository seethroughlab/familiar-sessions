from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file_encoding="utf-8", extra="ignore")

    # Static TURN server (optional). Used when Cloudflare isn't configured.
    turn_server_url: str | None = None
    turn_server_username: str | None = None
    turn_server_credential: str | None = None

    # Cloudflare Realtime TURN (recommended). The relay mints short-lived credentials
    # via Cloudflare's API on each session create/join. Free tier covers 1 TB/month.
    cloudflare_turn_token_id: str | None = None
    cloudflare_turn_api_token: str | None = None

    # Where the guest SPA's static build lives, relative to repo root.
    # Production: dist baked into the Docker image. Dev: built by `pnpm -C guest build`.
    guest_dist_path: str = "guest/dist"

    log_level: str = "INFO"


settings = Settings()
